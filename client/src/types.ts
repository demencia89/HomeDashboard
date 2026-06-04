export type AuthMethod = 'password' | 'privateKey';
export type ServerIconId = 'server' | 'circuit-board' | 'smartphone' | 'monitor' | 'laptop' | 'cpu' | 'memory' | 'hard-drive' | 'database' | 'container' | 'box' | 'router' | 'wifi' | 'radio-tower' | 'network' | 'shield' | 'gauge' | 'home' | 'cloud' | 'globe' | 'microchip' | 'server-cog' | 'terminal' | 'package';
export type ServerIconColorId = 'slate' | 'sky' | 'teal' | 'green' | 'amber' | 'rose' | 'violet' | 'cyan';
export type AppTheme = 'neo' | 'minimal' | 'dracula' | 'catppuccin' | 'solarized' | 'nord' | 'gruvbox' | 'tokyo-night' | 'one-dark';
export type RefreshRate = 0 | 5000 | 10000 | 30000 | 60000;
export type FleetMetricMode = 'bars' | 'gauges';
export type ActiveView = 'overview' | 'containers' | 'files' | 'terminal' | 'services' | 'vnc';
export type OverviewSectionId = 'filesystems' | 'processes';
export type DockerContainerAction = 'start' | 'stop' | 'restart';
export type SystemdServiceAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable';
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

export interface ServerProfile {
  id: string;
  alias: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyName?: string;
  serverIcon?: ServerIconId;
  serverIconColor?: ServerIconColorId;
  hasPassword: boolean;
}

export interface SystemMetrics {
  online: boolean;
  cpuUsage: number;
  uptimeSeconds: number;
  memory: { total: number; used: number; free: number };
  disk: DiskMetric[];
  temperature: TemperatureMetric | null;
  diskIo: ThroughputMetric;
  network: NetworkMetric;
  processes: ProcessMetric[];
  containers: ContainerMetric[];
  containerError?: string;
  error?: string;
}

export interface TemperatureMetric {
  label: string;
  celsius: number;
}

export interface TemperatureSnapshot {
  ok: boolean;
  collectedAt: string;
  readings: TemperatureReading[];
  summary: TemperatureSummary;
  error?: string;
}

export interface TemperatureReading {
  source: string;
  label: string;
  celsius: number;
  maxCelsius?: number;
  criticalCelsius?: number;
  status?: string;
  path?: string;
}

export interface TemperatureSummary {
  count: number;
  hottest?: TemperatureReading;
  averageCelsius?: number;
}

export interface ThroughputMetric {
  readBytesPerSecond: number;
  writeBytesPerSecond: number;
}

export interface NetworkMetric {
  receiveBytesPerSecond: number;
  transmitBytesPerSecond: number;
}

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

export interface DiskMetric {
  mount: string;
  total: string;
  used: string;
  available: string;
  percentage: number;
}

export interface ProcessMetric {
  pid: number;
  command: string;
  cpu: number;
  memory: number;
}

export interface ContainerMetric {
  id: string;
  name: string;
  image: string;
  status: string;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'created' | 'unknown';
  ports: string;
  composeProject?: string;
  composeService?: string;
  composeWorkingDir?: string;
  composeConfigFiles?: string[];
}

export interface SystemdServiceUnit {
  name: string;
  scope: 'system' | 'user';
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string;
  description: string;
}

export interface SystemdServicesResponse {
  services: SystemdServiceUnit[];
}

export interface VncServiceCandidate {
  name: string;
  scope: 'system' | 'user';
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string;
  description: string;
}

export interface VncListener {
  host: string;
  port: number;
  process: string;
}

export interface VncStatusResponse {
  ok: boolean;
  services: VncServiceCandidate[];
  graphicalServices: VncServiceCandidate[];
  listeners: VncListener[];
  preferredHost: string;
  preferredPort: number;
  error?: string;
}

export interface VncSetupCommands {
  install: string;
  service: string;
  full: string;
}

export interface VncSetupInfo {
  ok: boolean;
  supported: boolean;
  backend: 'wayvnc' | 'x11vnc';
  packageManager: 'apt' | 'dnf' | 'yum' | 'pacman' | 'apk' | 'unsupported';
  serviceName: string;
  sessionType: string;
  desktop: string;
  commands: VncSetupCommands;
  notes: string[];
  error?: string;
}

export interface VncInstallResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface ContainerLogsState {
  serverId: string;
  containerId: string;
  containerName: string;
  logs: string;
}

export interface ContainerComposeState {
  serverId: string;
  containerId: string;
  containerName: string;
  serverAlias: string;
  loading: boolean;
  saving: boolean;
  content: string;
  originalContent: string;
  composeFile?: string;
  workingDir?: string;
  project?: string;
  service?: string;
  message?: string;
  error?: string;
}

export interface DockerComposeFileResponse {
  ok: boolean;
  containerId: string;
  composeFile?: string;
  workingDir?: string;
  project?: string;
  service?: string;
  content?: string;
  output?: string;
  error?: string;
}

export interface ConnectionTestResult {
  online: boolean;
  latencyMs: number;
  hostname?: string;
  username?: string;
  os?: string;
  shell?: string;
  authMethod?: AuthMethod;
  error?: string;
}

export interface FileItem {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  permissions: string;
  modifyTime: number;
}

export interface FileListResponse {
  path: string;
  items: FileItem[];
}

export interface ServerFormState {
  alias: string;
  host: string;
  port: string;
  username: string;
  authMethod: AuthMethod;
  password: string;
  privateKeyName: string;
  privateKey: string;
  serverIcon: '' | ServerIconId;
  serverIconColor: '' | ServerIconColorId;
}
