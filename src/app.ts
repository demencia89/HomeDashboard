import cors from '@fastify/cors';
import staticFiles from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_DISABLED, AUTH_PASSWORD, AUTH_USERNAME, CORS_ORIGIN, DATABASE_FILE, KEYS_DIR } from './config.js';
import { fileRoutes } from './routes/api/files.js';
import { systemdRoutes } from './routes/api/systemd.js';
import { telemetryRoutes } from './routes/api/telemetry.js';
import { terminalRoutes } from './routes/api/terminal.js';
import { vncRoutes } from './routes/api/vnc.js';
import { keyRoutes } from './routes/keys.js';
import { preferenceRoutes } from './routes/preferences.js';
import { serverRoutes } from './routes/servers.js';
import { registerBasicAuth } from './security/basic-auth.js';
import { createWebSocketToken, registerExpensiveHttpRateLimit } from './security/rate-limit.js';
import { deleteWallpaper, getWallpaperImage, getWallpaperInfo, saveWallpaper } from './services/appWallpaperService.js';
import { getAppVersionInfo } from './services/appVersionService.js';
import { JsonStore } from './storage/json-store.js';
import { KeyStore } from './storage/key-store.js';
import { redactedError } from './utils/api-errors.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: redactWebSocketToken(request.url),
            host: request.headers.host,
            remoteAddress: request.ip,
            remotePort: request.socket.remotePort,
          };
        },
      },
    },
  });

  const keyStore = new KeyStore(KEYS_DIR);
  const store = new JsonStore(DATABASE_FILE, keyStore);
  const webSocketToken = createWebSocketToken();

  await keyStore.init();
  await store.init();

  registerSecurityHeaders(app);

  app.setErrorHandler((error, request, reply) => {
    const statusCode = requestErrorStatusCode(error);

    if (statusCode === 500) {
      request.log.error({ error: redactedError(error) }, 'Unhandled request error');
    } else {
      request.log.warn({ error: redactedError(error) }, 'Rejected request');
    }

    return reply.code(statusCode).send({
      error: statusCode === 413 ? 'Payload Too Large' : statusCode === 400 ? 'Bad Request' : 'Request Error',
      message: statusCode === 500
        ? 'The request could not be completed.'
        : statusCode === 413
          ? 'Request body is too large.'
          : 'Request rejected.',
    });
  });

  await app.register(cors, {
    origin: CORS_ORIGIN,
  });
  await app.register(websocket);
  registerBasicAuth(app, {
    username: AUTH_USERNAME,
    password: AUTH_PASSWORD,
    disabled: AUTH_DISABLED,
  });
  registerExpensiveHttpRateLimit(app);

  app.get('/health', async () => ({ ok: true }));
  app.get('/api/app/version', async () => getAppVersionInfo());
  app.get('/api/app/wallpaper', async () => getWallpaperInfo());
  app.get('/api/app/wallpaper/image', async (_request, reply) => {
    const wallpaper = await getWallpaperImage();

    if (!wallpaper) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Wallpaper image was not found.',
      });
    }

    return reply
      .type(wallpaper.mimeType)
      .header('Cache-Control', 'no-store')
      .header('Last-Modified', new Date(wallpaper.updatedAt).toUTCString())
      .send(wallpaper.buffer);
  });
  app.put('/api/app/wallpaper', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    try {
      return await saveWallpaper(request.body);
    } catch (error) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: error instanceof Error ? error.message : 'Unable to save wallpaper.',
      });
    }
  });
  app.delete('/api/app/wallpaper', async () => deleteWallpaper());
  app.get('/api/ws-token', async () => ({ token: webSocketToken }));
  await app.register(serverRoutes, { store, keyStore });
  await app.register(preferenceRoutes, { store });
  await app.register(keyRoutes, { keyStore });
  await app.register(telemetryRoutes, { store, keyStore, webSocketToken });
  await app.register(systemdRoutes, { store, keyStore });
  await app.register(terminalRoutes, { store, keyStore, webSocketToken });
  await app.register(vncRoutes, { store, keyStore, webSocketToken });
  await app.register(fileRoutes, { store, keyStore });
  await registerFrontend(app);

  return app;
}

function redactWebSocketToken(url: string): string {
  try {
    const parsed = new URL(url, 'http://homedashboard.local');

    if (parsed.searchParams.has('token')) {
      parsed.searchParams.set('token', '[redacted]');
    }

    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.replace(/([?&]token=)[^&]+/g, '$1[redacted]');
  }
}

function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');

    if (request.raw.url?.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
    }
  });
}

function requestErrorStatusCode(error: unknown): number {
  if (!error || typeof error !== 'object' || !('statusCode' in error)) {
    return 500;
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
}

async function registerFrontend(app: FastifyInstance): Promise<void> {
  const currentFile = fileURLToPath(import.meta.url);
  const publicDir = path.resolve(path.dirname(currentFile), 'public');
  const indexFile = path.join(publicDir, 'index.html');

  if (!fs.existsSync(indexFile)) {
    return;
  }

  app.addHook('onSend', (request, reply, _payload, done) => {
    const requestPath = request.raw.url?.split('?')[0] ?? '';
    const acceptsHtml = String(request.headers.accept ?? '').includes('text/html');

    if (requestPath === '/' || requestPath === '/index.html' || requestPath === '/service-worker.js' || (acceptsHtml && !requestPath.startsWith('/api/'))) {
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      reply.header('Pragma', 'no-cache');
      reply.header('Expires', '0');
    }

    done();
  });

  await app.register(staticFiles, {
    root: publicDir,
    prefix: '/',
    setHeaders(response, filePath) {
      const fileName = path.basename(filePath);

      if (fileName === 'service-worker.js' || fileName === 'index.html') {
        response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        response.setHeader('Pragma', 'no-cache');
        response.setHeader('Expires', '0');
      }
    },
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (request.raw.url?.startsWith('/api/')) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'API route was not found.',
      });
    }

    return reply.sendFile('index.html');
  });
}
