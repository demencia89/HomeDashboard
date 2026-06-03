import type { ContainerMetric, DockerContainerAction, ServerProfile } from '../types';

export function containerUrl(server: ServerProfile, container: ContainerMetric, overrideUrl?: string): string | undefined {
  if (overrideUrl) {
    return overrideUrl;
  }

  const publishedPort = preferredPublishedTcpPort(container.ports);

  if (!publishedPort) {
    return undefined;
  }

  const host = isLoopbackHost(server.host) ? window.location.hostname : server.host;
  const protocol = publishedPort === '443' ? 'https:' : window.location.protocol === 'https:' ? 'https:' : 'http:';
  const port = (protocol === 'http:' && publishedPort === '80') || (protocol === 'https:' && publishedPort === '443') ? '' : ':' + publishedPort;
  return protocol + '//' + host + port + '/';
}

export function openContainerUrl(server: ServerProfile, container: ContainerMetric, overrideUrl?: string): void {
  const url = containerUrl(server, container, overrideUrl);

  if (!url) {
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}

export function preferredPublishedTcpPort(ports: string): string | undefined {
  const mappings = [...ports.matchAll(/(?:^|,\s)(?:\[[^\]]+\]|[^,\s:]+):(\d+)->(\d+)\/tcp/g)]
    .map((match) => ({
      hostPort: match[1],
      containerPort: match[2],
    }));

  if (!mappings.length) {
    return undefined;
  }

  const preferredContainerPorts = ['443', '8443', '9443', '80', '8080', '3000'];

  for (const containerPort of preferredContainerPorts) {
    const mapping = mappings.find((candidate) => candidate.containerPort === containerPort);

    if (mapping) {
      return mapping.hostPort;
    }
  }

  return mappings[0]?.hostPort;
}

export function normalizeContainerUrlOverride(value: string): string | undefined {
  return normalizeHttpUrl(value);
}

export function normalizeContainerIconOverride(value: string): string | undefined {
  return normalizeHttpUrl(value);
}

function normalizeHttpUrl(value: string): string | undefined {
  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : 'http://' + trimmed;

  try {
    const url = new URL(withProtocol);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }

    return url.href;
  } catch {
    return undefined;
  }
}

export function containerOverrideKey(serverId: string, containerName: string): string {
  return serverId + ':' + containerName;
}

export function canControlContainer(container: ContainerMetric, action: DockerContainerAction): boolean {
  if (action === 'start') {
    return container.state === 'exited' || container.state === 'created';
  }

  if (action === 'stop') {
    return container.state === 'running' || container.state === 'paused' || container.state === 'restarting';
  }

  return container.state === 'running' || container.state === 'restarting';
}

export function confirmContainerAction(container: ContainerMetric, action: DockerContainerAction): boolean {
  if (action === 'start') {
    return true;
  }

  const label = action === 'stop' ? 'stop' : 'reset';
  const typed = window.prompt('Type "' + container.name + '" to ' + label + ' this container.');

  if (typed === null) {
    return false;
  }

  if (typed !== container.name) {
    window.alert((action === 'stop' ? 'Stop' : 'Reset') + ' cancelled. Container name did not match.');
    return false;
  }

  return true;
}

export function containerActionPastTense(action: DockerContainerAction): string {
  if (action === 'start') {
    return 'started';
  }

  if (action === 'stop') {
    return 'stopped';
  }

  return 'reset';
}

export function containerStateRank(state: ContainerMetric['state']): number {
  switch (state) {
    case 'running':
      return 0;
    case 'restarting':
      return 1;
    case 'paused':
      return 2;
    case 'created':
      return 3;
    case 'exited':
      return 4;
    default:
      return 5;
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}
