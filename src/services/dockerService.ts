import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ConnectConfig } from 'ssh2';
import type { KeyStore } from '../storage/key-store.js';
import type { ServerProfileStore } from './sshConnection.js';
import { execSshCommand, normalizeSshError, resolveSshTarget, shellQuote, SSH_READY_TIMEOUT_MS, withSshClient } from './sshConnection.js';

export type DockerContainerAction = 'start' | 'stop' | 'restart';

export interface DockerContainerActionResult {
  ok: boolean;
  action: DockerContainerAction;
  containerId: string;
  error?: string;
}

export interface DockerContainerLogsResult {
  ok: boolean;
  containerId: string;
  logs?: string;
  error?: string;
}

export interface DockerComposeFileResult {
  ok: boolean;
  containerId: string;
  composeFile?: string;
  workingDir?: string;
  project?: string;
  service?: string;
  content?: string;
  error?: string;
}

export interface DockerComposeUpdateResult extends DockerComposeFileResult {
  output?: string;
}

export interface DockerComposeMetadata {
  project?: string;
  service?: string;
  workingDir?: string;
  configFiles: string[];
}

interface ShellCommandResult {
  stdout: string;
  stderr: string;
}

interface ResolvedDockerComposePaths {
  composeFile: string;
  workingDir: string;
}

const DOCKER_ACTION_TIMEOUT_MS = SSH_READY_TIMEOUT_MS * 4;
const DOCKER_LOGS_TIMEOUT_MS = SSH_READY_TIMEOUT_MS * 4;
const DOCKER_LOGS_MAX_BUFFER_BYTES = 1024 * 1024;
const DOCKER_COMPOSE_TIMEOUT_MS = SSH_READY_TIMEOUT_MS * 20;
const DOCKER_COMPOSE_MAX_BUFFER_BYTES = 1024 * 1024 * 2;
const DOCKER_COMPOSE_MAX_CONTENT_BYTES = 1024 * 512;
const FORBIDDEN_COMPOSE_WORKING_DIRS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var/lib/docker',
  '/var/run',
];

export async function controlDockerContainer(
  store: ServerProfileStore,
  keyStore: KeyStore,
  serverId: string,
  containerId: string,
  action: DockerContainerAction,
): Promise<DockerContainerActionResult> {
  assertValidContainerId(containerId);
  assertValidDockerAction(action);

  try {
    const target = await resolveSshTarget(store, keyStore, serverId);

    if (target.isLocal) {
      await controlLocalContainer(containerId, action);
    } else {
      await controlRemoteContainer(target.connectConfig, containerId, action);
    }

    return { ok: true, action, containerId };
  } catch (error) {
    return {
      ok: false,
      action,
      containerId,
      error: error instanceof Error ? normalizeSshError(error.message) : 'Unable to control Docker container.',
    };
  }
}

export function isDockerContainerAction(value: string): value is DockerContainerAction {
  return value === 'start' || value === 'stop' || value === 'restart';
}

export async function getDockerContainerLogs(
  store: ServerProfileStore,
  keyStore: KeyStore,
  serverId: string,
  containerId: string,
  tail = 200,
): Promise<DockerContainerLogsResult> {
  assertValidContainerId(containerId);
  const safeTail = normalizeLogTail(tail);

  try {
    const target = await resolveSshTarget(store, keyStore, serverId);
    const logs = target.isLocal
      ? await getLocalContainerLogs(containerId, safeTail)
      : await getRemoteContainerLogs(target.connectConfig, containerId, safeTail);

    return { ok: true, containerId, logs };
  } catch (error) {
    return {
      ok: false,
      containerId,
      error: error instanceof Error ? normalizeSshError(error.message) : 'Unable to read Docker container logs.',
    };
  }
}

