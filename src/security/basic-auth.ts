import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { consumeAuthFailure, sendRateLimitError } from './rate-limit.js';

const REALM = 'HomeDashboard';

interface BasicAuthOptions {
  username: string;
  password: string;
  disabled: boolean;
}

export function registerBasicAuth(app: FastifyInstance, options: BasicAuthOptions): void {
  if (options.disabled) {
    app.log.warn('Basic authentication is disabled by AUTH_DISABLED=true.');
    return;
  }

  if (!options.username || !options.password) {
    throw new Error('AUTH_USERNAME and AUTH_PASSWORD are required when authentication is enabled.');
  }

  app.addHook('onRequest', async (request, reply) => {
    if (isAuthorized(request, options.username, options.password)) {
      return;
    }

    const result = consumeAuthFailure(request);

    if (!result.allowed) {
      await sendRateLimitError(reply, result, 'Too many authentication failures. Please wait and retry.');
      return;
    }

    await rejectUnauthorized(reply);
  });
}

function isAuthorized(request: FastifyRequest, username: string, password: string): boolean {
  const authorization = request.headers.authorization;

  if (!authorization?.startsWith('Basic ')) {
    return false;
  }

  const decoded = decodeBasicCredentials(authorization.slice('Basic '.length));

  if (!decoded) {
    return false;
  }

  return timingSafeEqual(decoded.username, username) && timingSafeEqual(decoded.password, password);
}

function decodeBasicCredentials(value: string): { username: string; password: string } | undefined {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');

    if (separator < 0) {
      return undefined;
    }

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return undefined;
  }
}

function timingSafeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

async function rejectUnauthorized(reply: FastifyReply): Promise<void> {
  await reply
    .header('www-authenticate', `Basic realm="${REALM}", charset="UTF-8"`)
    .code(401)
    .send({
      error: 'Unauthorized',
      message: 'Authentication is required.',
    });
}
