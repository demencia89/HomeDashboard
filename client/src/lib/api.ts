import type { AppVersionInfo, AppWallpaperInfo, DockerComposeFileResponse, DockerContainerAction, NethogsSnapshot, ServerFormState, SystemdServiceAction, SystemdServicesResponse, SystemdServiceUnit, VncInstallResult, VncServiceCandidate, VncSetupInfo, VncStatusResponse } from '../types';

export function buildPayload(form: ServerFormState) {
  return {
    alias: form.alias.trim(),
    host: form.host.trim(),
    port: form.port.trim(),
    username: form.username.trim(),
    authMethod: form.authMethod,
    serverIcon: form.serverIcon,
    serverIconColor: form.serverIconColor,
    ...(form.authMethod === 'password' && form.password ? { password: form.password } : {}),
    ...(form.authMethod === 'privateKey' && form.privateKeyName.trim() ? { privateKeyName: form.privateKeyName.trim() } : {}),
    ...(form.authMethod === 'privateKey' && form.privateKey ? { privateKey: form.privateKey } : {}),
  };
}

export async function killProcess(serverId: string, pid: number) {
  const response = await fetch('/api/servers/' + serverId + '/processes/' + pid + '/kill', {
    method: 'POST',
  });
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new Error(body?.message ?? 'Unable to kill process.');
  }
}

export async function controlContainer(serverId: string, containerId: string, action: DockerContainerAction) {
  const response = await fetch('/api/servers/' + serverId + '/containers/' + encodeURIComponent(containerId) + '/' + action, {
    method: 'POST',
  });
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new Error(body?.message ?? 'Unable to control Docker container.');
  }
}

export async function fetchAppVersion(options: { refresh?: boolean } = {}): Promise<AppVersionInfo> {
  const response = await fetch(`/api/app/version${options.refresh ? '?refresh=true' : ''}`);
  const body = (await response.json().catch(() => undefined)) as AppVersionInfo | { message?: string } | undefined;

  if (!response.ok) {
    throw new Error(body && 'message' in body ? body.message ?? 'Unable to read app version.' : 'Unable to read app version.');
  }

  return normalizeAppVersionInfo(body);
}

export async function fetchAppWallpaper(): Promise<AppWallpaperInfo> {
  const response = await fetch('/api/app/wallpaper');
  const body = (await response.json().catch(() => undefined)) as AppWallpaperInfo | { message?: string } | undefined;

  if (!response.ok) {
    throw new Error(body && 'message' in body ? body.message ?? 'Unable to read wallpaper.' : 'Unable to read wallpaper.');
  }

  return normalizeAppWallpaperInfo(body);
}

export async function saveAppWallpaper(dataUrl: string): Promise<AppWallpaperInfo> {
  const response = await fetch('/api/app/wallpaper', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  const body = (await response.json().catch(() => undefined)) as AppWallpaperInfo | { message?: string } | undefined;

  if (!response.ok) {
    throw new Error(body && 'message' in body ? body.message ?? 'Unable to save wallpaper.' : 'Unable to save wallpaper.');
  }

  return normalizeAppWallpaperInfo(body);
}

export async function getContainerLogs(serverId: string, containerId: string): Promise<string> {
  const response = await fetch('/api/servers/' + serverId + '/containers/' + encodeURIComponent(containerId) + '/logs?tail=200');
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new Error(body?.message ?? 'Unable to read Docker container logs.');
  }

  return typeof body?.logs === 'string' ? body.logs : '';
}

export async function getContainerCompose(serverId: string, containerId: string): Promise<DockerComposeFileResponse> {
  const response = await fetch('/api/servers/' + serverId + '/containers/' + encodeURIComponent(containerId) + '/compose');
  const body = (await response.json().catch(() => undefined)) as DockerComposeFileResponse | { message?: string } | undefined;

  if (!response.ok) {
    throw new Error(body && 'message' in body ? body.message ?? 'Unable to read Docker Compose file.' : 'Unable to read Docker Compose file.');
  }

  return normalizeComposeResponse(body);
}

