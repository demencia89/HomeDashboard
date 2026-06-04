import type { FastifyPluginAsync } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { Client, ClientChannel } from 'ssh2';
import { closeSshClient, connectSsh, normalizeSshError, resolveSshTarget, ServerNotFoundError, shellQuote } from '../../services/sshConnection.js';
import type { JsonStore } from '../../storage/json-store.js';
import type { KeyStore } from '../../storage/key-store.js';
import { acceptWebSocketConnection, WebSocketMessageLimiter } from '../../security/rate-limit.js';
import { rawDataLength, rawDataToString, sendSocketData, sendSocketJson } from '../../utils/websocket.js';

interface TerminalRoutesOptions {
  store: JsonStore;
  keyStore: KeyStore;
  webSocketToken: string;
}

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
const NETHOGS_COMMAND = `
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
nethogs_bin="$(command -v nethogs 2>/dev/null || true)"
if [ -z "$nethogs_bin" ] && [ -x /usr/sbin/nethogs ]; then
  nethogs_bin=/usr/sbin/nethogs
fi
if [ -z "$nethogs_bin" ]; then
  printf 'nethogs is not installed on this server.\\n'
  printf 'Install nethogs on the target host, then reconnect this panel.\\n'
  sleep 3600
  exit 127
fi
clear
if [ "$(id -u)" = "0" ]; then
  exec "$nethogs_bin"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  exec sudo -n "$nethogs_bin"
else
  exec "$nethogs_bin"
fi
`.trim();

export const terminalRoutes: FastifyPluginAsync<TerminalRoutesOptions> = async (fastify, { store, keyStore, webSocketToken }) => {
  fastify.get<{ Params: { id: string } }>('/api/servers/:id/shell', { websocket: true }, (socket, request) => {
    if (!acceptWebSocketConnection(request, socket, 'Terminal', webSocketToken)) {
      return;
    }

    handleInteractiveSshSession(socket, 'Terminal', () => openTerminalSession(request.params.id, store, keyStore, socket));
  });

  fastify.get<{ Params: { id: string } }>('/api/servers/:id/nethogs-shell', { websocket: true }, (socket, request) => {
    if (!acceptWebSocketConnection(request, socket, 'NetHogs terminal', webSocketToken)) {
      return;
    }

    handleInteractiveSshSession(socket, 'NetHogs terminal', () => openNethogsSession(request.params.id, store, keyStore, socket));
  });
};

function handleInteractiveSshSession(
  socket: WebSocket,
  label: string,
  openSession: () => Promise<{ client: Client; stream: ClientChannel }>,
): void {
  let client: Client | undefined;
  let stream: ClientChannel | undefined;
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
    try {
      if (!messageLimiter.consume(socket, label)) {
        cleanup();
        return;
      }

      if (!stream) {
        pendingInputBytes += rawDataLength(data);

        if (pendingInputBytes > MAX_PENDING_INPUT_BYTES) {
          sendSocketJson(socket, {
            type: 'error',
            message: 'Terminal input queue exceeded the allowed size.',
          });
          socket.close(1009, 'Terminal input queue exceeded.');
          cleanup();
          return;
        }

        pendingInput.push(data);
        return;
      }

      forwardClientMessage(data, stream);
    } catch (error) {
      sendSocketJson(socket, {
        type: 'error',
        message: error instanceof Error ? normalizeSshError(error.message) : 'Terminal stream failed.',
      });
      socket.close(1011, 'Terminal stream failed.');
      cleanup();
    }
  });

  socket.once('close', cleanup);
  socket.once('error', cleanup);

  void openSession()
    .then((session) => {
      if (closed) {
        session.stream.destroy();
        closeSshClient(session.client);
        return;
      }

      client = session.client;
      stream = session.stream;

      for (const input of pendingInput.splice(0)) {
        forwardClientMessage(input, stream);
      }

      pendingInputBytes = 0;
    })
    .catch((error) => {
      sendSocketJson(socket, {
        type: 'error',
        message: normalizeTerminalError(error),
      });
      socket.close(1011, 'Terminal setup failed.');
      cleanup();
    });
}

