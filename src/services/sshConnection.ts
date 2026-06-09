import fs from 'node:fs/promises';
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import type { ServerProfile } from '../types/server-profile.js';
import type { KeyStore } from '../storage/key-store.js';
import { DecryptionError, decryptPassword } from '../utils/crypto.js';

export const SSH_READY_TIMEOUT_MS = 5_000;
const DEFAULT_POOLED_SSH_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_POOLED_SSH_MAX_LIFETIME_MS = 30 * 60_000;
const sshClientQueues = new Map<string, Promise<void>>();

interface PooledSshClientState {
  client?: Client;
  connecting?: Promise<Client>;
  idleTimer?: NodeJS.Timeout;
  queue: Promise<void>;
  activeActions: number;
  connectedAt?: number;
}

export interface SshConnectionPoolOptions {
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
}

export class ServerNotFoundError extends Error {
  constructor(id: string) {
    super(`Server profile "${id}" was not found.`);
    this.name = 'ServerNotFoundError';
  }
}

export class UnsupportedAuthError extends Error {
  constructor() {
    super('Password authentication requires stored encrypted password fields.');
    this.name = 'UnsupportedAuthError';
  }
}

export interface ServerProfileStore {
  listServers(): Promise<ServerProfile[]>;
}

export interface ResolvedSshTarget {
  profile: ServerProfile;
  connectConfig: ConnectConfig;
  isLocal: boolean;
}

export interface SshExecOptions {
  timeoutMs?: number;
  label?: string;
  input?: string;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}

export async function resolveServerProfile(store: ServerProfileStore, id: string): Promise<ServerProfile> {
  const profile = (await store.listServers()).find((server) => server.id === id);

  if (!profile) {
    throw new ServerNotFoundError(id);
  }

  return profile;
}

export async function resolveSshTarget(
  store: ServerProfileStore,
  keyStore: KeyStore,
  id: string,
): Promise<ResolvedSshTarget> {
  const profile = await resolveServerProfile(store, id);
  const isLocal = isLocalHost(profile.host);

  if (isLocal) {
    return {
      profile,
      isLocal,
      connectConfig: {
        host: '127.0.0.1',
        port: profile.port,
        username: profile.username,
        readyTimeout: SSH_READY_TIMEOUT_MS,
      },
    };
  }

  return {
    profile,
    isLocal,
    connectConfig: await buildSshConnectConfig(profile, keyStore),
  };
}

export async function buildSshConnectConfig(profile: ServerProfile, keyStore: KeyStore): Promise<ConnectConfig> {
  const baseConfig: ConnectConfig = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    readyTimeout: SSH_READY_TIMEOUT_MS,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 2,
  };

  if (profile.authMethod === 'privateKey') {
    if (!profile.privateKeyName) {
      throw new Error('privateKeyName is required for privateKey authentication.');
    }

    return {
      ...baseConfig,
      privateKey: await fs.readFile(keyStore.resolveKeyPath(profile.privateKeyName), 'utf8'),
    };
  }

  if (profile.authMethod === 'password') {
    if (!profile.encryptedPassword || !profile.iv || !profile.authTag) {
      throw new UnsupportedAuthError();
    }

    let password: string;

    try {
      password = decryptPassword(profile.encryptedPassword, profile.iv, profile.authTag);
    } catch {
      throw new DecryptionError();
    }

    return {
      ...baseConfig,
      password,
    };
  }

  throw new UnsupportedAuthError();
}

export function connectSsh(config: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error('SSH Connection Timeout or Refused'));
      client.destroy();
    }, SSH_READY_TIMEOUT_MS + 250);

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      client.removeListener('ready', onReady);
      client.removeListener('error', onError);

      if (error) {
        client.on('error', ignoreBackgroundSshError);
        closeSshClient(client);
        reject(error);
      } else {
        client.on('error', ignoreBackgroundSshError);
        resolve(client);
      }
    };

    const onReady = () => finish();
    const onError = (error: Error) => finish(new Error(normalizeSshError(errorMessage(error))));

    client.once('ready', onReady);
    client.once('error', onError);

    try {
      client.connect(config);
    } catch (error) {
      finish(error instanceof Error ? error : new Error('SSH Connection Timeout or Refused'));
    }
  });
}

