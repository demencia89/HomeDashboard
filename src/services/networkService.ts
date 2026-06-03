import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ConnectConfig } from 'ssh2';
import type { KeyStore } from '../storage/key-store.js';
import type { ServerProfileStore } from './sshConnection.js';
import { execSshCommand, normalizeSshError, resolveSshTarget, ServerNotFoundError, shellQuote, withSshClient } from './sshConnection.js';

export interface NethogsSnapshot {
  ok: boolean;
  output: string;
  collectedAt: string;
  rows: NethogsRow[];
  totals: NethogsTotals;
  version?: string;
  error?: string;
}

export interface NethogsRow {
  pid: number;
  user: string;
  program: string;
  device: string;
  sentKbPerSecond: number;
  receivedKbPerSecond: number;
}

export interface NethogsTotals {
  sentKbPerSecond: number;
  receivedKbPerSecond: number;
}

const NETHOGS_SAMPLE_COUNT = 3;
const NETHOGS_DELAY_SECONDS = 1;
const NETHOGS_TIMEOUT_MS = 10_000;
const NETHOGS_MAX_BUFFER_BYTES = 512 * 1024;

const RAW_NETHOGS_COMMAND = `
export LC_ALL=C LANG=C
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
primary_dev="$(ip route show default 2>/dev/null | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit } }' || true)"
[ -n "$primary_dev" ] && printf 'HOMEDASHBOARD_DEV\\t%s\\n' "$primary_dev"
nethogs_bin="$(command -v nethogs 2>/dev/null || true)"
if [ -z "$nethogs_bin" ] && [ -x /usr/sbin/nethogs ]; then
  nethogs_bin=/usr/sbin/nethogs
fi
if [ -z "$nethogs_bin" ]; then
  printf 'nethogs is not installed on this server.\\n'
  exit 0
fi
"$nethogs_bin" -V 2>&1 | sed -n '1s/^/HOMEDASHBOARD_VERSION\\t/p' || true

run_nethogs() {
  "$nethogs_bin" -t -c ${NETHOGS_SAMPLE_COUNT} -d ${NETHOGS_DELAY_SECONDS} 2>&1
}

if [ "$(id -u)" = "0" ]; then
  run_nethogs
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n "$nethogs_bin" -t -c ${NETHOGS_SAMPLE_COUNT} -d ${NETHOGS_DELAY_SECONDS} 2>&1
else
  run_nethogs
fi

status=$?
if [ "$status" -ne 0 ]; then
  printf '\\nnethogs exited with code %s. It may need root privileges or CAP_NET_ADMIN.\\n' "$status"
fi
exit 0
`.trim();

export function buildNethogsCommand(): string {
  return `/bin/sh -lc ${shellQuote(RAW_NETHOGS_COMMAND)}`;
}

export async function getNethogsSnapshot(store: ServerProfileStore, keyStore: KeyStore, serverId: string): Promise<NethogsSnapshot> {
  try {
    const target = await resolveSshTarget(store, keyStore, serverId);

    if (target.isLocal && isContainerRuntime()) {
      return {
        ok: false,
        output: localContainerNethogsMessage(),
        collectedAt: new Date().toISOString(),
        rows: [],
        totals: emptyNethogsTotals(),
      };
    }

    const output = target.isLocal ? await getLocalNethogsOutput() : await getRemoteNethogsOutput(target.connectConfig);
    const normalizedOutput = normalizeNethogsOutput(output);
    const parsed = parseNethogsOutput(normalizedOutput, target.profile.username);

    return {
      ok: isNethogsOutputAvailable(normalizedOutput),
      output: stripNethogsMarkers(normalizedOutput),
      collectedAt: new Date().toISOString(),
      rows: parsed.rows,
      totals: parsed.totals,
      version: parsed.version,
    };
  } catch (error) {
    if (error instanceof ServerNotFoundError) {
      throw error;
    }

    return {
      ok: false,
      output: '',
      collectedAt: new Date().toISOString(),
      rows: [],
      totals: emptyNethogsTotals(),
      error: error instanceof Error ? normalizeSshError(error.message) : 'Unable to read nethogs output.',
    };
  }
}

export function parseNethogsOutput(output: string, fallbackUser: string): Pick<NethogsSnapshot, 'rows' | 'totals' | 'version'> {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const device = findMarkerValue(lines, 'HOMEDASHBOARD_DEV') || '-';
  const version = findMarkerValue(lines, 'HOMEDASHBOARD_VERSION');
  const rows = latestRefreshRows(lines)
    .map((line) => parseNethogsRow(line, fallbackUser, device))
    .filter((row): row is NethogsRow => row !== undefined)
    .sort((a, b) => (b.sentKbPerSecond + b.receivedKbPerSecond) - (a.sentKbPerSecond + a.receivedKbPerSecond));
  const totals = rows.reduce<NethogsTotals>((current, row) => ({
    sentKbPerSecond: current.sentKbPerSecond + row.sentKbPerSecond,
    receivedKbPerSecond: current.receivedKbPerSecond + row.receivedKbPerSecond,
  }), emptyNethogsTotals());

  return { rows, totals, version };
}

