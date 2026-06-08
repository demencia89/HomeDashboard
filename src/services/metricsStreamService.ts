import type { RawData, WebSocket } from 'ws';
import type { KeyStore } from '../storage/key-store.js';
import type { JsonStore } from '../storage/json-store.js';
import { buildOfflineMetrics, collectTelemetry, type SystemMetrics } from './telemetryService.js';
import { normalizeSshError, resolveSshTarget, SshConnectionPool } from './sshConnection.js';
import { WebSocketMessageLimiter } from '../security/rate-limit.js';

export type MetricsRefreshRate = 0 | 5000 | 10000 | 30000 | 60000;

interface MetricsClientSubscription {
  socket: WebSocket;
  serverIds: Set<string>;
  intervalMs: MetricsRefreshRate;
}

interface MetricsServerState {
  subscribers: Set<MetricsClientSubscription>;
  timer?: NodeJS.Timeout;
  inFlight?: Promise<SystemMetrics>;
  lastMetrics?: SystemMetrics;
  lastCollectedAt: number;
  failures: number;
  nextAllowedAt: number;
}

interface MetricsSubscribeMessage {
  type: 'subscribe';
  serverIds?: unknown;
  intervalMs?: unknown;
}

interface MetricsRefreshMessage {
  type: 'refresh';
  serverIds?: unknown;
}

type MetricsClientMessage = MetricsSubscribeMessage | MetricsRefreshMessage;

const METRICS_CACHE_MS = 2_000;
const METRICS_RETRY_MAX_MS = 60_000;
const METRICS_REFRESH_RATES = new Set<MetricsRefreshRate>([0, 5000, 10000, 30000, 60000]);
export const MAX_METRICS_STREAM_SERVER_IDS = 50;

export class MetricsStreamHub {
  private readonly serverStates = new Map<string, MetricsServerState>();
  private readonly clients = new Set<MetricsClientSubscription>();
  private readonly messageLimiter = new WebSocketMessageLimiter();
  private readonly sshPool = new SshConnectionPool();

  constructor(
    private readonly store: JsonStore,
    private readonly keyStore: KeyStore,
  ) {}

  handleSocket(socket: WebSocket): void {
    const subscription: MetricsClientSubscription = {
      socket,
      serverIds: new Set(),
      intervalMs: 0,
    };

    this.clients.add(subscription);

    socket.on('message', (data: RawData) => {
      if (!this.messageLimiter.consume(socket, 'Metrics stream')) {
        this.removeClient(subscription);
        return;
      }

      void this.handleMessage(subscription, data.toString());
    });

    socket.once('close', () => this.removeClient(subscription));
    socket.once('error', () => this.removeClient(subscription));
  }

  private async handleMessage(subscription: MetricsClientSubscription, raw: string): Promise<void> {
    const message = parseClientMessage(raw);

    if (!message) {
      this.send(subscription.socket, {
        type: 'metrics:error',
        message: 'Invalid metrics stream message.',
      });
      return;
    }

    const serverIds = normalizeServerIds(message.serverIds);

    if (serverIds.error) {
      this.send(subscription.socket, {
        type: 'metrics:error',
        message: serverIds.error,
      });
      return;
    }

    const validServerIds = await this.validateServerIds(serverIds.value, subscription.socket);

    if (!validServerIds) {
      return;
    }

    if (message.type === 'subscribe') {
      this.updateSubscription(subscription, validServerIds, normalizeRefreshRate(message.intervalMs));
      return;
    }

    await this.refreshServers(validServerIds, true);
  }

  async getSnapshot(serverId: string, force = false): Promise<SystemMetrics> {
    const state = this.getServerState(serverId);
    const now = Date.now();

    if (!force && state.lastMetrics && now - state.lastCollectedAt < METRICS_CACHE_MS) {
      return state.lastMetrics;
    }

    return this.collectServer(serverId, force);
  }

  close(): void {
    for (const state of this.serverStates.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }

    this.serverStates.clear();
    this.clients.clear();
    this.sshPool.closeAll();
  }

  private updateSubscription(subscription: MetricsClientSubscription, serverIds: string[], intervalMs: MetricsRefreshRate): void {
    const previousServerIds = [...subscription.serverIds];
    subscription.serverIds = new Set(serverIds);
    subscription.intervalMs = intervalMs;

    for (const serverId of previousServerIds) {
      if (!subscription.serverIds.has(serverId)) {
        this.detachSubscriber(serverId, subscription);
      }
    }

    for (const serverId of subscription.serverIds) {
      const state = this.getServerState(serverId);
      state.subscribers.add(subscription);

      if (state.lastMetrics) {
        this.sendMetrics(subscription.socket, serverId, state.lastMetrics, state.lastCollectedAt);
      }

      if (!state.lastMetrics || Date.now() - state.lastCollectedAt >= METRICS_CACHE_MS) {
        void this.collectServer(serverId, false);
      }

      this.scheduleServer(serverId);
    }
  }

  private removeClient(subscription: MetricsClientSubscription): void {
    this.clients.delete(subscription);

    for (const serverId of subscription.serverIds) {
      this.detachSubscriber(serverId, subscription);
    }
  }

  private detachSubscriber(serverId: string, subscription: MetricsClientSubscription): void {
    const state = this.serverStates.get(serverId);

    if (!state) {
      return;
    }

    state.subscribers.delete(subscription);
    this.scheduleServer(serverId);
  }

