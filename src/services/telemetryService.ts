import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ResolvedSshTarget } from './sshConnection.js';
import { execSshText, normalizeSshError, shellQuote, SSH_READY_TIMEOUT_MS, withSshClient } from './sshConnection.js';
import { buildRawTemperatureCommand, parseTemperatureReadings, type TemperatureReading } from './temperatureService.js';

const CPU_SAMPLE_INTERVAL_MS = 250;

export interface SystemMetrics {
  online: boolean;
  cpuUsage: number;
  uptimeSeconds: number;
  memory: { total: number; used: number; free: number };
  disk: { mount: string; total: string; used: string; available: string; percentage: number }[];
  temperature: TemperatureMetric | null;
  diskIo: ThroughputMetric;
  network: NetworkMetric;
  processes: ProcessMetric[];
  containers: ContainerMetric[];
  containerError?: string;
  error?: string;
}

export interface TemperatureMetric {
  label: string;
  celsius: number;
}

export interface ThroughputMetric {
  readBytesPerSecond: number;
  writeBytesPerSecond: number;
}

export interface NetworkMetric {
  receiveBytesPerSecond: number;
  transmitBytesPerSecond: number;
}

export interface ProcessMetric {
  pid: number;
  command: string;
  cpu: number;
  memory: number;
}

export interface ContainerMetric {
  id: string;
  name: string;
  image: string;
  status: string;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'unknown';
  ports: string;
  composeProject?: string;
  composeService?: string;
  composeWorkingDir?: string;
  composeConfigFiles?: string[];
}

interface LocalShellCommandOptions {
  rejectOnFailure?: boolean;
  timeoutMessage?: string;
  nonZeroCommandName?: string;
}

const PROCESS_SNAPSHOT_COMMAND = `
core_count="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || printf 1)"
case "$core_count" in
  ''|*[!0-9]*) core_count=1 ;;
esac
[ "$core_count" -gt 0 ] || core_count=1
top_output="$(top -b -n 2 -d 0.2 -w 160 2>/dev/null || top -b -n 2 -d 1 2>/dev/null || true)"
if [ -n "$top_output" ]; then
  printf '%s\\n' "$top_output" | awk -v cores="$core_count" '
    function memory_to_mib(value, number, suffix) {
      number = value + 0
      suffix = tolower(substr(value, length(value), 1))
      if (suffix == "g") return number * 1024
      if (suffix == "m") return number
      if (suffix == "t") return number * 1024 * 1024
      return number / 1024
    }
    /^ *PID[[:space:]]+/ { table += 1; next }
    table == 2 && $1 ~ /^[0-9]+$/ && NF >= 12 {
      command = $12
      for (i = 13; i <= NF; i++) command = command " " $i
      if (command ~ /^(top|sh|bash|sshd|awk|sort|head)$/) next
      printf "%s %.2f %.2f %s\\n", $1, $9 / cores, memory_to_mib($6), command
    }
  ' | sort -k2,2nr -k3,3nr | head -n 15
else
  ps -eo pid,pcpu,rss,comm --sort=-pcpu 2>/dev/null | awk -v cores="$core_count" '
    NR > 1 && $4 !~ /^(ps|sh|bash|sshd|awk|sort|head)$/ {
      printf "%s %.2f %.2f %s\\n", $1, $2 / cores, $3 / 1024, $4
    }
  ' | head -n 15
fi
`.trim();

const DOCKER_SNAPSHOT_COMMAND = `
if command -v docker >/dev/null 2>&1; then
  docker_bin=''
  if docker ps -a >/dev/null 2>&1; then
    docker_bin='docker'
  elif sudo -n docker ps -a >/dev/null 2>&1; then
    docker_bin='sudo -n docker'
  fi

  if [ -n "$docker_bin" ]; then
    $docker_bin ps -a --no-trunc --format '{{.ID}}	{{.Names}}	{{.Image}}	{{.Status}}	{{.Ports}}' 2>/dev/null | while IFS='	' read -r id name image status ports; do
      inspect_ports="$($docker_bin inspect --format '{{range $private, $bindings := .HostConfig.PortBindings}}{{range $bindings}}{{if .HostPort}}{{if .HostIp}}{{.HostIp}}{{else}}0.0.0.0{{end}}:{{.HostPort}}->{{$private}}, {{end}}{{end}}{{end}}' "$id" 2>/dev/null || true)"
      compose_labels="$($docker_bin inspect --format '{{with .Config.Labels}}{{index . "com.docker.compose.project"}}{{end}}	{{with .Config.Labels}}{{index . "com.docker.compose.service"}}{{end}}	{{with .Config.Labels}}{{index . "com.docker.compose.project.working_dir"}}{{end}}	{{with .Config.Labels}}{{index . "com.docker.compose.project.config_files"}}{{end}}' "$id" 2>/dev/null || true)"
      [ -n "$ports" ] || ports="\${inspect_ports%, }"
      printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$id" "$name" "$image" "$status" "$ports" "$compose_labels"
    done
  else
    printf 'HOMEDASHBOARD_DOCKER_ERROR\\tDocker is installed, but this SSH user cannot run docker ps. Add the user to the docker group, log out/in, or configure passwordless sudo for docker.\\n'
  fi
else
  printf 'HOMEDASHBOARD_DOCKER_ERROR\\tDocker CLI was not found on this server.\\n'
fi
`.trim();