export async function withSshClient<T>(connectConfig: ConnectConfig, action: (client: Client) => Promise<T>): Promise<T> {
  return runQueuedSshAction(connectConfig, async () => {
    const client = await connectSshWithRetry(connectConfig);

    try {
      return await action(client);
    } finally {
      closeSshClient(client);
    }
  });
}

export class SshConnectionPool {
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly clients = new Map<string, PooledSshClientState>();

  constructor(options: SshConnectionPoolOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_POOLED_SSH_IDLE_TIMEOUT_MS;
    this.maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_POOLED_SSH_MAX_LIFETIME_MS;
  }

  async withClient<T>(connectConfig: ConnectConfig, action: (client: Client) => Promise<T>): Promise<T> {
    const key = sshQueueKey(connectConfig);
    const state = this.getState(key);
    const previous = state.queue;
    let releaseCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    state.activeActions += 1;
    this.clearIdleTimer(state);
    state.queue = previous.catch(() => undefined).then(() => current);

    await previous.catch(() => undefined);

    try {
      let lastError: unknown;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const client = await this.getClient(key, state, connectConfig);

        try {
          return await action(client);
        } catch (error) {
          lastError = error;

          if (!isRetryableSshError(error)) {
            throw error;
          }

          this.dropClient(key, state, client);

          if (attempt === 1) {
            throw error;
          }

          await delay(200);
        }
      }

      throw lastError instanceof Error ? lastError : new Error('SSH Connection Timeout or Refused');
    } finally {
      releaseCurrent();
      state.activeActions = Math.max(0, state.activeActions - 1);
      this.scheduleIdleClose(key, state);
    }
  }

  drop(connectConfig: ConnectConfig): void {
    const key = sshQueueKey(connectConfig);
    const state = this.clients.get(key);

    if (state) {
      this.closeState(key, state);
    }
  }

  closeAll(): void {
    for (const [key, state] of this.clients) {
      this.closeState(key, state);
    }

    this.clients.clear();
  }

  private getState(key: string): PooledSshClientState {
    const existing = this.clients.get(key);

    if (existing) {
      return existing;
    }

    const state: PooledSshClientState = {
      queue: Promise.resolve(),
      activeActions: 0,
    };
    this.clients.set(key, state);
    return state;
  }

  private async getClient(key: string, state: PooledSshClientState, connectConfig: ConnectConfig): Promise<Client> {
    if (state.client) {
      if (!this.isClientExpired(state)) {
        return state.client;
      }

      const expiredClient = state.client;
      state.client = undefined;
      state.connectedAt = undefined;
      closeSshClient(expiredClient);
    }

    if (!state.connecting) {
      state.connecting = connectSshWithRetry(connectConfig)
        .then((client) => {
          if (this.clients.get(key) !== state) {
            closeSshClient(client);
            throw new Error('SSH connection pool closed.');
          }

          state.client = client;
          state.connectedAt = Date.now();
          this.watchClient(key, state, client);
          return client;
        })
        .finally(() => {
          state.connecting = undefined;
        });
    }

    return state.connecting;
  }

  private watchClient(key: string, state: PooledSshClientState, client: Client): void {
    let removed = false;
    const remove = () => {
      if (removed) {
        return;
      }

      removed = true;
      client.removeListener('close', remove);
      client.removeListener('end', remove);
      client.removeListener('error', remove);

      if (state.client === client) {
        state.client = undefined;
        state.connectedAt = undefined;
      }

      this.clearIdleTimer(state);

      if (state.activeActions === 0 && !state.connecting && this.clients.get(key) === state) {
        this.clients.delete(key);
      }
    };

    client.once('close', remove);
    client.once('end', remove);
    client.once('error', remove);
  }

  private dropClient(key: string, state: PooledSshClientState, client: Client): void {
    if (state.client === client) {
      state.client = undefined;
      state.connectedAt = undefined;
    }

    closeSshClient(client);

    if (!state.connecting && state.activeActions === 0 && this.clients.get(key) === state) {
      this.clients.delete(key);
    }
  }

  private scheduleIdleClose(key: string, state: PooledSshClientState): void {
    if (this.clients.get(key) !== state || state.activeActions > 0) {
      return;
    }

    this.clearIdleTimer(state);

    if (!state.client && !state.connecting) {
      this.clients.delete(key);
      return;
    }

    if (this.idleTimeoutMs <= 0) {
      this.closeState(key, state);
      return;
    }

    state.idleTimer = setTimeout(() => {
      if (state.activeActions > 0 || this.clients.get(key) !== state) {
        return;
      }

      this.closeState(key, state);
    }, this.idleTimeoutMs);
    state.idleTimer.unref?.();
  }

  private closeState(key: string, state: PooledSshClientState): void {
    this.clearIdleTimer(state);

    const client = state.client;
    state.client = undefined;
    state.connectedAt = undefined;

    if (client) {
      closeSshClient(client);
    }

    if (!state.connecting && this.clients.get(key) === state) {
      this.clients.delete(key);
    }
  }

  private clearIdleTimer(state: PooledSshClientState): void {
    if (!state.idleTimer) {
      return;
    }

    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }

  private isClientExpired(state: PooledSshClientState): boolean {
    return this.maxLifetimeMs > 0 && state.connectedAt !== undefined && Date.now() - state.connectedAt >= this.maxLifetimeMs;
  }
}

