import path from 'node:path';
import { parseStrictInteger } from './utils/strict-integer.js';

export const CONFIG_DIR = path.resolve(readStringEnv('CONFIG_DIR', '/config'));
export const DATABASE_FILE = path.resolve(readStringEnv('DATABASE_FILE', path.join(CONFIG_DIR, 'servers.json')));
export const KEYS_DIR = path.resolve(readStringEnv('KEYS_DIR', path.join(CONFIG_DIR, 'keys')));
export const LOCAL_FILE_ROOT = path.resolve(readStringEnv('LOCAL_FILE_ROOT', path.join(CONFIG_DIR, 'files')));
export const HOST = readStringEnv('HOST', '0.0.0.0');
export const PORT = readPortEnv('PORT', 3000);
export const CORS_ORIGIN = readCorsOrigins(process.env.CORS_ORIGIN);
export const AUTH_DISABLED = readBooleanEnv('AUTH_DISABLED', false);
export const AUTH_USERNAME = readStringEnv('AUTH_USERNAME');
export const AUTH_PASSWORD = readStringEnv('AUTH_PASSWORD');
export const AUTH_FAILURE_RATE_LIMIT_MAX = readIntegerEnv('AUTH_FAILURE_RATE_LIMIT_MAX', 20, 0, 10_000);
export const AUTH_FAILURE_RATE_LIMIT_WINDOW_MS = readIntegerEnv('AUTH_FAILURE_RATE_LIMIT_WINDOW_MS', 5 * 60_000, 1_000, 24 * 60 * 60_000);
export const EXPENSIVE_HTTP_RATE_LIMIT_MAX = readIntegerEnv('EXPENSIVE_HTTP_RATE_LIMIT_MAX', 180, 0, 100_000);
export const EXPENSIVE_HTTP_RATE_LIMIT_WINDOW_MS = readIntegerEnv('EXPENSIVE_HTTP_RATE_LIMIT_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60_000);
export const WS_CONNECTION_RATE_LIMIT_MAX = readIntegerEnv('WS_CONNECTION_RATE_LIMIT_MAX', 60, 0, 100_000);
export const WS_CONNECTION_RATE_LIMIT_WINDOW_MS = readIntegerEnv('WS_CONNECTION_RATE_LIMIT_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60_000);
export const WS_MAX_CONNECTIONS_PER_IP = readIntegerEnv('WS_MAX_CONNECTIONS_PER_IP', 12, 0, 10_000);
export const WS_MESSAGE_RATE_LIMIT_MAX = readIntegerEnv('WS_MESSAGE_RATE_LIMIT_MAX', 2400, 0, 1_000_000);
export const WS_MESSAGE_RATE_LIMIT_WINDOW_MS = readIntegerEnv('WS_MESSAGE_RATE_LIMIT_WINDOW_MS', 60_000, 1_000, 24 * 60 * 60_000);
export const VNC_ALLOWED_PORTS = readStringEnv('VNC_ALLOWED_PORTS', '5900-5999');
export const VNC_ALLOWED_HOSTS = readStringEnv('VNC_ALLOWED_HOSTS');

if (!AUTH_DISABLED && (!AUTH_USERNAME || !AUTH_PASSWORD)) {
  throw new Error('AUTH_USERNAME and AUTH_PASSWORD must be set, or set AUTH_DISABLED=true for an explicitly unauthenticated deployment.');
}

function readStringEnv(name: string, defaultValue = ''): string {
  const value = process.env[name];
  return value === undefined ? defaultValue : value.trim();
}

function readPortEnv(name: string, defaultValue: number): number {
  const raw = readStringEnv(name, String(defaultValue));
  return parseStrictInteger(raw, name, { min: 1, max: 65535 });
}

function readIntegerEnv(name: string, defaultValue: number, min: number, max: number): number {
  const raw = readStringEnv(name, String(defaultValue));
  return parseStrictInteger(raw, name, { min, max });
}

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be a boolean value.`);
}

function readCorsOrigins(value: string | undefined): boolean | string[] {
  if (!value?.trim()) {
    return false;
  }

  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return origins.length > 0 ? origins : false;
}
