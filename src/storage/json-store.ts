import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultAppPreferences, mergeAppPreferencesPatch, normalizeAppPreferences, type AppPreferences } from '../types/preferences.js';
import type { CreateServerProfileBody, ServerProfile, UpdateServerProfileBody } from '../types/server-profile.js';
import { KeyStore } from './key-store.js';
import { encryptPassword } from '../utils/crypto.js';
import { parseStrictInteger } from '../utils/strict-integer.js';

interface DatabaseShape {
  servers: ServerProfile[];
  preferences: AppPreferences;
}

const EMPTY_DATABASE: DatabaseShape = { servers: [], preferences: defaultAppPreferences() };

export class JsonStore {
  private writeChain = Promise.resolve();

  constructor(
    private readonly databaseFile: string,
    private readonly keyStore: KeyStore,
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.databaseFile), { recursive: true });

    try {
      await fs.access(this.databaseFile);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        await this.writeDatabase(EMPTY_DATABASE);
        return;
      }

      throw error;
    }
  }

  async listServers(): Promise<ServerProfile[]> {
    const database = await this.readDatabase();
    return database.servers;
  }

  async getPreferences(): Promise<AppPreferences> {
    const database = await this.readDatabase();
    return database.preferences;
  }

  async replacePreferences(value: unknown): Promise<AppPreferences> {
    let preferences = defaultAppPreferences();

    await this.updateDatabase((database) => {
      preferences = normalizeAppPreferences(value);
      database.preferences = preferences;
    });

    return preferences;
  }

  async patchPreferences(value: unknown): Promise<AppPreferences> {
    let preferences = defaultAppPreferences();

    await this.updateDatabase((database) => {
      preferences = mergeAppPreferencesPatch(database.preferences, value);
      database.preferences = preferences;
    });

    return preferences;
  }

  async createServer(body: CreateServerProfileBody): Promise<ServerProfile> {
    const input = normalizeCreateServerBody(body);

    if (input.authMethod === 'privateKey') {
      if (input.privateKey) {
        await this.keyStore.save(input.privateKeyName, input.privateKey);
      } else if (!(await this.keyStore.exists(input.privateKeyName))) {
        throw new Error(`Private key "${input.privateKeyName}" was not found in the keys directory.`);
      }
    }

    const encryptedPassword = input.authMethod === 'password' && input.password ? encryptPassword(input.password) : undefined;
    const profile: ServerProfile = {
      id: randomUUID(),
      alias: input.alias,
      host: input.host,
      port: input.port,
      username: input.username,
      authMethod: input.authMethod,
      ...(input.authMethod === 'privateKey' ? { privateKeyName: input.privateKeyName } : {}),
      ...(input.serverIcon ? { serverIcon: input.serverIcon } : {}),
      ...(input.serverIconColor ? { serverIconColor: input.serverIconColor } : {}),
      ...(encryptedPassword
        ? {
            encryptedPassword: encryptedPassword.encryptedData,
            iv: encryptedPassword.iv,
            authTag: encryptedPassword.authTag,
          }
        : {}),
    };

    await this.updateDatabase((database) => {
      database.servers.push(profile);
    });

    return profile;
  }

  async deleteServer(id: string): Promise<boolean> {
    let deleted = false;

    await this.updateDatabase((database) => {
      const before = database.servers.length;
      database.servers = database.servers.filter((server) => server.id !== id);
      deleted = database.servers.length !== before;
    });

    return deleted;
  }

  async updateServer(id: string, body: UpdateServerProfileBody): Promise<ServerProfile | undefined> {
    const input = normalizeUpdateServerBody(body);
    let updated: ServerProfile | undefined;

    await this.updateDatabase(async (database) => {
      const index = database.servers.findIndex((server) => server.id === id);

      if (index === -1) {
        return;
      }

      const existing = database.servers[index];
      const nextAuthMethod = input.authMethod ?? existing.authMethod;
      const nextPrivateKeyName =
        input.privateKeyName ?? existing.privateKeyName ?? (nextAuthMethod === 'privateKey' ? `${aliasToKeyName(input.alias ?? existing.alias)}.key` : undefined);
      const nextServerIcon = input.serverIcon === undefined ? existing.serverIcon : input.serverIcon ?? undefined;
      const nextServerIconColor = input.serverIconColor === undefined ? existing.serverIconColor : input.serverIconColor ?? undefined;
      const canReuseStoredPassword = Boolean(existing.encryptedPassword && existing.iv && existing.authTag);

      if (nextAuthMethod === 'privateKey') {
        const keyName = requireValue(nextPrivateKeyName, 'privateKeyName');

        if (input.privateKey) {
          await this.keyStore.save(keyName, input.privateKey);
        } else if (!(await this.keyStore.exists(keyName))) {
          throw new Error(`Private key "${keyName}" was not found in the keys directory.`);
        }
      }

      if (nextAuthMethod === 'password' && !input.password && !canReuseStoredPassword) {
        throw new Error('password is required when changing authMethod to "password".');
      }

      const encryptedPassword = nextAuthMethod === 'password' && input.password ? encryptPassword(input.password) : undefined;

      updated = {
        id: existing.id,
        alias: input.alias ?? existing.alias,
        host: input.host ?? existing.host,
        port: input.port ?? existing.port,
        username: input.username ?? existing.username,
        authMethod: nextAuthMethod,
        ...(nextAuthMethod === 'privateKey' && nextPrivateKeyName ? { privateKeyName: nextPrivateKeyName } : {}),
        ...(nextServerIcon ? { serverIcon: nextServerIcon } : {}),
        ...(nextServerIconColor ? { serverIconColor: nextServerIconColor } : {}),
        ...(nextAuthMethod === 'password' && encryptedPassword
          ? {
              encryptedPassword: encryptedPassword.encryptedData,
              iv: encryptedPassword.iv,
              authTag: encryptedPassword.authTag,
            }
          : {}),
        ...(nextAuthMethod === 'password' && !encryptedPassword && existing.authMethod === 'password'
          ? {
              encryptedPassword: existing.encryptedPassword,
              iv: existing.iv,
              authTag: existing.authTag,
            }
          : {}),
      };

      database.servers[index] = updated;
    });

    return updated;
  }

  private async readDatabase(): Promise<DatabaseShape> {
    await this.init();
    const raw = await fs.readFile(this.databaseFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DatabaseShape>;

    return {
      servers: Array.isArray(parsed.servers) ? parsed.servers : [],
      preferences: normalizeAppPreferences(parsed.preferences),
    };
  }

  private async updateDatabase(mutator: (database: DatabaseShape) => void | Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      const database = await this.readDatabase();
      await mutator(database);
      await this.writeDatabase(database);
    });

    await this.writeChain;
  }

  private async writeDatabase(database: DatabaseShape): Promise<void> {
    await fs.mkdir(path.dirname(this.databaseFile), { recursive: true });
    const tempFile = `${this.databaseFile}.${process.pid}.${Date.now()}.tmp`;

    try {
      await fs.writeFile(tempFile, JSON.stringify(database, null, 2), { mode: 0o600 });
      await fs.rename(tempFile, this.databaseFile);
      await fs.chmod(this.databaseFile, 0o600);
    } catch (error) {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

interface NormalizedCreateServerBody {
  alias: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'privateKey';
  privateKeyName: string;
  serverIcon?: string;
  serverIconColor?: string;
  privateKey?: string;
  password?: string;
}

interface NormalizedUpdateServerBody {
  alias?: string;
  host?: string;
  port?: number;
  username?: string;
  authMethod?: 'password' | 'privateKey';
  privateKeyName?: string;
  serverIcon?: string | null;
  serverIconColor?: string | null;
  privateKey?: string;
  password?: string;
}

function normalizeCreateServerBody(body: CreateServerProfileBody): NormalizedCreateServerBody {
  const alias = requireString(body.alias, 'alias');
  const host = requireString(body.host, 'host');
  const username = requireString(body.username, 'username');
  const authMethod = requireAuthMethod(body.authMethod);
  const port = normalizePort(body.port);
  const privateKey = optionalString(body.privateKey, 'privateKey');
  const password = optionalSecretString(body.password, 'password');
  const privateKeyName = optionalString(body.privateKeyName, 'privateKeyName') ?? `${aliasToKeyName(alias)}.key`;
  const serverIcon = normalizeServerIcon(body.serverIcon, 'serverIcon');
  const serverIconColor = normalizeServerIconColor(body.serverIconColor, 'serverIconColor');

  if (authMethod === 'password' && privateKey) {
    throw new Error('privateKey can only be supplied when authMethod is "privateKey".');
  }

  if (authMethod === 'password' && !password) {
    throw new Error('password is required when authMethod is "password".');
  }

  if (authMethod === 'privateKey' && password) {
    throw new Error('password can only be supplied when authMethod is "password".');
  }

  if (authMethod === 'privateKey' && !privateKeyName) {
    throw new Error('privateKeyName is required when authMethod is "privateKey".');
  }

  return { alias, host, port, username, authMethod, privateKeyName, serverIcon, serverIconColor, privateKey, password };
}

function normalizeUpdateServerBody(body: UpdateServerProfileBody): NormalizedUpdateServerBody {
  const alias = optionalString(body.alias, 'alias');
  const host = optionalString(body.host, 'host');
  const username = optionalString(body.username, 'username');
  const authMethod = body.authMethod === undefined || body.authMethod === null ? undefined : requireAuthMethod(body.authMethod);
  const port = body.port === undefined || body.port === null ? undefined : normalizePort(body.port);
  const privateKey = optionalString(body.privateKey, 'privateKey');
  const password = optionalSecretString(body.password, 'password');
  const privateKeyName = optionalString(body.privateKeyName, 'privateKeyName');
  const serverIcon = body.serverIcon === undefined || body.serverIcon === null ? undefined : normalizeServerIcon(body.serverIcon, 'serverIcon') ?? null;
  const serverIconColor = body.serverIconColor === undefined || body.serverIconColor === null ? undefined : normalizeServerIconColor(body.serverIconColor, 'serverIconColor') ?? null;

  if (authMethod === 'password' && privateKey) {
    throw new Error('privateKey can only be supplied when authMethod is "privateKey".');
  }

  if (authMethod === 'privateKey' && password) {
    throw new Error('password can only be supplied when authMethod is "password".');
  }

  if (!alias && !host && !username && authMethod === undefined && port === undefined && !privateKey && !password && !privateKeyName && serverIcon === undefined && serverIconColor === undefined) {
    throw new Error('At least one server profile field must be supplied.');
  }

  return { alias, host, port, username, authMethod, privateKeyName, serverIcon, serverIconColor, privateKey, password };
}

function normalizePort(value: unknown): number {
  return parseStrictInteger(value, 'port', { min: 1, max: 65535, defaultValue: 22 });
}

function requireAuthMethod(value: unknown): 'password' | 'privateKey' {
  if (value === 'password' || value === 'privateKey') {
    return value;
  }

  throw new Error('authMethod must be either "password" or "privateKey".');
}

function requireString(value: unknown, field: string): string {
  const normalized = optionalString(value, field);

  if (!normalized) {
    throw new Error(`${field} is required.`);
  }

  return normalized;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string.`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalSecretString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string.`);
  }

  return value.length > 0 ? value : undefined;
}

