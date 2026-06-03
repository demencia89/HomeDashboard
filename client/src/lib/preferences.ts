import { defaultOverviewSectionOrder } from '../constants';
import type { AppPreferences, AppTheme, ContainerPreferences, OverviewSectionId, OverviewSectionPreferences, RefreshRate } from '../types';

const APP_THEMES: AppTheme[] = ['neo', 'minimal', 'solarized', 'nord', 'gruvbox', 'tokyo-night', 'one-dark', 'dracula', 'catppuccin'];

export const APP_THEME_LABELS: Record<AppTheme, string> = {
  neo: 'Neo',
  minimal: 'Minimal',
  solarized: 'Solarized',
  nord: 'Nord',
  gruvbox: 'Gruvbox',
  'tokyo-night': 'Tokyo Night',
  'one-dark': 'One Dark',
  dracula: 'Dracula',
  catppuccin: 'Catppuccin',
};

export const APP_THEMES_ORDER: AppTheme[] = APP_THEMES;

export function defaultAppPreferences(): AppPreferences {
  return {
    version: 1,
    theme: 'neo',
    sidebarCollapsed: false,
    serverOrder: [],
    serverRefreshRate: 5000,
    fleetRefreshRate: 10000,
    fleetMetricMode: 'bars',
    userMountsOnlyByServer: {},
    defaultDiskMountByServer: {},
    overviewSectionsByServer: {},
    defaultTemperatureReadingByServer: {},
    containers: defaultContainerPreferences(),
  };
}

export function defaultContainerPreferences(): ContainerPreferences {
  return {
    urlOverrides: {},
    iconOverrides: {},
    viewMode: 'table',
    appOrderByContext: {},
    hiddenByContainer: {},
  };
}

export async function fetchPreferences(): Promise<AppPreferences> {
  const response = await fetch('/api/preferences');
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body?.message ?? 'Unable to load preferences.');
  }

  return normalizeAppPreferences(body);
}

export async function savePreferences(preferences: AppPreferences): Promise<AppPreferences> {
  const response = await fetch('/api/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(preferences),
  });
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body?.message ?? 'Unable to save preferences.');
  }

  return normalizeAppPreferences(body);
}

export function normalizeAppPreferences(value: unknown): AppPreferences {
  const source = isRecord(value) ? value : {};
  const containers = isRecord(source.containers) ? source.containers : {};

  return {
    version: 1,
    theme: isAppTheme(source.theme) ? source.theme : 'neo',
    sidebarCollapsed: source.sidebarCollapsed === true,
    serverOrder: normalizeStringArray(source.serverOrder),
    serverRefreshRate: normalizeRefreshRate(source.serverRefreshRate),
    fleetRefreshRate: normalizeRefreshRate(source.fleetRefreshRate),
    fleetMetricMode: source.fleetMetricMode === 'gauges' ? 'gauges' : 'bars',
    userMountsOnlyByServer: normalizeBooleanRecord(source.userMountsOnlyByServer),
    defaultDiskMountByServer: normalizeStringRecord(source.defaultDiskMountByServer),
    overviewSectionsByServer: normalizeOverviewSectionsByServer(source.overviewSectionsByServer),
    defaultTemperatureReadingByServer: normalizeStringRecord(source.defaultTemperatureReadingByServer),
    containers: {
      urlOverrides: normalizeStringRecord(containers.urlOverrides),
      iconOverrides: normalizeStringRecord(containers.iconOverrides),
      viewMode: containers.viewMode === 'apps' ? 'apps' : 'table',
      appOrderByContext: normalizeStringArrayRecord(containers.appOrderByContext),
      hiddenByContainer: normalizeBooleanRecord(containers.hiddenByContainer),
    },
  };
}

export function updateContainerPreferences(
  preferences: AppPreferences,
  update: (current: ContainerPreferences) => ContainerPreferences,
): AppPreferences {
  return {
    ...preferences,
    containers: normalizeAppPreferences({ containers: update(preferences.containers) }).containers,
  };
}

function normalizeStringArrayRecord(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key.trim(), normalizeStringArray(item)] as const)
      .filter(([key, item]) => Boolean(key) && item.length > 0),
  );
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => Boolean(entry[0].trim()) && typeof entry[1] === 'string' && Boolean(entry[1].trim())),
  );
}

function normalizeBooleanRecord(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, boolean] => Boolean(entry[0].trim()) && typeof entry[1] === 'boolean'),
  );
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const values = value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
  return values.filter((item, index) => values.indexOf(item) === index);
}

function normalizeRefreshRate(value: unknown): RefreshRate {
  if (value === 500 || value === 1000 || value === 2000 || value === 5000) {
    return 5000;
  }

  if (value === 10000 || value === 30000 || value === 60000) {
    return value;
  }

  return 0;
}

function normalizeOverviewSectionsByServer(value: unknown): Record<string, OverviewSectionPreferences> {
  if (!isRecord(value) || 'order' in value || 'hidden' in value) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([serverId, preferences]) => [serverId.trim(), normalizeOverviewSectionPreferences(preferences)] as const)
      .filter(([serverId]) => Boolean(serverId)),
  );
}

function normalizeOverviewSectionPreferences(value: unknown): OverviewSectionPreferences {
  const source = isRecord(value) ? value : {};
  const order = Array.isArray(source.order) ? source.order.filter(isOverviewSectionId) : [];
  const hidden = Array.isArray(source.hidden) ? source.hidden.filter(isOverviewSectionId) : [];

  return {
    order: uniqueSectionIds([...order, ...defaultOverviewSectionOrder]),
    hidden: uniqueSectionIds(hidden),
  };
}

function uniqueSectionIds(sectionIds: OverviewSectionId[]): OverviewSectionId[] {
  return sectionIds.filter((sectionId, index) => sectionIds.indexOf(sectionId) === index);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAppTheme(value: unknown): value is AppTheme {
  return APP_THEMES.includes(value as AppTheme);
}

function isOverviewSectionId(value: unknown): value is OverviewSectionId {
  return value === 'filesystems' || value === 'processes';
}