export async function getDockerComposeFile(
  store: ServerProfileStore,
  keyStore: KeyStore,
  serverId: string,
  containerId: string,
): Promise<DockerComposeFileResult> {
  assertValidContainerId(containerId);

  try {
    const target = await resolveSshTarget(store, keyStore, serverId);
    const metadataOutput = await runDockerShellCommand(target.connectConfig, target.isLocal, buildDockerComposeMetadataCommand(containerId), DOCKER_COMPOSE_TIMEOUT_MS);
    const metadata = parseDockerComposeLabels(metadataOutput.stdout);
    const composePaths = resolveComposePaths(metadata);

    if (!composePaths) {
      return {
        ok: false,
        containerId,
        error: 'This container was not created from a discoverable Docker Compose file.',
      };
    }

    const contentOutput = await runDockerShellCommand(
      target.connectConfig,
      target.isLocal,
      buildReadComposeFileCommand(composePaths.composeFile, composePaths.workingDir),
      DOCKER_COMPOSE_TIMEOUT_MS,
    );

    return {
      ok: true,
      containerId,
      composeFile: composePaths.composeFile,
      workingDir: composePaths.workingDir,
      project: metadata.project,
      service: metadata.service,
      content: contentOutput.stdout,
    };
  } catch (error) {
    return {
      ok: false,
      containerId,
      error: error instanceof Error ? normalizeSshError(error.message) : 'Unable to read Docker Compose file.',
    };
  }
}

export async function updateDockerComposeFile(
  store: ServerProfileStore,
  keyStore: KeyStore,
  serverId: string,
  containerId: string,
  content: string,
): Promise<DockerComposeUpdateResult> {
  assertValidContainerId(containerId);
  assertValidComposeContent(content);

  try {
    const target = await resolveSshTarget(store, keyStore, serverId);
    const metadataOutput = await runDockerShellCommand(target.connectConfig, target.isLocal, buildDockerComposeMetadataCommand(containerId), DOCKER_COMPOSE_TIMEOUT_MS);
    const metadata = parseDockerComposeLabels(metadataOutput.stdout);
    const composePaths = resolveComposePaths(metadata);

    if (!composePaths) {
      return {
        ok: false,
        containerId,
        error: 'This container was not created from a discoverable Docker Compose file.',
      };
    }

    const applyOutput = await runDockerShellCommand(
      target.connectConfig,
      target.isLocal,
      buildDockerComposeApplyCommand(composePaths.composeFile, composePaths.workingDir, content),
      DOCKER_COMPOSE_TIMEOUT_MS,
    );

    return {
      ok: true,
      containerId,
      composeFile: composePaths.composeFile,
      workingDir: composePaths.workingDir,
      project: metadata.project,
      service: metadata.service,
      content,
      output: combineOutput(applyOutput.stdout, applyOutput.stderr),
    };
  } catch (error) {
    return {
      ok: false,
      containerId,
      error: error instanceof Error ? normalizeSshError(error.message) : 'Unable to update Docker Compose file.',
    };
  }
}

function assertValidDockerAction(action: string): asserts action is DockerContainerAction {
  if (!isDockerContainerAction(action)) {
    throw new Error('action must be start, stop, or restart.');
  }
}

function assertValidContainerId(containerId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerId)) {
    throw new Error('containerId must be a valid Docker container id or name.');
  }
}

function assertValidComposeContent(content: string): void {
  if (!content.trim()) {
    throw new Error('Docker Compose content cannot be empty.');
  }

  if (Buffer.byteLength(content, 'utf8') > DOCKER_COMPOSE_MAX_CONTENT_BYTES) {
    throw new Error('Docker Compose content is too large.');
  }
}

async function controlRemoteContainer(connectConfig: ConnectConfig, containerId: string, action: DockerContainerAction): Promise<void> {
  await withSshClient(connectConfig, async (client) => {
    await execSshCommand(client, buildDockerActionCommand(containerId, action), {
      timeoutMs: DOCKER_ACTION_TIMEOUT_MS,
      label: `Docker ${action}`,
    });
  });
}

async function getRemoteContainerLogs(connectConfig: ConnectConfig, containerId: string, tail: number): Promise<string> {
  return withSshClient(connectConfig, async (client) => {
    const result = await execSshCommand(client, buildDockerLogsCommand(containerId, tail), {
      timeoutMs: DOCKER_LOGS_TIMEOUT_MS,
      label: 'Docker logs',
    });

    return combineOutput(result.stdout, result.stderr);
  });
}