  private async refreshServers(serverIds: string[], force: boolean): Promise<void> {
    await Promise.all(serverIds.map((serverId) => this.collectServer(serverId, force)));
  }

  private async validateServerIds(serverIds: string[], socket: WebSocket): Promise<string[] | undefined> {
    if (serverIds.length === 0) {
      return [];
    }

    try {
      const configuredServerIds = new Set((await this.store.listServers()).map((server) => server.id));
      const unknownServerId = serverIds.find((serverId) => !configuredServerIds.has(serverId));

      if (unknownServerId) {
        this.send(socket, {
          type: 'metrics:error',
          message: `Unknown metrics server id "${unknownServerId}".`,
        });
        return undefined;
      }

      return serverIds;
    } catch {
      this.send(socket, {
        type: 'metrics:error',
        message: 'Unable to validate metrics server ids.',
      });
      return undefined;
    }
  }

  private async collectServer(serverId: string, force: boolean): Promise<SystemMetrics> {
    const state = this.getServerState(serverId);
    const now = Date.now();

    if (!force && state.lastMetrics && now - state.lastCollectedAt < METRICS_CACHE_MS) {
      return state.lastMetrics;
    }

    if (state.inFlight) {
      return state.inFlight;
    }

    state.inFlight = this.collectServerNow(serverId, force)
      .then((metrics) => {
        state.lastMetrics = metrics;
        state.lastCollectedAt = Date.now();
        state.failures = metrics.online ? 0 : Math.min(state.failures + 1, 5);
        state.nextAllowedAt = metrics.online ? 0 : state.lastCollectedAt + Math.min(METRICS_RETRY_MAX_MS, 5000 * 2 ** state.failures);
        this.broadcastMetrics(serverId, metrics, state.lastCollectedAt);
        return metrics;
      })
      .finally(() => {
        state.inFlight = undefined;
        this.scheduleServer(serverId);
      });

    return state.inFlight;
  }

  private async collectServerNow(serverId: string, force: boolean): Promise<SystemMetrics> {
    try {
      const target = await resolveSshTarget(this.store, this.keyStore, serverId);
      if (force && !target.isLocal) {
        this.sshPool.drop(target.connectConfig);
      }

      return await collectTelemetry(target, { sshPool: this.sshPool });
    } catch (error) {
      return buildOfflineMetrics(error instanceof Error ? normalizeSshError(error.message) : 'SSH Connection Timeout or Refused');
    }
  }

  private scheduleServer(serverId: string): void {
    const state = this.serverStates.get(serverId);

    if (!state) {
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }

    const intervalMs = this.effectiveInterval(state);

    if (intervalMs === 0 || state.subscribers.size === 0) {
      return;
    }

    const now = Date.now();
    const dueAt = Math.max(state.lastCollectedAt + intervalMs, state.nextAllowedAt, now + intervalMs);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.collectServer(serverId, false);
    }, Math.max(0, dueAt - now));
  }

  private effectiveInterval(state: MetricsServerState): MetricsRefreshRate {
    const intervals = [...state.subscribers]
      .map((subscriber) => subscriber.intervalMs)
      .filter((interval): interval is Exclude<MetricsRefreshRate, 0> => interval > 0);

    return intervals.length ? Math.min(...intervals) as MetricsRefreshRate : 0;
  }

  private getServerState(serverId: string): MetricsServerState {
    const existing = this.serverStates.get(serverId);

    if (existing) {
      return existing;
    }

    const state: MetricsServerState = {
      subscribers: new Set(),
      lastCollectedAt: 0,
      failures: 0,
      nextAllowedAt: 0,
    };
    this.serverStates.set(serverId, state);
    return state;
  }

  private broadcastMetrics(serverId: string, metrics: SystemMetrics, collectedAt: number): void {
    const state = this.serverStates.get(serverId);

    if (!state) {
      return;
    }

    for (const subscriber of state.subscribers) {
      this.sendMetrics(subscriber.socket, serverId, metrics, collectedAt);
    }
  }

  private sendMetrics(socket: WebSocket, serverId: string, metrics: SystemMetrics, collectedAt: number): void {
    this.send(socket, {
      type: 'metrics:update',
      serverId,
      metrics,
      collectedAt: new Date(collectedAt).toISOString(),
    });
  }

  private send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== 1) {
      return;
    }

    socket.send(JSON.stringify(payload));
  }
}

function parseClientMessage(raw: string): MetricsClientMessage | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<MetricsClientMessage>;

    if (parsed.type === 'subscribe' || parsed.type === 'refresh') {
      return parsed as MetricsClientMessage;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

interface NormalizedServerIds {
  value: string[];
  error?: string;
}

function normalizeServerIds(value: unknown): NormalizedServerIds {
  if (!Array.isArray(value)) {
    return { value: [] };
  }

  if (value.length > MAX_METRICS_STREAM_SERVER_IDS) {
    return {
      value: [],
      error: `Metrics stream subscriptions are limited to ${MAX_METRICS_STREAM_SERVER_IDS} servers.`,
    };
  }

  const ids = value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim());

  return { value: ids.filter((item, index) => ids.indexOf(item) === index) };
}

function normalizeRefreshRate(value: unknown): MetricsRefreshRate {
  return typeof value === 'number' && METRICS_REFRESH_RATES.has(value as MetricsRefreshRate) ? value as MetricsRefreshRate : 0;
}