const DISK_SNAPSHOT_COMMAND = `
if uname -r 2>/dev/null | grep -qi android; then
  printf 'Filesystem 1K-blocks Used Available Use%% Mounted on\\n'
  disk_mount='/'
  disk_values="$(stat -f -c '%S %b %a' "$disk_mount" 2>/dev/null || true)"
  set -- $disk_values
  block_size="$1"
  blocks="$2"
  available="$3"

  case "$block_size:$blocks:$available" in
    *[!0-9:]*|''|':'|'::') exit 0 ;;
  esac

  total_kb=$((blocks * block_size / 1024))
  available_kb=$((available * block_size / 1024))
  used_kb=$((total_kb - available_kb))

  if [ "$total_kb" -gt 0 ]; then
    percentage=$((used_kb * 100 / total_kb))
  else
    percentage=0
  fi

  printf 'rootfs %s %s %s %s%% %s\\n' "$total_kb" "$used_kb" "$available_kb" "$percentage" "$disk_mount"
else
  df -kP 2>/dev/null || df -k 2>/dev/null || df -P
fi
`.trim();

function buildRawTelemetryCommand(): string {
  return `export LC_ALL=C LANG=C; cat /proc/stat; echo '---DISKSTATS1---'; cat /proc/diskstats 2>/dev/null || true; echo '---NETDEV1---'; cat /proc/net/dev 2>/dev/null || true; sleep 0.25; echo '---CPU2---'; cat /proc/stat; echo '---DISKSTATS2---'; cat /proc/diskstats 2>/dev/null || true; echo '---NETDEV2---'; cat /proc/net/dev 2>/dev/null || true; echo '---MEM---'; cat /proc/meminfo; echo '---UPTIME---'; cat /proc/uptime 2>/dev/null || true; echo '---TEMP---'; ${buildRawTemperatureCommand()}; echo '---DISK---'; ${DISK_SNAPSHOT_COMMAND}; echo '---PROC---'; ${PROCESS_SNAPSHOT_COMMAND}; echo '---CONTAINERS---'; ${DOCKER_SNAPSHOT_COMMAND}`;
}

export function buildTelemetryCommand(): string {
  return `/bin/sh -lc ${shellQuote(buildRawTelemetryCommand())}`;
}

export const EMPTY_METRICS: SystemMetrics = {
  online: false,
  cpuUsage: 0,
  uptimeSeconds: 0,
  memory: { total: 0, used: 0, free: 0 },
  disk: [],
  temperature: null,
  diskIo: { readBytesPerSecond: 0, writeBytesPerSecond: 0 },
  network: { receiveBytesPerSecond: 0, transmitBytesPerSecond: 0 },
  processes: [],
  containers: [],
};

export function buildOfflineMetrics(error: string): SystemMetrics {
  return {
    ...EMPTY_METRICS,
    error,
  };
}

const EXCLUDED_FILESYSTEMS = new Set([
  'tmpfs',
  'devtmpfs',
  'dev',
  'shm',
  'udev',
  'efivarfs',
  'ramfs',
  'sysfs',
  'proc',
  'devpts',
  'cgroup',
  'cgroup2',
  'securityfs',
  'pstore',
  'bpf',
  'tracefs',
  'debugfs',
  'mqueue',
  'hugetlbfs',
  'fusectl',
  'configfs',
]);

export async function collectTelemetry(target: ResolvedSshTarget): Promise<SystemMetrics> {
  try {
    const raw = target.isLocal
      ? await collectLocalRawTelemetry()
      : await collectRemoteRawTelemetry(target.connectConfig);
    return {
      online: true,
      ...parseTelemetry(raw),
    };
  } catch (error) {
    return buildOfflineMetrics(normalizeTelemetryError(error));
  }
}