async function runDockerShellCommand(connectConfig: ConnectConfig, isLocal: boolean, command: string, timeoutMs: number): Promise<ShellCommandResult> {
  if (isLocal) {
    return runLocalShellCommand(command, timeoutMs);
  }

  return withSshClient(connectConfig, async (client) => {
    const result = await execSshCommand(client, command, {
      timeoutMs,
      label: 'Docker Compose command',
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
}

function controlLocalContainer(containerId: string, action: DockerContainerAction): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-lc', buildDockerActionCommand(containerId, action)], { timeout: DOCKER_ACTION_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      resolve();
    });
  });
}

function getLocalContainerLogs(containerId: string, tail: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-lc', buildDockerLogsCommand(containerId, tail)],
      { timeout: DOCKER_LOGS_TIMEOUT_MS, maxBuffer: DOCKER_LOGS_MAX_BUFFER_BYTES },
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

function runLocalShellCommand(command: string, timeoutMs: number): Promise<ShellCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-lc', command],
      { timeout: timeoutMs, maxBuffer: DOCKER_COMPOSE_MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}

export function buildDockerActionCommand(containerId: string, action: DockerContainerAction): string {
  const quotedContainerId = shellQuote(containerId);
  return `docker ${action} ${quotedContainerId} 2>/dev/null || sudo -n docker ${action} ${quotedContainerId}`;
}

export function buildDockerLogsCommand(containerId: string, tail: number): string {
  const quotedContainerId = shellQuote(containerId);
  return `if docker ps -a >/dev/null 2>&1; then docker logs --tail ${tail} --timestamps ${quotedContainerId}; else sudo -n docker logs --tail ${tail} --timestamps ${quotedContainerId}; fi`;
}

export function buildDockerComposeMetadataCommand(containerId: string): string {
  const quotedContainerId = shellQuote(containerId);
  return `if docker inspect ${quotedContainerId} >/dev/null 2>&1; then docker inspect --format '{{json .Config.Labels}}' ${quotedContainerId}; else sudo -n docker inspect --format '{{json .Config.Labels}}' ${quotedContainerId}; fi`;
}

export function parseDockerComposeLabels(output: string): DockerComposeMetadata {
  const trimmed = output.trim();

  if (!trimmed || trimmed === 'null') {
    return { configFiles: [] };
  }

  const labels = JSON.parse(trimmed) as Record<string, string | undefined>;

  return {
    project: normalizeComposeLabel(labels['com.docker.compose.project']),
    service: normalizeComposeLabel(labels['com.docker.compose.service']),
    workingDir: normalizeComposeLabel(labels['com.docker.compose.project.working_dir']),
    configFiles: parseComposeConfigFiles(labels['com.docker.compose.project.config_files']),
  };
}

export function resolveComposeFilePath(metadata: DockerComposeMetadata): string | undefined {
  return resolveComposePaths(metadata)?.composeFile;
}

function resolveComposePaths(metadata: DockerComposeMetadata): ResolvedDockerComposePaths | undefined {
  const workingDir = normalizeComposeWorkingDir(metadata.workingDir);
  const composeFile = metadata.configFiles[0];

  if (!workingDir || !composeFile || composeFile.includes('\0')) {
    return undefined;
  }

  const resolvedComposeFile = path.posix.isAbsolute(composeFile)
    ? path.posix.normalize(composeFile)
    : path.posix.resolve(workingDir, composeFile);

  if (!isYamlComposeFile(resolvedComposeFile) || !isPathWithin(workingDir, resolvedComposeFile)) {
    return undefined;
  }

  return {
    composeFile: resolvedComposeFile,
    workingDir,
  };
}

function normalizeComposeWorkingDir(value: string | undefined): string | undefined {
  if (!value || value.includes('\0') || !path.posix.isAbsolute(value)) {
    return undefined;
  }

  const normalized = path.posix.normalize(value);
  return normalized === '/' || isForbiddenComposeWorkingDir(normalized) ? undefined : normalized;
}

function isYamlComposeFile(filePath: string): boolean {
  const extension = path.posix.extname(filePath).toLowerCase();
  return extension === '.yml' || extension === '.yaml';
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.posix.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative));
}

