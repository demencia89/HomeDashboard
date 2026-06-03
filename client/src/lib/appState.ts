import type { ActiveView, ServerProfile, SystemMetrics } from '../types';

export interface MetricsUpdateMessage {
  type: 'metrics:update';
  serverId: string;
  metrics: SystemMetrics;
}

export function viewUsesMetrics(view: ActiveView): boolean {
  return view === 'overview' || view === 'containers';
}

export function isActiveView(value: unknown): value is ActiveView {
  return value === 'overview' || value === 'files' || value === 'terminal' || value === 'services' || value === 'containers' || value === 'vnc';
}

export function normalizeServerOrder(servers: ServerProfile[], order: string[]): string[] {
  const serverIds = new Set(servers.map((server) => server.id));
  const orderedIds = order.filter((serverId, index) => serverIds.has(serverId) && order.indexOf(serverId) === index);
  const orderedSet = new Set(orderedIds);
  return [...orderedIds, ...servers.map((server) => server.id).filter((serverId) => !orderedSet.has(serverId))];
}

export function orderServers(servers: ServerProfile[], order: string[]): ServerProfile[] {
  const serversById = new Map(servers.map((server) => [server.id, server]));
  const orderedServers = order
    .map((serverId) => serversById.get(serverId))
    .filter((server): server is ServerProfile => Boolean(server));
  const orderedIds = new Set(orderedServers.map((server) => server.id));
  return [...orderedServers, ...servers.filter((server) => !orderedIds.has(server.id))];
}

export function parseMetricsStreamMessage(raw: unknown): MetricsUpdateMessage | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<{ type: string; serverId: string; metrics: SystemMetrics }>;

    if (parsed.type === 'metrics:update' && typeof parsed.serverId === 'string' && parsed.metrics) {
      return {
        type: 'metrics:update',
        serverId: parsed.serverId,
        metrics: parsed.metrics,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function mergeMetricsSnapshot(_previous: SystemMetrics | undefined, next: SystemMetrics): SystemMetrics {
  return next;
}

export function viewTransitionName(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}
