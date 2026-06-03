import net from 'node:net';
import type { FastifyPluginAsync } from 'fastify';
import type { Client, ClientChannel } from 'ssh2';
import type { RawData, WebSocket } from 'ws';
import { VNC_ALLOWED_HOSTS, VNC_ALLOWED_PORTS } from '../../config.js';
import { getVncSetupInfo, installVnc } from '../../services/vncSetupService.js';
import { controlVncService, getVncStatus } from '../../services/vncService.js';
import { closeSshClient, connectSsh, normalizeSshError, resolveServerProfile, resolveSshTarget, ServerNotFoundError } from '../../services/sshConnection.js';
import { isSystemdServiceAction } from '../../services/systemdService.js';
import type { JsonStore } from '../../storage/json-store.js';
import type { KeyStore } from '../../storage/key-store.js';
import { acceptWebSocketConnection, WebSocketMessageLimiter } from '../../security/rate-limit.js';
import { logRouteError, publicErrorMessage, redactedError } from '../../utils/api-errors.js';
import { rawDataLength, sendSocketData, sendSocketJson, writeRawData } from '../../utils/websocket.js';

interface VncRoutesOptions {
  store: JsonStore;
  keyStore: KeyStore;
}

interface VncQuery {
  host?: unknown;
  port?: unknown;
}

interface VncServiceActionQuery {
  scope?: string;
}

const MAX_PENDING_INPUT_BYTES = 256 * 1024;
const VNC_BRIDGE_PORT_RANGES = parseAllowedPortRanges(VNC_ALLOWED_PORTS);
const VNC_BRIDGE_ALLOWED_HOSTS = new Set(parseAllowedHosts(VNC_ALLOWED_HOSTS));

export const vncRoutes: FastifyPluginAsync<VncRoutesOptions> = async (fastify, { store, keyStore }) => {
  fastify.get<{ Params: { id: string } }>('/api/servers/:id/vnc/status', async (request, reply) => {
    try {
      const result = await getVncStatus(store, keyStore, request.params.id);

      if (!result.ok) {
        logRouteError(request.log, 'VNC status failed', {
          serverId: request.params.id,
          error: result.error,
        });
        return reply.code(400).send({
          error: 'VNC Status Error',
          message: publicVncError(result.error, 'Unable to read VNC status.'),
        });
      }

      return reply.send(result);
    } catch (error) {
      if (error instanceof ServerNotFoundError) {
        return reply.code(404).send({
          error: 'Not Found',
          message: error.message,
        });
      }

      logRouteError(request.log, 'VNC status failed', {
        serverId: request.params.id,
        error: redactedError(error),
      });
      return reply.code(400).send({
        error: 'VNC Status Error',
        message: publicVncError(error, 'Unable to read VNC status.'),
      });
    }
  });

  fastify.post<{ Params: { id: string; serviceName: string; action: string }; Querystring: VncServiceActionQuery }>('/api/servers/:id/vnc/services/:serviceName/:action', async (request, reply) => {
    if (!isSystemdServiceAction(request.params.action)) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'action must be start, stop, restart, enable, or disable.',
      });
    }

    try {
      const scope = request.query.scope === 'user' ? 'user' : 'system';
      const result = await controlVncService(store, keyStore, request.params.id, request.params.serviceName, request.params.action, scope);

      if (!result.ok) {
        logRouteError(request.log, 'VNC service control failed', {
          serverId: request.params.id,
          serviceName: request.params.serviceName,
          action: request.params.action,
          error: result.error,
        });
        return reply.code(400).send({
          error: 'VNC Service Error',
          message: publicVncError(result.error, 'Unable to control VNC service.'),
        });
      }

      return reply.send(result);
    } catch (error) {
      logRouteError(request.log, 'VNC service control failed', {
        serverId: request.params.id,
        serviceName: request.params.serviceName,
        action: request.params.action,
        error: redactedError(error),
      });
      return reply.code(400).send({
        error: 'VNC Service Error',
        message: publicVncError(error, 'Unable to control VNC service.'),
      });
    }
  });

  fastify.get<{ Params: { id: string } }>('/api/servers/:id/vnc/setup', async (request, reply) => {
    const result = await getVncSetupInfo(store, keyStore, request.params.id);

    if (!result.ok) {
      logRouteError(request.log, 'VNC setup detection failed', {
        serverId: request.params.id,
        error: result.error,
      });
      return reply.code(400).send({
        error: 'VNC Setup Error',
        message: publicVncError(result.error, 'Unable to read VNC setup options.'),
      });
    }

    return reply.send(result);
  });

  fastify.post<{ Params: { id: string } }>('/api/servers/:id/vnc/install', async (request, reply) => {
    const result = await installVnc(store, keyStore, request.params.id);

    if (!result.ok) {
      logRouteError(request.log, 'VNC install failed', {
        serverId: request.params.id,
        error: result.error,
        output: result.output,
      });

      return reply.code(400).send({
        error: 'VNC Install Error',
        message: publicVncError(result.error, 'Unable to install VNC.'),
        output: '',
      });
    }

    return reply.send(result);
  });

  fastify.get<{ Params: { id: string }; Querystring: VncQuery }>('/api/servers/:id/vnc/socket', { websocket: true }, (socket, request) => {
    if (!acceptWebSocketConnection(request, socket, 'VNC bridge')) {
      return;
    }

    void resolveVncBridgeTarget({
      store,
      keyStore,
      serverId: request.params.id,
      query: request.query,
    })
      .then((target) => {
        if (socket.readyState !== 1) {
          return;
        }

        handleVncBridge(socket, () => openVncConnection(request.params.id, store, keyStore, target.host, target.port));
      })
      .catch((error) => {
        sendSocketJson(socket, {
          type: 'error',
          message: publicVncError(error, 'VNC bridge target is not allowed.'),
        });
        socket.close(1008, 'VNC bridge target rejected.');
      });
  });
};