const SERVER_ICON_IDS = new Set([
  'server',
  'circuit-board',
  'smartphone',
  'monitor',
  'laptop',
  'cpu',
  'memory',
  'hard-drive',
  'database',
  'container',
  'box',
  'router',
  'wifi',
  'radio-tower',
  'network',
  'shield',
  'gauge',
  'home',
  'cloud',
  'globe',
  'microchip',
  'server-cog',
  'terminal',
  'package',
]);

const SERVER_ICON_COLOR_IDS = new Set([
  'slate',
  'sky',
  'teal',
  'green',
  'amber',
  'rose',
  'violet',
  'cyan',
]);

function normalizeServerIcon(value: unknown, field: string): string | undefined {
  const normalized = optionalString(value, field);

  if (!normalized) {
    return undefined;
  }

  if (!SERVER_ICON_IDS.has(normalized)) {
    throw new Error(`${field} must be one of: ${[...SERVER_ICON_IDS].join(', ')}.`);
  }

  return normalized;
}

function normalizeServerIconColor(value: unknown, field: string): string | undefined {
  const normalized = optionalString(value, field);

  if (!normalized) {
    return undefined;
  }

  if (!SERVER_ICON_COLOR_IDS.has(normalized)) {
    throw new Error(`${field} must be one of: ${[...SERVER_ICON_COLOR_IDS].join(', ')}.`);
  }

  return normalized;
}

function aliasToKeyName(alias: string): string {
  return alias.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

function requireValue<T>(value: T | undefined, field: string): T {
  if (value === undefined) {
    throw new Error(`${field} is required.`);
  }

  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
