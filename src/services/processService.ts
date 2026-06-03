import { execFile } from 'node:child_process';
import type { ConnectConfig } from 'ssh2';
import type { KeyStore } from '../storage/key-store.js';
import type { ServerProfileStore } from './sshConnection.js';
import { execSshCommand, normalizeSshError, resolveSshTarget, SSH_READY_TIMEOUT_MS, withSshClient } from './sshConnection.js';

export interface KillProcessResult {
  ok: boolean;
  pid: number;
  error?: string;
}

export async function killProcess(store: ServerProfileStore, keyStore: KeyStore, serverId: string, pid: number): Promise<KillProcessResult> {
  assertValidPid(pid);

  try {
    const target = await resolveSshTarget(store, keyStore, serverId);

    if (target.isLocal) {
      await killLocalProcess(pid);
    } else {
      await killRemoteProcess(target.connectConfig, pid);
    }

    return { ok: true, pid };
  } catch (error) {
    return {
      ok: false,
      pid,
      error: error instanceof Error ? normalizeSshError(error.message) : 'Unable to kill process.',
    };
  }
}

function assertValidPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1 || pid > 4_194_304) {
    throw new Error('pid must be a valid process id greater than 1.');
  }
}

async function killRemoteProcess(connectConfig: ConnectConfig, pid: number): Promise<void> {
  await withSshClient(connectConfig, async (client) => {
    await execSshCommand(client, `kill ${pid}`, {
      timeoutMs: SSH_READY_TIMEOUT_MS,
      label: 'Process kill',
    });
  });
}

function killLocalProcess(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('kill', [String(pid)], { timeout: SSH_READY_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      resolve();
    });
  });
}