interface VncBridgeTarget {
  host: string;
  port: number;
}

interface VncBridgeTargetOptions {
  store: JsonStore;
  keyStore: KeyStore;
  serverId: string;
  query: VncQuery;
  getStatus?: typeof getVncStatus;
}

export async function resolveVncBridgeTarget({
  store,
  keyStore,
  serverId,
  query,
  getStatus = getVncStatus,
}: VncBridgeTargetOptions): Promise<VncBridgeTarget> {
  const host = parseRequestedVncHost(query.host);
  const port = parseRequestedVncPort(query.port);

  if (!isAllowedVncBridgePort(port)) {
    throw new Error('VNC bridge port is not allowed.');
  }

  if (isLoopbackHost(host) || VNC_BRIDGE_ALLOWED_HOSTS.has(normalizeHostKey(host))) {
    return { host, port };
  }

  const profile = await resolveServerProfile(store, serverId);

  if (normalizeHostKey(profile.host) === normalizeHostKey(host)) {
    return { host, port };
  }

  const status = await getStatus(store, keyStore, serverId);

  if (status.ok && status.listeners.some((listener) => normalizeHostKey(listener.host) === normalizeHostKey(host) && listener.port === port)) {
    return { host, port };
  }

  throw new Error('VNC bridge host is not allowed.');
}

function handleVncBridge(
  socket: WebSocket,
  openConnection: () => Promise<{ client?: Client; stream: ClientChannel | net.Socket }>,
): void {
  let client: Client | undefined;
  let stream: ClientChannel | net.Socket | undefined;
  let closed = false;
  const pendingInput: RawData[] = [];
  let pendingInputBytes = 0;
  const messageLimiter = new WebSocketMessageLimiter();

  const cleanup = () => {
    if (closed) {
      return;
    }

    closed = true;
    pendingInput.length = 0;
    pendingInputBytes = 0;

    try {
      stream?.removeAllListeners();
      stream?.end();
      stream?.destroy();
    } catch {
      // Best-effort cleanup only.
    }

    closeSshClient(client);
  };

  socket.on('message', (data: RawData) => {
    if (!messageLimiter.consume(socket, 'VNC bridge')) {
      cleanup();
      return;
    }

    if (!stream) {
      pendingInputBytes += rawDataLength(data);

      if (pendingInputBytes > MAX_PENDING_INPUT_BYTES) {
        socket.close(1009, 'VNC input queue exceeded.');
        cleanup();
        return;
      }

      pendingInput.push(data);
      return;
    }

    writeRawData(stream, data);
  });

  socket.once('close', cleanup);
  socket.once('error', cleanup);

  void openConnection()
    .then((connection) => {
      if (closed) {
        connection.stream.destroy();
        closeSshClient(connection.client);
        return;
      }

      client = connection.client;
      stream = connection.stream;

      stream.on('data', (chunk: Buffer) => sendSocketData(socket, chunk));
      stream.once('close', () => {
        if (socket.readyState === 1) {
          socket.close(1000, 'VNC connection closed.');
        }

        cleanup();
      });
      stream.once('error', (error: Error) => {
        sendSocketJson(socket, {
          type: 'error',
          message: publicVncError(normalizeSshError(error.message), 'VNC bridge error.'),
        });
        socket.close(1011, 'VNC bridge error.');
        cleanup();
      });

      for (const input of pendingInput.splice(0)) {
        writeRawData(stream, input);
      }

      pendingInputBytes = 0;
    })
    .catch((error) => {
      sendSocketJson(socket, {
        type: 'error',
        message: publicVncError(error instanceof Error ? normalizeSshError(error.message) : error, 'Unable to connect to VNC.'),
      });
      socket.close(1011, 'VNC setup failed.');
      cleanup();
    });
}