export async function saveContainerCompose(serverId: string, containerId: string, content: string): Promise<DockerComposeFileResponse> {
  const response = await fetch('/api/servers/' + serverId + '/containers/' + encodeURIComponent(containerId) + '/compose', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  const body = (await response.json().catch(() => undefined)) as DockerComposeFileResponse | { message?: string } | undefined;

  if (!response.ok) {
    throw new Error(body && 'message' in body ? body.message ?? 'Unable to update Docker Compose file.' : 'Unable to update Docker Compose file.');
  }

  return normalizeComposeResponse(body);
}

export async function getNethogsSnapshot(serverId: string): Promise<NethogsSnapshot> {
  const response = await fetch('/api/servers/' + serverId + '/network/nethogs');
  const body = (await response.json().catch(() => undefined)) as NethogsSnapshot | { message?: string } | undefined;

  if (!response.ok) {
    throw new Error(body && 'message' in body ? body.message ?? 'Unable to read nethogs output.' : 'Unable to read nethogs output.');
  }

  return {
    ok: Boolean((body as NethogsSnapshot | undefined)?.ok),
    output: typeof (body as NethogsSnapshot | undefined)?.output === 'string' ? (body as NethogsSnapshot).output : '',
    collectedAt: typeof (body as NethogsSnapshot | undefined)?.collectedAt === 'string' ? (body as NethogsSnapshot).collectedAt : '',
    rows: Array.isArray((body as NethogsSnapshot | undefined)?.rows) ? (body as NethogsSnapshot).rows : [],
    totals: (body as NethogsSnapshot | undefined)?.totals ?? { sentKbPerSecond: 0, receivedKbPerSecond: 0 },
    version: typeof (body as NethogsSnapshot | undefined)?.version === 'string' ? (body as NethogsSnapshot).version : undefined,
    error: typeof (body as NethogsSnapshot | undefined)?.error === 'string' ? (body as NethogsSnapshot).error : undefined,
  };
}

export async function listSystemdServices(serverId: string, includeUser = false, forceRefresh = false): Promise<SystemdServiceUnit[]> {
  const params = new URLSearchParams();

  if (includeUser) {
    params.set('includeUser', 'true');
  }

  if (forceRefresh) {
    params.set('refresh', 'true');
  }

  const query = params.toString();
  const response = await fetch('/api/servers/' + serverId + '/services' + (query ? `?${query}` : ''));
  const body = (await response.json().catch(() => undefined)) as SystemdServicesResponse | { message?: string } | undefined;

  if (!response.ok) {
    throw new Error(body && 'message' in body ? body.message ?? 'Unable to list systemd services.' : 'Unable to list systemd services.');
  }

  return Array.isArray((body as SystemdServicesResponse | undefined)?.services)
    ? (body as SystemdServicesResponse).services.map((service) => ({
      ...service,
      scope: service.scope === 'user' ? 'user' : 'system',
    }))
    : [];
}

export async function controlSystemdService(serverId: string, serviceName: string, action: SystemdServiceAction, scope: 'system' | 'user' = 'system'): Promise<void> {
  const response = await fetch('/api/servers/' + serverId + '/services/' + encodeURIComponent(serviceName) + '/' + action + '?scope=' + scope, {
    method: 'POST',
  });
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new Error(body?.message ?? 'Unable to control systemd service.');
  }
}

export async function getVncStatus(serverId: string): Promise<VncStatusResponse> {
  const response = await fetch('/api/servers/' + serverId + '/vnc/status');
  const body = (await response.json().catch(() => undefined)) as VncStatusResponse | { message?: string } | undefined;

  if (!response.ok) {
    throw new Error(body && 'message' in body ? body.message ?? 'Unable to read VNC status.' : 'Unable to read VNC status.');
  }

  return normalizeVncStatusResponse(body);
}