export function parseTelemetry(raw: string): Omit<SystemMetrics, 'online' | 'error'> {
  const [statSection, afterCpuMarker] = raw.split('---CPU2---');
  const [statEndSection, afterMemMarker = ''] = afterCpuMarker ? afterCpuMarker.split('---MEM---') : ['', raw.split('---MEM---')[1] ?? ''];
  const memSection = readMarkedSection(raw, '---MEM---', ['---UPTIME---', '---TEMP---', '---DISK---']);
  const uptimeOutput = readMarkedSection(raw, '---UPTIME---', ['---TEMP---', '---DISK---']);
  const [, diskSection = ''] = afterMemMarker.split('---DISK---');
  const [diskOutput, processSection = ''] = diskSection.split('---PROC---');
  const [processOutput, containerSection = ''] = processSection.split('---CONTAINERS---');
  const diskStatsStart = readMarkedSection(raw, '---DISKSTATS1---', ['---NETDEV1---', '---CPU2---']);
  const diskStatsEnd = readMarkedSection(raw, '---DISKSTATS2---', ['---NETDEV2---', '---MEM---']);
  const netDevStart = readMarkedSection(raw, '---NETDEV1---', ['---CPU2---']);
  const netDevEnd = readMarkedSection(raw, '---NETDEV2---', ['---MEM---']);
  const temperatureOutput = readMarkedSection(raw, '---TEMP---', ['---DISK---']);

  return {
    cpuUsage: parseCpuUsage(statSection, statEndSection),
    uptimeSeconds: parseUptime(uptimeOutput),
    memory: parseMemory(memSection),
    disk: parseDisk(diskOutput),
    temperature: parseTemperature(temperatureOutput),
    diskIo: parseDiskIo(diskStatsStart, diskStatsEnd),
    network: parseNetwork(netDevStart, netDevEnd),
    processes: parseProcesses(processOutput),
    containers: parseContainers(containerSection),
    containerError: parseContainerError(containerSection),
  };
}

function collectRemoteRawTelemetry(connectConfig: ResolvedSshTarget['connectConfig']): Promise<string> {
  return withSshClient(connectConfig, (client) =>
    execSshText(client, buildTelemetryCommand(), {
      timeoutMs: SSH_READY_TIMEOUT_MS * 2,
      label: 'Telemetry command',
    }),
  );
}