function publicVncError(error: unknown, fallback: string): string {
  return publicErrorMessage(error, {
    fallback,
    allowedMessages: [
      'Automatic VNC install is not supported on this server. Copy the commands and adapt them manually.',
      'serviceName must be a valid VNC service unit name.',
      'serviceName must be a valid user service unit name.',
      'action must be start, stop, restart, enable, or disable.',
      'VNC bridge host is not allowed.',
      'VNC bridge port is not allowed.',
    ],
  });
}

async function openVncConnection(
  serverId: string,
  store: JsonStore,
  keyStore: KeyStore,
  host: string,
  port: number,
): Promise<{ client?: Client; stream: ClientChannel | net.Socket }> {
  const target = await resolveSshTarget(store, keyStore, serverId);

  if (target.isLocal) {
    return {
      stream: await openLocalTcpConnection(host, port),
    };
  }

  const client = await connectSsh(target.connectConfig);

  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (error, stream) => {
      if (error) {
        closeSshClient(client);
        reject(error);
        return;
      }

      resolve({ client, stream });
    });
  });
}

function openLocalTcpConnection(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });

    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function parseRequestedVncHost(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '127.0.0.1';
  }

  if (typeof value !== 'string') {
    throw new Error('VNC bridge host is not allowed.');
  }

  const host = stripIpv6Brackets(value.trim());

  if (!isVncHostSyntax(host)) {
    throw new Error('VNC bridge host is not allowed.');
  }

  return host;
}

function parseRequestedVncPort(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return 5900;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new Error('VNC bridge port is not allowed.');
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('VNC bridge port is not allowed.');
  }

  return port;
}

function isAllowedVncBridgePort(port: number): boolean {
  return VNC_BRIDGE_PORT_RANGES.some((range) => port >= range.start && port <= range.end);
}

interface PortRange {
  start: number;
  end: number;
}

function parseAllowedPortRanges(value: string): PortRange[] {
  const ranges = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(\d+)(?:-(\d+))?$/.exec(part);

      if (!match) {
        throw new Error('VNC_ALLOWED_PORTS must be a comma-separated list of ports or port ranges.');
      }

      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : start;

      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
        throw new Error('VNC_ALLOWED_PORTS must contain valid TCP ports.');
      }

      return { start, end };
    });

  if (ranges.length === 0) {
    throw new Error('VNC_ALLOWED_PORTS must allow at least one port.');
  }

  return ranges;
}

function parseAllowedHosts(value: string): string[] {
  if (!value.trim()) {
    return [];
  }

  return value
    .split(',')
    .map((host) => stripIpv6Brackets(host.trim()))
    .filter(Boolean)
    .map((host) => {
      if (!isVncHostSyntax(host)) {
        throw new Error('VNC_ALLOWED_HOSTS must be a comma-separated list of hostnames or IP addresses.');
      }

      return normalizeHostKey(host);
    });
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHostKey(host);

  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }

  if (net.isIPv4(normalized)) {
    return normalized.startsWith('127.');
  }

  return false;
}

function normalizeHostKey(host: string): string {
  return stripIpv6Brackets(host.trim()).replace(/\.$/, '').toLowerCase();
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isVncHostSyntax(host: string): boolean {
  return host.length > 0 && host.length <= 253 && /^[A-Za-z0-9:._-]+$/.test(host);
}
