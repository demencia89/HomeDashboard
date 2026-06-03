import type { SystemdServiceAction, VncServiceCandidate, VncSetupInfo, VncStatusResponse } from '../types';

export type VncConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnecting';

export function prioritizeVncServices(services: VncServiceCandidate[], setup?: VncSetupInfo): VncServiceCandidate[] {
  return [...services].sort((a, b) => servicePriority(a, setup) - servicePriority(b, setup)
    || serviceSortRank(a) - serviceSortRank(b)
    || a.name.localeCompare(b.name)
    || a.scope.localeCompare(b.scope));
}

export function isPrimaryVncService(service: VncServiceCandidate, setup?: VncSetupInfo): boolean {
  return servicePriority(service, setup) <= 1;
}

function servicePriority(service: VncServiceCandidate, setup?: VncSetupInfo): number {
  const name = service.name.toLowerCase();
  const backend = setup?.backend.toLowerCase();

  if (setup?.serviceName && service.name === setup.serviceName) {
    return 0;
  }

  if (backend && name.includes(backend)) {
    return 1;
  }

  if (service.activeState === 'active') {
    return 2;
  }

  return 3;
}

function serviceSortRank(service: VncServiceCandidate): number {
  if (service.activeState === 'active') {
    return 0;
  }

  if (service.activeState === 'activating' || service.activeState === 'deactivating') {
    return 1;
  }

  if (service.activeState === 'failed') {
    return 2;
  }

  return 3;
}

export function serviceKey(service: Pick<VncServiceCandidate, 'name' | 'scope'>): string {
  return `${service.scope}:${service.name}`;
}

export function installFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';

  if (message.toLowerCase().includes('sudo') && message.toLowerCase().includes('password')) {
    return 'VNC install needs a sudo password. Copy the setup commands and run them in the server terminal, or configure passwordless sudo for package installation.';
  }

  return message || 'Unable to install VNC.';
}

export function serviceActionPastTense(action: SystemdServiceAction): string {
  if (action === 'start') {
    return 'started';
  }

  if (action === 'stop') {
    return 'stopped';
  }

  if (action === 'restart') {
    return 'restarted';
  }

  if (action === 'enable') {
    return 'enabled';
  }

  return 'disabled';
}

export function connectionButtonLabel(connectionState: VncConnectionState, lastDisconnectUnexpected: boolean): string {
  if (connectionState === 'connecting') {
    return 'Connecting';
  }

  if (connectionState === 'connected') {
    return 'Disconnect';
  }

  if (connectionState === 'disconnecting') {
    return 'Disconnecting';
  }

  return lastDisconnectUnexpected ? 'Reconnect' : 'Connect';
}

export function readinessDetail(listeners: VncStatusResponse['listeners'], primaryService?: VncServiceCandidate): string {
  if (!listeners.length) {
    return 'No local VNC listener was detected on the server.';
  }

  if (primaryService && primaryService.activeState !== 'active') {
    return `${serviceDisplayName(primaryService)} is ${primaryService.activeState}.`;
  }

  return 'Status is incomplete. Open Advanced for diagnostics.';
}

export function serviceHealthLabel(primaryService: VncServiceCandidate | undefined, activeServiceCount: number, totalServiceCount: number): string {
  if (primaryService) {
    return `${serviceDisplayName(primaryService)} ${primaryService.activeState}`;
  }

  if (totalServiceCount > 0) {
    return `${activeServiceCount}/${totalServiceCount} VNC services active`;
  }

  return 'No service detected';
}

export function listenerLabel(listener: VncStatusResponse['listeners'][number]): string {
  return `${listener.host}:${listener.port}`;
}

export function serviceDisplayName(service: Pick<VncServiceCandidate, 'name' | 'scope'>): string {
  return `${service.scope === 'user' ? 'user:' : ''}${service.name}`;
}

export function healthChipClass(healthy: boolean, known: boolean): string {
  return `vnc-health-chip ${healthy ? 'ready' : known ? 'blocked' : 'neutral'}`;
}

export function connectionLabel(connectionState: VncConnectionState): string {
  if (connectionState === 'connecting') {
    return 'connecting';
  }

  if (connectionState === 'connected') {
    return 'connected';
  }

  if (connectionState === 'disconnecting') {
    return 'disconnecting';
  }

  return 'disconnected';
}

export function statusClassName(activeState: string): string {
  if (activeState === 'active') {
    return 'running';
  }

  if (activeState === 'failed') {
    return 'failed';
  }

  if (activeState === 'activating' || activeState === 'deactivating') {
    return 'pending';
  }

  return 'inactive';
}

export function enabledClassName(unitFileState: string): string {
  if (unitFileState === 'enabled') {
    return 'enabled';
  }

  if (unitFileState === 'disabled') {
    return 'disabled';
  }

  return 'neutral';
}