export async function controlVncService(serverId: string, serviceName: string, action: SystemdServiceAction, scope: 'system' | 'user' = 'system'): Promise<void> {
  const response = await fetch('/api/servers/' + serverId + '/vnc/services/' + encodeURIComponent(serviceName) + '/' + action + '?scope=' + scope, {
    method: 'POST',
  });
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new Error(body?.message ?? 'Unable to control VNC service.');
  }
}

export async function getVncSetup(serverId: string): Promise<VncSetupInfo> {
  const response = await fetch('/api/servers/' + serverId + '/vnc/setup');
  const body = (await response.json().catch(() => undefined)) as VncSetupInfo | { message?: string } | undefined;

  if (!response.ok) {
    throw new Error(body && 'message' in body ? body.message ?? 'Unable to read VNC setup options.' : 'Unable to read VNC setup options.');
  }

  return normalizeVncSetupInfo(body);
}

export async function installVnc(serverId: string): Promise<VncInstallResult> {
  const response = await fetch('/api/servers/' + serverId + '/vnc/install', {
    method: 'POST',
  });
  const body = (await response.json().catch(() => undefined)) as VncInstallResult | { message?: string; output?: string } | undefined;

  if (!response.ok) {
    const message = body && 'message' in body ? body.message ?? 'Unable to install VNC.' : 'Unable to install VNC.';
    const output = body && 'output' in body && typeof body.output === 'string' && body.output.trim() ? `\n${body.output.trim()}` : '';
    throw new Error(`${message}${output}`);
  }

  return {
    ok: Boolean((body as VncInstallResult | undefined)?.ok),
    output: typeof (body as VncInstallResult | undefined)?.output === 'string' ? (body as VncInstallResult).output : '',
    error: typeof (body as VncInstallResult | undefined)?.error === 'string' ? (body as VncInstallResult).error : undefined,
  };
}

function normalizeComposeResponse(body: DockerComposeFileResponse | { message?: string } | undefined): DockerComposeFileResponse {
  const responseBody = body as DockerComposeFileResponse | undefined;

  return {
    ok: Boolean(responseBody?.ok),
    containerId: typeof responseBody?.containerId === 'string' ? responseBody.containerId : '',
    composeFile: typeof responseBody?.composeFile === 'string' ? responseBody.composeFile : undefined,
    workingDir: typeof responseBody?.workingDir === 'string' ? responseBody.workingDir : undefined,
    project: typeof responseBody?.project === 'string' ? responseBody.project : undefined,
    service: typeof responseBody?.service === 'string' ? responseBody.service : undefined,
    content: typeof responseBody?.content === 'string' ? responseBody.content : '',
    output: typeof responseBody?.output === 'string' ? responseBody.output : undefined,
    error: typeof responseBody?.error === 'string' ? responseBody.error : undefined,
  };
}

function normalizeVncStatusResponse(body: VncStatusResponse | { message?: string } | undefined): VncStatusResponse {
  const responseBody = body as VncStatusResponse | undefined;

  return {
    ok: Boolean(responseBody?.ok),
    services: Array.isArray(responseBody?.services) ? responseBody.services.map(normalizeVncServiceCandidate) : [],
    graphicalServices: Array.isArray(responseBody?.graphicalServices) ? responseBody.graphicalServices.map(normalizeVncServiceCandidate) : [],
    listeners: Array.isArray(responseBody?.listeners) ? responseBody.listeners : [],
    preferredHost: typeof responseBody?.preferredHost === 'string' && responseBody.preferredHost.trim() ? responseBody.preferredHost : '127.0.0.1',
    preferredPort: Number.isInteger(responseBody?.preferredPort) ? responseBody?.preferredPort ?? 5900 : 5900,
    error: typeof responseBody?.error === 'string' ? responseBody.error : undefined,
  };
}