async function collectLocalRawTelemetry(): Promise<string> {
  const [statStart, diskStatsStart, netDevStart, meminfo, uptime, temperature, disk] = await Promise.all([
    fs.readFile('/proc/stat', 'utf8'),
    readOptionalFile('/proc/diskstats'),
    readOptionalFile('/proc/net/dev'),
    fs.readFile('/proc/meminfo', 'utf8'),
    readOptionalFile('/proc/uptime'),
    runLocalTemperatureSnapshot(),
    runLocalDf(),
  ]);
  await delay(CPU_SAMPLE_INTERVAL_MS);
  const [statEnd, diskStatsEnd, netDevEnd] = await Promise.all([
    fs.readFile('/proc/stat', 'utf8'),
    readOptionalFile('/proc/diskstats'),
    readOptionalFile('/proc/net/dev'),
  ]);
  const [processes, containers] = await Promise.all([
    runLocalProcessSnapshot(),
    runLocalContainerSnapshot(),
  ]);

  return `${statStart}\n---DISKSTATS1---\n${diskStatsStart}\n---NETDEV1---\n${netDevStart}\n---CPU2---\n${statEnd}\n---DISKSTATS2---\n${diskStatsEnd}\n---NETDEV2---\n${netDevEnd}\n---MEM---\n${meminfo}\n---UPTIME---\n${uptime}\n---TEMP---\n${temperature}\n---DISK---\n${disk}\n---PROC---\n${processes}\n---CONTAINERS---\n${containers}`;
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function runLocalDf(): Promise<string> {
  return runLocalShellCommand(DISK_SNAPSHOT_COMMAND, {
    rejectOnFailure: true,
    timeoutMessage: 'Local df command timed out.',
    nonZeroCommandName: 'df',
  });
}

function runLocalProcessSnapshot(): Promise<string> {
  return runLocalShellCommand(PROCESS_SNAPSHOT_COMMAND);
}

function runLocalContainerSnapshot(): Promise<string> {
  if (isContainerRuntime()) {
    return Promise.resolve(`HOMEDASHBOARD_DOCKER_ERROR\t${localContainerDockerMessage()}`);
  }

  return runLocalShellCommand(DOCKER_SNAPSHOT_COMMAND);
}

function runLocalTemperatureSnapshot(): Promise<string> {
  return runLocalShellCommand(buildRawTemperatureCommand());
}

function runLocalShellCommand(command: string, options: LocalShellCommandOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-lc', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill('SIGKILL');
      if (options.rejectOnFailure) {
        reject(new Error(options.timeoutMessage ?? 'Local command timed out.'));
      } else {
        resolve('');
      }
    }, SSH_READY_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      if (options.rejectOnFailure) {
        reject(error);
      } else {
        resolve('');
      }
    });
    child.once('close', (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (options.rejectOnFailure && code && code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8') || `${options.nonZeroCommandName ?? 'Command'} exited with code ${code}.`));
        return;
      }

      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

function parseCpuUsage(statStart: string, statEnd = ''): number {
  const start = parseCpuTimes(statStart);
  const end = parseCpuTimes(statEnd);

  if (start && end) {
    const activeDelta = end.active - start.active;
    const totalDelta = end.total - start.total;

    if (totalDelta > 0 && activeDelta >= 0) {
      return clampPercentage((activeDelta / totalDelta) * 100);
    }
  }

  if (!start || start.total <= 0) {
    return 0;
  }

  return clampPercentage((start.active / start.total) * 100);
}

function parseCpuTimes(stat: string): { active: number; total: number } | undefined {
  const cpuLine = stat
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('cpu '));

  if (!cpuLine) {
    return undefined;
  }

  const values = cpuLine
    .split(/\s+/)
    .slice(1)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value));

  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = values;
  const active = user + nice + system + irq + softirq + steal;
  const inactive = idle + iowait;
  const total = active + inactive;

  if (total <= 0) {
    return undefined;
  }

  return { active, total };
}

function parseUptime(uptimeOutput: string): number {
  const [rawUptime = ''] = uptimeOutput.trim().split(/\s+/);
  const uptimeSeconds = Number.parseFloat(rawUptime);

  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
    return 0;
  }

  return Math.round(uptimeSeconds);
}

function parseMemory(meminfo: string): SystemMetrics['memory'] {
  const values = new Map<string, number>();

  for (const line of meminfo.split('\n')) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/i.exec(line.trim());

    if (match) {
      values.set(match[1], Number.parseInt(match[2], 10));
    }
  }

  const totalKb = values.get('MemTotal') ?? 0;
  const availableKb = values.get('MemAvailable') ?? values.get('MemFree') ?? 0;
  const total = kibToMib(totalKb);
  const free = kibToMib(availableKb);

  return {
    total,
    used: Math.max(total - free, 0),
    free,
  };
}

function parseDisk(dfOutput: string): SystemMetrics['disk'] {
  const lines = dfOutput.split('\n').map((line) => line.trim()).filter(Boolean);
  const [, ...rows] = lines;

  return rows.flatMap((line) => {
    const columns = line.split(/\s+/);

    if (columns.length < 6) {
      return [];
    }

    const [filesystem, total, used, available, usePercentage] = columns;
    const mount = columns.slice(5).join(' ');

    if (isExcludedDisk(filesystem, mount)) {
      return [];
    }

    return [
      {
        mount,
        total,
        used,
        available,
        percentage: parsePercentage(usePercentage),
      },
    ];
  }).sort(compareDisks);
}

function isExcludedDisk(filesystem: string, mount: string): boolean {
  return EXCLUDED_FILESYSTEMS.has(filesystem)
    || filesystem.startsWith('tmpfs')
    || filesystem.startsWith('devtmpfs')
    || filesystem.startsWith('/dev/block/loop')
    || mount === '/apex'
    || mount.startsWith('/apex/');
}

function compareDisks(a: SystemMetrics['disk'][number], b: SystemMetrics['disk'][number]): number {
  return diskPriority(a.mount) - diskPriority(b.mount) || a.mount.localeCompare(b.mount);
}

function diskPriority(mount: string): number {
  if (mount === '/data' || mount === '/data/user/0') {
    return 0;
  }

  if (mount === '/') {
    return 1;
  }

  if (mount === '/storage/emulated' || mount === '/storage/emulated/0' || mount === '/sdcard') {
    return 2;
  }

  if (mount.startsWith('/mnt/') || mount.startsWith('/media/') || mount.startsWith('/run/media/')) {
    return 3;
  }

  return 4;
}