async function connectSshWithRetry(connectConfig: ConnectConfig): Promise<Client> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await connectSsh(connectConfig);
    } catch (error) {
      lastError = error;

      if (!isRetryableSshError(error) || attempt === 1) {
        throw error;
      }

      await delay(600);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('SSH Connection Timeout or Refused');
}

async function runQueuedSshAction<T>(connectConfig: ConnectConfig, action: () => Promise<T>): Promise<T> {
  const key = sshQueueKey(connectConfig);
  const previous = sshClientQueues.get(key) ?? Promise.resolve();
  let releaseCurrent: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);

  sshClientQueues.set(key, queued);
  await previous.catch(() => undefined);

  try {
    return await action();
  } finally {
    releaseCurrent();

    if (sshClientQueues.get(key) === queued) {
      sshClientQueues.delete(key);
    }
  }
}

function sshQueueKey(connectConfig: ConnectConfig): string {
  return [
    connectConfig.host ?? 'localhost',
    connectConfig.port ?? 22,
    connectConfig.username ?? '',
  ].join(':');
}

function isRetryableSshError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('timeout')
    || message.includes('refused')
    || message.includes('connection lost')
    || message.includes('not connected')
    || message.includes('no response')
    || message.includes('unable to exec')
    || message.includes('reset')
    || message.includes('closed');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function execSshText(client: Client, command: string, options: SshExecOptions = {}): Promise<string> {
  return execSshCommand(client, command, options).then((result) => result.stdout);
}

