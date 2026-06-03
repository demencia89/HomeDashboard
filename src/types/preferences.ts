export type AppTheme = 'neo' | 'minimal' | 'dracula' | 'catppuccin' | 'solarized' | 'nord' | 'gruvbox' | 'tokyo-night' | 'one-dark';
export type RefreshRate = 0 | 5000 | 10000 | 30000 | 60000;
export type FleetMetricMode = 'bars' | 'gauges';
export type OverviewSectionId = 'filesystems' | 'processes';
export type ContainerViewMode = 'table' | 'apps';

export interface OverviewSectionPreferences {
  order: OverviewSectionId[];
  hidden: OverviewSectionId[];
}

export interface ContainerPreferences {
  urlOverrides: Record<string, string>;
  iconOverrides: Record<string, string>;
  viewMode: ContainerViewMode;
  appOrderByContext: Record<string, string[]>;
  hiddenByContainer: Record<string, boolean>;
}

export interface AppPreferences {
  version: 1;
  theme: AppTheme;
  sidebarCollapsed: boolean;
  serverOrder: string[];
  serverRefreshRate: RefreshRate;
  fleetRefreshRate: RefreshRate;
  fleetMetricMode: FleetMetricMode;
  userMountsOnlyByServer: Record<string, boolean>;
  defaultDiskMountByServer: Record<string, string>;
  overviewSectionsByServer: Record<string, OverviewSectionPreferences>;
  defaultTemperatureReadingByServer: Record<string, string>;
  containers: ContainerPreferences;
}

const APP_THEMES: AppTheme[] = ['neo', 'minimal', 'solarized', 'nord', 'gruvbox', 'tokyo-night', 'one-dark', 'dracula', 'catppuccin'];
const DEFAULT_OVERVIEW_SECTION_ORDER: OverviewSectionId[] = ['filesystems', 'processes'];

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
    containers: {
      urlOverrides: {},
      iconOverrides: {},
      viewMode: 'table',
      appOrderByContext: {},
      hiddenByContainer: {},
    },
  };
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

export function mergeAppPreferencesPatch(current: AppPreferences, patch: unknown): AppPreferences {
  return normalizeAppPreferences(deepMerge(current, patch));
}

function deepMerge(current: unknown, patch: unknown): unknown {
  if (!isRecord(current) || !isRecord(patch)) {
    return patch;
  }

  const merged: Record<string, unknown> = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    merged[key] = isRecord(value) && isRecord(merged[key]) ? deepMerge(merged[key], value) : value;
  }

  return merged;
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
  if (!isRecord(value)) {
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
    order: uniqueSectionIds([...order, ...DEFAULT_OVERVIEW_SECTION_ORDER]),
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