function isForbiddenComposeWorkingDir(workingDir: string): boolean {
  return FORBIDDEN_COMPOSE_WORKING_DIRS.some((forbiddenDir) => isPathWithin(forbiddenDir, workingDir));
}

export function buildDockerComposeApplyCommand(composeFile: string, workingDir: string, content: string): string {
  const encodedContent = Buffer.from(content, 'utf8').toString('base64');

  return `/bin/sh -lc ${shellQuote(`
set -eu
file=${shellQuote(composeFile)}
workdir=${shellQuote(workingDir)}
encoded=${shellQuote(encodedContent)}
stamp="$(date +%Y%m%d%H%M%S)"

run_compose() {
  docker compose "$@" || docker-compose "$@" || sudo -n docker compose "$@" || sudo -n docker-compose "$@"
}

decode_content() {
  printf '%s' "$encoded" | base64 -d
}

real_path() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1"
  else
    readlink -f "$1"
  fi
}

workdir_real="$(real_path "$workdir")"
file_real="$(real_path "$file")"
if [ "$workdir_real" = "/" ]; then
  printf '%s\\n' 'Docker Compose working directory is not allowed.' >&2
  exit 2
fi
case "$file_real" in
  "$workdir_real"/*) ;;
  *) printf '%s\\n' 'Docker Compose file is outside the allowed project directory.' >&2; exit 2 ;;
esac
case "$file_real" in
  *.yml|*.yaml) ;;
  *) printf '%s\\n' 'Docker Compose file must be .yml or .yaml.' >&2; exit 2 ;;
esac

file="$file_real"
workdir="$workdir_real"
tmp="$(dirname "$file")/.homedashboard-compose.$stamp.$$"
backup="$file.homedashboard.bak.$stamp"

restore_backup() {
  if [ -f "$backup" ]; then
    if [ -w "$file" ] && [ -w "$(dirname "$file")" ]; then
      mv "$backup" "$file"
    else
      sudo -n mv "$backup" "$file"
    fi
  fi
}

if [ -w "$file" ] && [ -w "$(dirname "$file")" ]; then
  cp "$file" "$backup"
  decode_content > "$tmp"
  mv "$tmp" "$file"
else
  sudo -n cp "$file" "$backup"
  decode_content | sudo -n tee "$tmp" >/dev/null
  sudo -n mv "$tmp" "$file"
fi

cd "$workdir"
if ! run_compose -f "$file" config >/tmp/homedashboard-compose-check.$$ 2>&1; then
  cat /tmp/homedashboard-compose-check.$$
  rm -f /tmp/homedashboard-compose-check.$$
  restore_backup
  exit 1
fi
rm -f /tmp/homedashboard-compose-check.$$
run_compose -f "$file" up -d
`)}`;
}

function buildReadComposeFileCommand(composeFile: string, workingDir: string): string {
  return `/bin/sh -lc ${shellQuote(`
set -eu
file=${shellQuote(composeFile)}
workdir=${shellQuote(workingDir)}
real_path() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1"
  else
    readlink -f "$1"
  fi
}
workdir_real="$(real_path "$workdir")"
file_real="$(real_path "$file")"
if [ "$workdir_real" = "/" ]; then
  printf '%s\\n' 'Docker Compose working directory is not allowed.' >&2
  exit 2
fi
case "$file_real" in
  "$workdir_real"/*) ;;
  *) printf '%s\\n' 'Docker Compose file is outside the allowed project directory.' >&2; exit 2 ;;
esac
case "$file_real" in
  *.yml|*.yaml) ;;
  *) printf '%s\\n' 'Docker Compose file must be .yml or .yaml.' >&2; exit 2 ;;
esac
cat "$file_real" 2>/dev/null || sudo -n cat "$file_real"
`)}`;
}

function normalizeComposeLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== '<no value>' ? trimmed : undefined;
}

function parseComposeConfigFiles(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeLogTail(value: number): number {
  return Number.isInteger(value) && value > 0 && value <= 1000 ? value : 200;
}

function combineOutput(stdout: string, stderr: string): string {
  return `${stdout}${stderr}`.trimEnd();
}