export function execSshCommand(client: Client, command: string, options: SshExecOptions = {}): Promise<SshExecResult> {
  const timeoutMs = options.timeoutMs ?? SSH_READY_TIMEOUT_MS;
  const label = options.label ?? 'SSH command';

  return new Promise((resolve, reject) => {
    let settled = false;
    let stream: ClientChannel | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const onStdout = (chunk: Buffer) => {
      stdout.push(Buffer.from(chunk));
    };

    const onStderr = (chunk: Buffer) => {
      stderr.push(Buffer.from(chunk));
    };

    const onClientError = (error: Error) => {
      settle(error, true);
    };

    const onStreamError = (error: Error) => {
      settle(error, true);
    };

    const onClose = (code: number | null, signal: string | null) => {
      const result: SshExecResult = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        signal,
      };

      if (code && code !== 0) {
        settle(new Error(result.stderr || `${label} exited with code ${code}.`));
        return;
      }

      settle(undefined, false, result);
    };

    const cleanup = () => {
      clearTimeout(timer);
      client.removeListener('error', onClientError);

      if (stream) {
        stream.removeListener('data', onStdout);
        stream.stderr.removeListener('data', onStderr);
        stream.removeListener('error', onStreamError);
        stream.removeListener('close', onClose);
      }
    };

    const settle = (error?: Error, destroyStream = false, result?: SshExecResult) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (destroyStream) {
        try {
          stream?.destroy();
        } catch {
          // Best-effort cleanup only.
        }
      }

      if (error) {
        reject(error);
      } else {
        resolve(result ?? { stdout: '', stderr: '', code: null, signal: null });
      }
    };

    timer = setTimeout(() => {
      settle(new Error(`${label} timed out.`), true);
    }, timeoutMs);

    client.once('error', onClientError);

    try {
      client.exec(command, (error, channel) => {
        if (error) {
          settle(error, true);
          return;
        }

        stream = channel;
        stream.on('data', onStdout);
        stream.stderr.on('data', onStderr);
        stream.once('error', onStreamError);
        stream.once('close', onClose);

        if (options.input !== undefined) {
          try {
            stream.end(options.input);
          } catch (writeError) {
            settle(writeError instanceof Error ? writeError : new Error(`${label} input failed.`), true);
          }
        }
      });
    } catch (error) {
      settle(error instanceof Error ? error : new Error(`${label} failed.`), true);
    }
  });
}

export async function withSftpSession<T>(connectConfig: ConnectConfig, action: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return withSshClient(connectConfig, async (client) => {
    const sftp = await openSftpSession(client);

    try {
      return await action(sftp);
    } finally {
      closeSftpSession(sftp);
    }
  });
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function closeSshClient(client: Client | undefined): void {
  if (!client) {
    return;
  }

  try {
    client.end();
  } catch {
    // Best-effort cleanup only.
  }

  try {
    client.destroy();
  } catch {
    // Best-effort cleanup only.
  }
}

export function isLocalHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function normalizeSshError(message: string): string {
  const normalized = message.toLowerCase();

  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('refused') ||
    normalized.includes('econnrefused') ||
    normalized.includes('host unreachable') ||
    normalized.includes('enetunreach') ||
    normalized.includes('ehostunreach')
  ) {
    return 'SSH Connection Timeout or Refused';
  }

  if (normalized.includes('all configured authentication methods failed')) {
    return 'SSH Authentication Failed';
  }

  if (
    normalized.includes('decryption / authentication failure') ||
    normalized.includes('requires stored encrypted password fields')
  ) {
    return 'Decryption / Authentication failure';
  }

  return message || 'SSH Connection Timeout or Refused';
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function openSftpSession(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const onClientError = (error: Error) => {
      settle(error, true);
    };

    const settle = (error?: Error, destroyClient = false, sftp?: SFTPWrapper) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      client.removeListener('error', onClientError);

      if (destroyClient) {
        closeSshClient(client);
      }

      if (error) {
        reject(error);
      } else if (sftp) {
        sftp.on('error', ignoreBackgroundSshError);
        resolve(sftp);
      } else {
        reject(new Error('SFTP session failed.'));
      }
    };

    timer = setTimeout(() => {
      settle(new Error('SFTP session timed out.'), true);
    }, SSH_READY_TIMEOUT_MS);

    client.once('error', onClientError);

    try {
      client.sftp((error, sftp) => {
        if (error) {
          settle(error, true);
          return;
        }

        settle(undefined, false, sftp);
      });
    } catch (error) {
      settle(error instanceof Error ? error : new Error('SFTP session failed.'), true);
    }
  });
}

function closeSftpSession(sftp: SFTPWrapper | undefined): void {
  if (!sftp) {
    return;
  }

  try {
    sftp.end();
  } catch {
    // Best-effort cleanup only.
  }

  try {
    sftp.destroy();
  } catch {
    // Best-effort cleanup only.
  }
}

function ignoreBackgroundSshError(): void {
  // SSH streams can emit late errors during teardown. Active operations attach
  // their own listeners; this guard prevents process-level uncaught errors.
}