async function openTerminalSession(
  serverId: string,
  store: JsonStore,
  keyStore: KeyStore,
  socket: WebSocket,
): Promise<{ client: Client; stream: ClientChannel }> {
  const target = await resolveSshTarget(store, keyStore, serverId);

  if (target.isLocal) {
    throw new Error('Interactive local terminals require an SSH profile for the target host because HomeDashboard does not spawn host PTYs from the web process.');
  }

  const client = await connectSsh(target.connectConfig);

  return new Promise((resolve, reject) => {
    client.shell(
      {
        term: 'xterm-256color',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      },
      (error, stream) => {
        if (error) {
          closeSshClient(client);
          reject(error);
          return;
        }

        stream.on('data', (chunk: Buffer) => {
          sendSocketData(socket, chunk);
        });

        stream.stderr.on('data', (chunk: Buffer) => {
          sendSocketData(socket, chunk);
        });

        stream.once('close', () => {
          if (socket.readyState === 1) {
            socket.close(1000, 'SSH shell closed.');
          }

          closeSshClient(client);
        });

        stream.once('error', (streamError: Error) => {
          sendSocketJson(socket, {
            type: 'error',
            message: normalizeSshError(streamError.message),
          });
          socket.close(1011, 'SSH shell error.');
          closeSshClient(client);
        });

        resolve({ client, stream });
      },
    );
  });
}

async function openNethogsSession(
  serverId: string,
  store: JsonStore,
  keyStore: KeyStore,
  socket: WebSocket,
): Promise<{ client: Client; stream: ClientChannel }> {
  const target = await resolveSshTarget(store, keyStore, serverId);

  if (target.isLocal) {
    throw new Error('Interactive local NetHogs requires an SSH profile for the target host because HomeDashboard does not spawn host PTYs from the web process.');
  }

  const client = await connectSsh(target.connectConfig);

  return new Promise((resolve, reject) => {
    client.exec(
      `/bin/sh -lc ${shellQuote(NETHOGS_COMMAND)}`,
      {
        pty: {
          term: 'xterm-256color',
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
        },
      },
      (error, stream) => {
        if (error) {
          closeSshClient(client);
          reject(error);
          return;
        }

        stream.on('data', (chunk: Buffer) => {
          sendSocketData(socket, chunk);
        });

        stream.stderr.on('data', (chunk: Buffer) => {
          sendSocketData(socket, chunk);
        });

        stream.once('close', () => {
          if (socket.readyState === 1) {
            socket.close(1000, 'NetHogs closed.');
          }

          closeSshClient(client);
        });

        stream.once('error', (streamError: Error) => {
          sendSocketJson(socket, {
            type: 'error',
            message: normalizeSshError(streamError.message),
          });
          socket.close(1011, 'NetHogs error.');
          closeSshClient(client);
        });

        resolve({ client, stream });
      },
    );
  });
}

function forwardClientMessage(data: RawData, stream: ClientChannel): void {
  const text = rawDataToString(data);
  const resize = text ? parseResizeMessage(text) : undefined;

  if (resize?.valid) {
    stream.setWindow(resize.rows, resize.cols, 0, 0);
    return;
  }

  if (resize?.type === 'resize') {
    return;
  }

  if (typeof data === 'string') {
    writeTerminalStream(stream, data);
  } else if (Buffer.isBuffer(data)) {
    writeTerminalStream(stream, data);
  } else if (Array.isArray(data)) {
    writeTerminalStream(stream, Buffer.concat(data));
  } else {
    writeTerminalStream(stream, Buffer.from(data));
  }
}

function parseResizeMessage(message: string): (ResizeMessage & { valid: true }) | { type: 'resize'; valid: false } | undefined {
  if (!message.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(message) as Partial<ResizeMessage>;

    if (
      parsed.type === 'resize' &&
      isValidWindowDimension(parsed.cols) &&
      isValidWindowDimension(parsed.rows)
    ) {
      return {
        type: 'resize',
        cols: parsed.cols,
        rows: parsed.rows,
        valid: true,
      };
    }

    if (parsed.type === 'resize') {
      return { type: 'resize', valid: false };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function writeTerminalStream(stream: ClientChannel, data: string | Buffer): void {
  try {
    stream.write(data);
  } catch {
    stream.destroy();
  }
}

function normalizeTerminalError(error: unknown): string {
  if (error instanceof ServerNotFoundError) {
    return error.message;
  }

  return error instanceof Error ? normalizeSshError(error.message) : 'SSH Connection Timeout or Refused';
}

function isValidWindowDimension(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 500;
}
