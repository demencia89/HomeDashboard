import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import type { ConnectConfig } from 'ssh2';
import type { KeyStore } from '../storage/key-store.js';
import type { ServerProfileStore } from './sshConnection.js';
import { execSshText, normalizeSshError, resolveSshTarget, shellQuote, SSH_READY_TIMEOUT_MS, withSshClient } from './sshConnection.js';

export interface ConnectionTestResult {
  online: boolean;
  latencyMs: number;
  hostname?: string;
  username?: string;
  os?: string;
  shell?: string;
  authMethod?: 'password' | 'privateKey';
  error?: string;
}

const CONNECTION_TEST_COMMAND = 'printf "HOSTNAME=%s\\n" "$(hostname)"; printf "USERNAME=%s\\n" "$(id -un)"; printf "OS=%s\\n" "$(uname -srvmo)"; printf "SHELL=%s\\n" "${SHELL:-unknown}"';
const REMOTE_CONNECTION_TEST_COMMAND = `/bin/sh -lc ${shellQuote(CONNECTION_TEST_COMMAND)}`;

export async function testConnection(store: ServerProfileStore, keyStore: KeyStore, serverId: string): Promise<ConnectionTestResult> {
  const started = Date.now();

  try {
    const target = await resolveSshTarget(store, keyStore, serverId);
    const raw = target.isLocal ? await runLocalConnectionTest() : await runRemoteConnectionTest(target.connectConfig);
    const parsed = parseConnectionTest(raw);

    return {
      online: true,
      latencyMs: Date.now() - started,
      hostname: parsed.HOSTNAME,
      username: parsed.USERNAME,
      os: parsed.OS,
      shell: parsed.SHELL,
      authMethod: target.profile.authMethod,
    };
  } catch (error) {
    return {
      online: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? normalizeSshError(error.message) : 'Connection test failed.',
    };
  }
}

async function runRemoteConnectionTest(connectConfig: ConnectConfig): Promise<string> {
  return withSshClient(connectConfig, (client) =>
    execSshText(client, REMOTE_CONNECTION_TEST_COMMAND, {
      timeoutMs: SSH_READY_TIMEOUT_MS,
      label: 'Connection test',
    }),
  );
}

async function runLocalConnectionTest(): Promise<string> {
  const [hostname, shell] = await Promise.all([
    fs.readFile('/proc/sys/kernel/hostname', 'utf8').catch(() => os.hostname()),
    runLocalShell('printf "%s" "${SHELL:-unknown}"'),
  ]);

  return [
    `HOSTNAME=${hostname.trim()}`,
    `USERNAME=${os.userInfo().username}`,
    `OS=${os.type()} ${os.release()} ${os.arch()}`,
    `SHELL=${shell.trim() || 'unknown'}`,
  ].join('\n');
}

function runLocalShell(command: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-lc', command], { timeout: SSH_READY_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}

function parseConnectionTest(raw: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of raw.split('\n')) {
    const index = line.indexOf('=');

    if (index > 0) {
      result[line.slice(0, index)] = line.slice(index + 1).trim();
    }
  }

  return result;
}
