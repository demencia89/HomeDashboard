import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  AUTH_FAILURE_RATE_LIMIT_MAX,
  AUTH_FAILURE_RATE_LIMIT_WINDOW_MS,
  CORS_ORIGIN,
  EXPENSIVE_HTTP_RATE_LIMIT_MAX,
  EXPENSIVE_HTTP_RATE_LIMIT_WINDOW_MS,
  WS_CONNECTION_RATE_LIMIT_MAX,
  WS_CONNECTION_RATE_LIMIT_WINDOW_MS,
  WS_MAX_CONNECTIONS_PER_IP,
  WS_MESSAGE_RATE_LIMIT_MAX,
  WS_MESSAGE_RATE_LIMIT_WINDOW_MS,
} from '../config.js';

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export const websocketMessageLimiterConfig: RateLimitConfig = {
  max: WS_MESSAGE_RATE_LIMIT_MAX,
  windowMs: WS_MESSAGE_RATE_LIMIT_WINDOW_MS,
};

const websocketConnectionsByIp = new Map<string, number>();
let authFailureLimiter: FixedWindowRateLimiter | undefined;
let expensiveHttpLimiter: FixedWindowRateLimiter | undefined;
let websocketConnectionLimiter: FixedWindowRateLimiter | undefined;

export function createWebSocketToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly config: RateLimitConfig) {}

  consume(key: string, now = Date.now()): RateLimitResult {
    if (this.config.max <= 0 || this.config.windowMs <= 0) {
      return { allowed: true, retryAfterMs: 0 };
    }

    this.prune(now);

    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + this.config.windowMs,
      });
      return { allowed: true, retryAfterMs: 0 };
    }

    if (bucket.count >= this.config.max) {
      return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - now) };
    }

    bucket.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(): void {
    this.buckets.clear();
  }

  private prune(now: number): void {
    if (this.buckets.size < 10_000) {
      return;
    }

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}

export class WebSocketMessageLimiter {
  private readonly limiter: FixedWindowRateLimiter;
  private readonly socketKeys = new WeakMap<WebSocket, string>();
  private nextSocketId = 0;

  constructor(config: RateLimitConfig = websocketMessageLimiterConfig) {
    this.limiter = new FixedWindowRateLimiter(config);
  }

  consume(socket: WebSocket, label: string): boolean {
    const result = this.limiter.consume(this.socketKey(socket));

    if (result.allowed) {
      return true;
    }

    sendSocketJson(socket, {
      type: 'error',
      message: `${label} message rate limit exceeded.`,
    });
    socket.close(1008, `${label} message rate limit exceeded.`);
    return false;
  }

  private socketKey(socket: WebSocket): string {
    const existing = this.socketKeys.get(socket);

    if (existing) {
      return existing;
    }

    const key = `socket:${this.nextSocketId}`;
    this.nextSocketId += 1;
    this.socketKeys.set(socket, key);
    return key;
  }
}

export function consumeAuthFailure(request: FastifyRequest): RateLimitResult {
  return getAuthFailureLimiter().consume(rateLimitKey(request));
}

export function registerExpensiveHttpRateLimit(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!isExpensiveHttpRoute(request)) {
      return;
    }

    const result = getExpensiveHttpLimiter().consume(rateLimitKey(request));

    if (!result.allowed) {
      await sendRateLimitError(reply, result, 'Too many expensive API requests. Please wait and retry.');
    }
  });
}

export function acceptWebSocketConnection(request: FastifyRequest, socket: WebSocket, label: string, token: string): boolean {
  if (!isAllowedWebSocketOrigin(request)) {
    sendSocketJson(socket, {
      type: 'error',
      message: `${label} origin rejected.`,
    });
    socket.close(1008, `${label} origin rejected.`);
    return false;
  }

  if (!isValidWebSocketToken(request, token)) {
    sendSocketJson(socket, {
      type: 'error',
      message: `${label} token rejected.`,
    });
    socket.close(1008, `${label} token rejected.`);
    return false;
  }

  const key = rateLimitKey(request);
  const result = getWebsocketConnectionLimiter().consume(key);

  if (!result.allowed) {
    sendSocketJson(socket, {
      type: 'error',
      message: `${label} connection rate limit exceeded.`,
    });
    socket.close(1008, `${label} connection rate limit exceeded.`);
    return false;
  }

  if (WS_MAX_CONNECTIONS_PER_IP > 0 && (websocketConnectionsByIp.get(key) ?? 0) >= WS_MAX_CONNECTIONS_PER_IP) {
    sendSocketJson(socket, {
      type: 'error',
      message: `${label} connection limit exceeded.`,
    });
    socket.close(1008, `${label} connection limit exceeded.`);
    return false;
  }

  websocketConnectionsByIp.set(key, (websocketConnectionsByIp.get(key) ?? 0) + 1);

  let released = false;
  const release = () => {
    if (released) {
      return;
    }

    released = true;
    const current = websocketConnectionsByIp.get(key) ?? 0;

    if (current <= 1) {
      websocketConnectionsByIp.delete(key);
    } else {
      websocketConnectionsByIp.set(key, current - 1);
    }
  };

  socket.once('close', release);
  socket.once('error', release);
  return true;
}