export function localContainerNethogsMessage(): string {
  return [
    'HomeDashboard is running inside a container.',
    'A localhost server profile points at the container network namespace, not the host network namespace.',
    'Add an SSH profile for the host LAN address to view host NetHogs data.',
  ].join('\n');
}

function getRemoteNethogsOutput(connectConfig: ConnectConfig): Promise<string> {
  return withSshClient(connectConfig, async (client) => {
    const result = await execSshCommand(client, buildNethogsCommand(), {
      timeoutMs: NETHOGS_TIMEOUT_MS,
      label: 'nethogs snapshot',
    });

    return combineOutput(result.stdout, result.stderr);
  });
}

function getLocalNethogsOutput(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-lc', RAW_NETHOGS_COMMAND],
      { timeout: NETHOGS_TIMEOUT_MS, maxBuffer: NETHOGS_MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
          return;
        }

        resolve(combineOutput(stdout, stderr));
      },
    );
  });
}

function normalizeNethogsOutput(output: string): string {
  const trimmed = output
    .split('\n')
    .filter((line) => !(line.includes('/etc/profile.d/activate_display.sh') && line.includes('[[: not found')))
    .filter((line) => !line.startsWith('Adding local address:'))
    .filter((line) => line !== 'Ethernet link detected')
    .join('\n')
    .trim();

  if (!trimmed) {
    return 'nethogs returned no output.';
  }

  return trimmed;
}

function stripNethogsMarkers(output: string): string {
  return output
    .split('\n')
    .filter((line) => !line.startsWith('HOMEDASHBOARD_'))
    .join('\n')
    .trim();
}

function isNethogsOutputAvailable(output: string): boolean {
  const normalized = output.toLowerCase();
  return !(
    normalized.includes('nethogs is not installed') ||
    normalized.includes('need to be root') ||
    normalized.includes('exited with code') ||
    normalized.includes('operation not permitted') ||
    normalized.includes('permission denied')
  );
}

function combineOutput(stdout: string, stderr: string): string {
  return `${stdout}${stderr}`.trimEnd();
}

function isContainerRuntime(): boolean {
  return existsSync('/.dockerenv') || process.env.container !== undefined;
}

function latestRefreshRows(lines: string[]): string[] {
  let latestRefreshIndex = -1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] === 'Refreshing:') {
      latestRefreshIndex = index;
      break;
    }
  }

  const rows = latestRefreshIndex >= 0 ? lines.slice(latestRefreshIndex + 1) : lines;

  return rows.filter((line) => {
    if (
      line.startsWith('HOMEDASHBOARD_') ||
      line.startsWith('Unknown connection:') ||
      line.startsWith('nethogs exited with code') ||
      line.startsWith('nethogs is not installed') ||
      line === 'Refreshing:'
    ) {
      return false;
    }

    return line.split('\t').length >= 3;
  });
}

function parseNethogsRow(line: string, fallbackUser: string, device: string): NethogsRow | undefined {
  const [identity, sentRaw, receivedRaw] = line.split('\t');
  const sentKbPerSecond = Number.parseFloat(sentRaw);
  const receivedKbPerSecond = Number.parseFloat(receivedRaw);

  if (!identity || !Number.isFinite(sentKbPerSecond) || !Number.isFinite(receivedKbPerSecond)) {
    return undefined;
  }

  const match = /^(.*)\/(\d+)\/(\d+)$/.exec(identity);
  const program = match?.[1]?.trim() || identity.trim();
  const pid = match ? Number.parseInt(match[2], 10) : 0;
  const uid = match ? Number.parseInt(match[3], 10) : Number.NaN;

  return {
    pid: Number.isFinite(pid) ? pid : 0,
    user: usernameForUid(uid, fallbackUser),
    program: program || 'unknown',
    device,
    sentKbPerSecond,
    receivedKbPerSecond,
  };
}

function usernameForUid(uid: number, fallbackUser: string): string {
  if (uid === 0) {
    return 'root';
  }

  if (uid === 1000 && fallbackUser.trim()) {
    return fallbackUser.trim();
  }

  return Number.isFinite(uid) ? String(uid) : '-';
}

function findMarkerValue(lines: string[], marker: string): string | undefined {
  const prefix = `${marker}\t`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim() || undefined;
}

function emptyNethogsTotals(): NethogsTotals {
  return {
    sentKbPerSecond: 0,
    receivedKbPerSecond: 0,
  };
}