function parseTemperature(temperatureOutput: string): TemperatureMetric | null {
  const readings = parseTemperatureReadings(temperatureOutput).map((reading) => ({
    label: normalizeTemperatureLabel(reading.label),
    celsius: reading.celsius,
    priority: temperaturePriority(reading),
  }));

  if (!readings.length) {
    return null;
  }

  readings.sort((a, b) => b.priority - a.priority || b.celsius - a.celsius);
  const { label, celsius } = readings[0];

  return { label, celsius };
}

function parseDiskIo(diskStatsStart: string, diskStatsEnd: string): ThroughputMetric {
  const start = parseDiskStats(diskStatsStart);
  const end = parseDiskStats(diskStatsEnd);
  let readBytes = 0;
  let writeBytes = 0;

  for (const [device, endValue] of end) {
    const startValue = start.get(device);

    if (!startValue) {
      continue;
    }

    readBytes += Math.max(0, endValue.readSectors - startValue.readSectors) * 512;
    writeBytes += Math.max(0, endValue.writeSectors - startValue.writeSectors) * 512;
  }

  return {
    readBytesPerSecond: Math.round(readBytes / (CPU_SAMPLE_INTERVAL_MS / 1_000)),
    writeBytesPerSecond: Math.round(writeBytes / (CPU_SAMPLE_INTERVAL_MS / 1_000)),
  };
}

function parseDiskStats(diskStats: string): Map<string, { readSectors: number; writeSectors: number }> {
  const physicalDevices = new Map<string, { readSectors: number; writeSectors: number }>();
  const logicalDevices = new Map<string, { readSectors: number; writeSectors: number }>();

  for (const line of diskStats.split('\n')) {
    const columns = line.trim().split(/\s+/);

    if (columns.length < 10) {
      continue;
    }

    const name = columns[2];
    const readSectors = Number.parseInt(columns[5], 10);
    const writeSectors = Number.parseInt(columns[9], 10);

    if (!Number.isFinite(readSectors) || !Number.isFinite(writeSectors)) {
      continue;
    }

    const metric = { readSectors, writeSectors };

    if (isPhysicalDiskDevice(name)) {
      physicalDevices.set(name, metric);
    } else if (isLogicalDiskDevice(name)) {
      logicalDevices.set(name, metric);
    }
  }

  return physicalDevices.size ? physicalDevices : logicalDevices;
}

function parseNetwork(netDevStart: string, netDevEnd: string): NetworkMetric {
  const start = parseNetDev(netDevStart);
  const end = parseNetDev(netDevEnd);
  let receivedBytes = 0;
  let transmittedBytes = 0;

  for (const [iface, endValue] of end) {
    const startValue = start.get(iface);

    if (!startValue) {
      continue;
    }

    receivedBytes += Math.max(0, endValue.receivedBytes - startValue.receivedBytes);
    transmittedBytes += Math.max(0, endValue.transmittedBytes - startValue.transmittedBytes);
  }

  return {
    receiveBytesPerSecond: Math.round(receivedBytes / (CPU_SAMPLE_INTERVAL_MS / 1_000)),
    transmitBytesPerSecond: Math.round(transmittedBytes / (CPU_SAMPLE_INTERVAL_MS / 1_000)),
  };
}

function parseNetDev(netDev: string): Map<string, { receivedBytes: number; transmittedBytes: number }> {
  const interfaces = new Map<string, { receivedBytes: number; transmittedBytes: number }>();

  for (const line of netDev.split('\n')) {
    const [rawInterface, rawCounters] = line.split(':');

    if (!rawInterface || !rawCounters) {
      continue;
    }

    const iface = rawInterface.trim();

    if (isExcludedNetworkInterface(iface)) {
      continue;
    }

    const counters = rawCounters.trim().split(/\s+/);
    const receivedBytes = Number.parseInt(counters[0], 10);
    const transmittedBytes = Number.parseInt(counters[8], 10);

    if (!Number.isFinite(receivedBytes) || !Number.isFinite(transmittedBytes)) {
      continue;
    }

    interfaces.set(iface, { receivedBytes, transmittedBytes });
  }

  return interfaces;
}

