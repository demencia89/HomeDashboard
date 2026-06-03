import type { OverviewSectionId, RefreshRate, ServerFormState } from './types';

export const overviewSectionLabels: Record<OverviewSectionId, string> = {
  filesystems: 'Filesystems',
  processes: 'Top Processes',
};

export const defaultOverviewSectionOrder: OverviewSectionId[] = ['filesystems', 'processes'];

export const refreshRateOptions: { label: string; value: RefreshRate }[] = [
  { label: 'Manual refresh', value: 0 },
  { label: '5 seconds', value: 5000 },
  { label: '10 seconds', value: 10000 },
  { label: '30 seconds', value: 30000 },
  { label: '1 minute', value: 60000 },
];

export const emptyForm: ServerFormState = {
  alias: '',
  host: '',
  port: '22',
  username: '',
  authMethod: 'password',
  password: '',
  privateKeyName: '',
  privateKey: '',
  serverIcon: '',
  serverIconColor: '',
};

export const METRICS_SESSION_KEY = 'homedashboard.metricsByServer.v1';
export const SERVER_VIEW_SESSION_KEY = 'homedashboard.serverViewByServer.v1';