function normalizeVncServiceCandidate(service: VncServiceCandidate): VncServiceCandidate {
  return {
    name: typeof service.name === 'string' ? service.name : '',
    scope: service.scope === 'user' ? 'user' : 'system',
    loadState: typeof service.loadState === 'string' ? service.loadState : 'unknown',
    activeState: typeof service.activeState === 'string' ? service.activeState : 'unknown',
    subState: typeof service.subState === 'string' ? service.subState : 'unknown',
    unitFileState: typeof service.unitFileState === 'string' ? service.unitFileState : 'unknown',
    description: typeof service.description === 'string' ? service.description : '',
  };
}

function normalizeVncSetupInfo(body: VncSetupInfo | { message?: string } | undefined): VncSetupInfo {
  const responseBody = body as VncSetupInfo | undefined;
  const commands = responseBody?.commands;

  return {
    ok: Boolean(responseBody?.ok),
    supported: responseBody?.supported === true,
    backend: responseBody?.backend === 'wayvnc' ? 'wayvnc' : 'x11vnc',
    packageManager: isVncPackageManager(responseBody?.packageManager) ? responseBody.packageManager : 'unsupported',
    serviceName: typeof responseBody?.serviceName === 'string' ? responseBody.serviceName : 'x11vnc.service',
    sessionType: typeof responseBody?.sessionType === 'string' ? responseBody.sessionType : '',
    desktop: typeof responseBody?.desktop === 'string' ? responseBody.desktop : '',
    commands: {
      install: typeof commands?.install === 'string' ? commands.install : '',
      service: typeof commands?.service === 'string' ? commands.service : '',
      full: typeof commands?.full === 'string' ? commands.full : '',
    },
    notes: Array.isArray(responseBody?.notes) ? responseBody.notes.filter((note): note is string => typeof note === 'string') : [],
    error: typeof responseBody?.error === 'string' ? responseBody.error : undefined,
  };
}

function normalizeAppVersionInfo(body: AppVersionInfo | { message?: string } | undefined): AppVersionInfo {
  const responseBody = body as AppVersionInfo | undefined;
  const update = responseBody?.update;

  return {
    name: 'HomeDashboard',
    currentVersion: typeof responseBody?.currentVersion === 'string' && responseBody.currentVersion.trim() ? responseBody.currentVersion : '0.0.0',
    revision: typeof responseBody?.revision === 'string' && responseBody.revision.trim() ? responseBody.revision : undefined,
    buildDate: typeof responseBody?.buildDate === 'string' && responseBody.buildDate.trim() ? responseBody.buildDate : undefined,
    update: {
      enabled: update?.enabled === true,
      available: update?.available === true,
      latestVersion: typeof update?.latestVersion === 'string' && update.latestVersion.trim() ? update.latestVersion : undefined,
      releaseUrl: typeof update?.releaseUrl === 'string' && update.releaseUrl.trim() ? update.releaseUrl : '#',
      checkedAt: typeof update?.checkedAt === 'string' && update.checkedAt.trim() ? update.checkedAt : undefined,
      error: typeof update?.error === 'string' && update.error.trim() ? update.error : undefined,
    },
  };
}

function normalizeAppWallpaperInfo(body: AppWallpaperInfo | { message?: string } | undefined): AppWallpaperInfo {
  const responseBody = body as AppWallpaperInfo | undefined;
  const updatedAt = typeof responseBody?.updatedAt === 'string' && responseBody.updatedAt.trim() ? responseBody.updatedAt : undefined;
  const url = typeof responseBody?.url === 'string' && responseBody.url.trim() ? responseBody.url : undefined;

  return {
    exists: responseBody?.exists === true && Boolean(url),
    url,
    updatedAt,
  };
}

function isVncPackageManager(value: unknown): value is VncSetupInfo['packageManager'] {
  return value === 'apt' || value === 'dnf' || value === 'yum' || value === 'pacman' || value === 'apk' || value === 'unsupported';
}