function parseProcesses(processOutput: string): ProcessMetric[] {
  return processOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.toLowerCase().startsWith('pid'))
    .flatMap((line) => {
      const match = /^(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+(.+)$/.exec(line);

      if (!match) {
        return [];
      }

      return [
        {
          pid: Number.parseInt(match[1], 10),
          cpu: clampPercentage(Number.parseFloat(match[2])),
          memory: Math.max(0, Number.parseFloat(match[3])),
          command: match[4].trim(),
        },
      ];
    });
}

function parseContainers(containerOutput: string): ContainerMetric[] {
  return containerOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('HOMEDASHBOARD_DOCKER_ERROR\t'))
    .flatMap((line) => {
      const [id, name, image, status, ports = '', composeProjectRaw, composeServiceRaw, composeWorkingDirRaw, composeConfigFilesRaw] = line.split('\t');

      if (!id || !name || !image || !status) {
        return [];
      }

      const composeConfigFiles = parseComposeConfigFiles(normalizeDockerLabel(composeConfigFilesRaw));

      return [
        {
          id: id.slice(0, 12),
          name,
          image,
          status,
          ports,
          state: parseContainerState(status),
          composeProject: normalizeDockerLabel(composeProjectRaw),
          composeService: normalizeDockerLabel(composeServiceRaw),
          composeWorkingDir: normalizeDockerLabel(composeWorkingDirRaw),
          ...(composeConfigFiles.length ? { composeConfigFiles } : {}),
        },
      ];
    });
}

function parseContainerError(containerOutput: string): string | undefined {
  return containerOutput
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('HOMEDASHBOARD_DOCKER_ERROR\t'))
    ?.slice('HOMEDASHBOARD_DOCKER_ERROR\t'.length)
    .trim();
}

function localContainerDockerMessage(): string {
  return 'HomeDashboard is running inside a container, and a localhost server profile points at the dashboard container instead of the host. Add an SSH profile using the host LAN address to view that host Docker engine.';
}

function isContainerRuntime(): boolean {
  return existsSync('/.dockerenv') || process.env.container !== undefined;
}

function normalizeDockerLabel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized !== '<no value>' ? normalized : undefined;
}

function parseComposeConfigFiles(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseContainerState(status: string): ContainerMetric['state'] {
  const normalized = status.toLowerCase();

  if (normalized.startsWith('up ')) {
    return 'running';
  }

  if (normalized.startsWith('exited')) {
    return 'exited';
  }

  if (normalized.startsWith('paused')) {
    return 'paused';
  }

  if (normalized.startsWith('restarting')) {
    return 'restarting';
  }

  if (normalized.startsWith('created')) {
    return 'created';
  }

  return 'unknown';
}

function readMarkedSection(raw: string, marker: string, nextMarkers: string[]): string {
  const start = raw.indexOf(marker);

  if (start === -1) {
    return '';
  }

  const contentStart = start + marker.length;
  let contentEnd = raw.length;

  for (const nextMarker of nextMarkers) {
    const nextIndex = raw.indexOf(nextMarker, contentStart);

    if (nextIndex !== -1 && nextIndex < contentEnd) {
      contentEnd = nextIndex;
    }
  }

  return raw.slice(contentStart, contentEnd).trim();
}

function normalizeTemperatureLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim() || 'temperature';
}

function temperaturePriority(reading: TemperatureReading): number {
  const normalized = `${reading.source} ${reading.label} ${reading.path ?? ''}`.toLowerCase();

  if (/(x86_pkg_temp|k10temp|coretemp|cpu|package|tctl|tdie|ccd)/.test(normalized)) {
    return 5;
  }

  if (/(soc|acpitz|thermal|raspberry-pi|vcgencmd)/.test(normalized)) {
    return 4;
  }

  if (/(power|battery)/.test(normalized)) {
    return 2;
  }

  return 1;
}

function isPhysicalDiskDevice(name: string): boolean {
  return /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(name);
}

function isLogicalDiskDevice(name: string): boolean {
  return /^(md\d+|dm-\d+)$/.test(name);
}

function isExcludedNetworkInterface(name: string): boolean {
  return /^(lo|docker\d*|br-|veth|virbr|ifb|flannel|cali|cni|podman|kube-ipvs)/.test(name);
}

function parsePercentage(value: string): number {
  return clampPercentage(Number.parseInt(value.replace('%', ''), 10) || 0);
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(Number(value.toFixed(2)), 0), 100);
}

function kibToMib(value: number): number {
  return Math.round(value / 1024);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeTelemetryError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'SSH Connection Timeout or Refused';
  }

  return normalizeSshError(error.message);
}
