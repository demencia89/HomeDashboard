import { createRequire } from 'node:module';
import {
  APP_BUILD_DATE,
  APP_REVISION,
  APP_UPDATE_CHECK_DISABLED,
  APP_UPDATE_CHECK_INTERVAL_MS,
  APP_UPDATE_CHECK_URL,
  APP_UPDATE_URL,
  APP_VERSION,
} from '../config.js';

export interface AppVersionInfo {
  name: 'HomeDashboard';
  currentVersion: string;
  revision?: string;
  buildDate?: string;
  update: AppUpdateInfo;
}

export interface AppUpdateInfo {
  enabled: boolean;
  available: boolean;
  latestVersion?: string;
  releaseUrl: string;
  checkedAt?: string;
  error?: string;
}

interface LatestVersionInfo {
  version: string;
  releaseUrl?: string;
}

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version?: unknown };
const fallbackVersion = typeof packageJson.version === 'string' && packageJson.version.trim() ? packageJson.version.trim() : '0.0.0';

let cachedUpdate: { expiresAt: number; update: AppUpdateInfo } | undefined;

export async function getAppVersionInfo(forceUpdateCheck = false): Promise<AppVersionInfo> {
  const currentVersion = APP_VERSION || fallbackVersion;

  return {
    name: 'HomeDashboard',
    currentVersion,
    revision: APP_REVISION || undefined,
    buildDate: APP_BUILD_DATE || undefined,
    update: await getUpdateInfo(currentVersion, forceUpdateCheck),
  };
}

async function getUpdateInfo(currentVersion: string, forceUpdateCheck: boolean): Promise<AppUpdateInfo> {
  const releaseUrl = APP_UPDATE_URL;

  if (APP_UPDATE_CHECK_DISABLED || !APP_UPDATE_CHECK_URL) {
    return {
      enabled: false,
      available: false,
      releaseUrl,
    };
  }

  const now = Date.now();

  if (!forceUpdateCheck && cachedUpdate && cachedUpdate.expiresAt > now) {
    return cachedUpdate.update;
  }

  const checkedAt = new Date(now).toISOString();

  try {
    const latest = await fetchLatestVersion();
    const latestVersion = latest.version;
    const comparison = compareVersions(latestVersion, currentVersion);
    const available = comparison === null
      ? normalizeVersionLabel(latestVersion) !== normalizeVersionLabel(currentVersion)
      : comparison > 0;
    const update: AppUpdateInfo = {
      enabled: true,
      available,
      latestVersion,
      releaseUrl: latest.releaseUrl ?? releaseUrl,
      checkedAt,
    };

    cachedUpdate = {
      expiresAt: now + APP_UPDATE_CHECK_INTERVAL_MS,
      update,
    };

    return update;
  } catch {
    const update: AppUpdateInfo = {
      enabled: true,
      available: false,
      releaseUrl,
      checkedAt,
      error: 'Update check unavailable.',
    };

    cachedUpdate = {
      expiresAt: now + Math.min(APP_UPDATE_CHECK_INTERVAL_MS, 15 * 60_000),
      update,
    };

    return update;
  }
}

async function fetchLatestVersion(): Promise<LatestVersionInfo> {
  const response = await fetch(APP_UPDATE_CHECK_URL, {
    headers: {
      accept: 'application/json',
      'user-agent': 'HomeDashboard update checker',
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error('Update endpoint returned an error.');
  }

  const body = await response.json() as unknown;
  const latest = parseLatestVersionInfo(body);

  if (!latest) {
    throw new Error('Update endpoint did not include a version.');
  }

  return latest;
}

function parseLatestVersionInfo(body: unknown): LatestVersionInfo | undefined {
  if (Array.isArray(body)) {
    const first = body[0];
    return first && typeof first === 'object' ? parseLatestVersionInfo(first) : undefined;
  }

  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const record = body as Record<string, unknown>;
  const version = readFirstString(record, ['version', 'latestVersion', 'tag_name', 'name']);

  if (!version) {
    return undefined;
  }

  return {
    version,
    releaseUrl: readFirstString(record, ['releaseUrl', 'html_url', 'url']),
  };
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function compareVersions(left: string, right: string): number | null {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);

  if (!leftParts || !rightParts) {
    return null;
  }

  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function parseVersionParts(value: string): [number, number, number] | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(value.trim());

  if (!match) {
    return undefined;
  }

  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2] ?? '0', 10),
    Number.parseInt(match[3] ?? '0', 10),
  ];
}

function normalizeVersionLabel(value: string): string {
  return value.trim().replace(/^v/i, '').toLowerCase();
}