export async function sendRateLimitError(reply: FastifyReply, result: RateLimitResult, message: string): Promise<void> {
  await reply
    .header('retry-after', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))))
    .code(429)
    .send({
      error: 'Too Many Requests',
      message,
    });
}

export function resetRateLimitStateForTests(): void {
  authFailureLimiter?.reset();
  expensiveHttpLimiter?.reset();
  websocketConnectionLimiter?.reset();
  websocketConnectionsByIp.clear();
}

function getAuthFailureLimiter(): FixedWindowRateLimiter {
  authFailureLimiter ??= new FixedWindowRateLimiter({
    max: AUTH_FAILURE_RATE_LIMIT_MAX,
    windowMs: AUTH_FAILURE_RATE_LIMIT_WINDOW_MS,
  });
  return authFailureLimiter;
}

function getExpensiveHttpLimiter(): FixedWindowRateLimiter {
  expensiveHttpLimiter ??= new FixedWindowRateLimiter({
    max: EXPENSIVE_HTTP_RATE_LIMIT_MAX,
    windowMs: EXPENSIVE_HTTP_RATE_LIMIT_WINDOW_MS,
  });
  return expensiveHttpLimiter;
}

function getWebsocketConnectionLimiter(): FixedWindowRateLimiter {
  websocketConnectionLimiter ??= new FixedWindowRateLimiter({
    max: WS_CONNECTION_RATE_LIMIT_MAX,
    windowMs: WS_CONNECTION_RATE_LIMIT_WINDOW_MS,
  });
  return websocketConnectionLimiter;
}

function isExpensiveHttpRoute(request: FastifyRequest): boolean {
  if (request.headers.upgrade?.toLowerCase() === 'websocket') {
    return false;
  }

  const method = request.method.toUpperCase();
  const pathname = request.url.split('?')[0];

  if (!pathname.startsWith('/api/servers/')) {
    return false;
  }

  if (method === 'POST' && /^\/api\/servers\/[^/]+\/test$/.test(pathname)) {
    return true;
  }

  return [
    /^\/api\/servers\/[^/]+\/metrics$/,
    /^\/api\/servers\/[^/]+\/network\/nethogs$/,
    /^\/api\/servers\/[^/]+\/temperature$/,
    /^\/api\/servers\/[^/]+\/processes\/[^/]+\/kill$/,
    /^\/api\/servers\/[^/]+\/containers\/[^/]+(?:\/.*)?$/,
    /^\/api\/servers\/[^/]+\/services(?:\/.*)?$/,
    /^\/api\/servers\/[^/]+\/vnc\/(?:status|setup|install|services\/.*)$/,
    /^\/api\/servers\/[^/]+\/files(?:\/.*)?$/,
  ].some((pattern) => pattern.test(pathname));
}

function rateLimitKey(request: FastifyRequest): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

function isAllowedWebSocketOrigin(request: FastifyRequest): boolean {
  const origin = normalizedOrigin(singleHeaderValue(request.headers.origin));

  if (!origin) {
    return false;
  }

  if (Array.isArray(CORS_ORIGIN) && CORS_ORIGIN.length > 0) {
    return CORS_ORIGIN.some((allowedOrigin) => normalizedOrigin(allowedOrigin) === origin);
  }

  return sameHostOrigins(request).has(origin);
}

function sameHostOrigins(request: FastifyRequest): Set<string> {
  const hosts = [
    singleHeaderValue(request.headers.host),
    singleHeaderValue(request.headers['x-forwarded-host']),
  ].filter((host): host is string => Boolean(host));

  const origins = new Set<string>();

  for (const host of hosts) {
    origins.add(`http://${host}`);
    origins.add(`https://${host}`);
  }

  return origins;
}

function isValidWebSocketToken(request: FastifyRequest, expectedToken: string): boolean {
  const token = new URL(request.url, 'http://homedashboard.local').searchParams.get('token') ?? '';

  if (!token || !expectedToken || token.length !== expectedToken.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
}

function normalizedOrigin(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const origin = new URL(value);

    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
      return undefined;
    }

    return origin.origin;
  } catch {
    return undefined;
  }
}

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendSocketJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== 1) {
    return;
  }

  try {
    socket.send(JSON.stringify(payload));
  } catch {
    socket.close(1011, 'WebSocket send failed.');
  }
}
