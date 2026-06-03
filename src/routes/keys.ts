import type { FastifyPluginAsync } from 'fastify';
import type { KeyStore } from '../storage/key-store.js';
import { logRouteError, publicErrorMessage, redactedError } from '../utils/api-errors.js';

interface KeyRoutesOptions {
  keyStore: KeyStore;
}

interface UploadKeyBody {
  name?: unknown;
  privateKey?: unknown;
}

export const keyRoutes: FastifyPluginAsync<KeyRoutesOptions> = async (fastify, { keyStore }) => {
  fastify.get('/api/keys', async (request, reply) => {
    try {
      const keys = await keyStore.list();
      return keys.map((name) => ({ name }));
    } catch (error) {
      logRouteError(request.log, 'Unable to list keys', { error: redactedError(error) });
      return reply.code(500).send({
        error: 'Key Store Error',
        message: 'Unable to list keys.',
      });
    }
  });

  fastify.post('/api/keys', async (request, reply) => {
    try {
      const body = request.body as UploadKeyBody;

      if (!body || typeof body.name !== 'string' || typeof body.privateKey !== 'string') {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'name and privateKey are required string fields.',
        });
      }

      const key = await keyStore.save(body.name.trim(), body.privateKey);
      return reply.code(201).send({ name: key.name });
    } catch (error) {
      logRouteError(request.log, 'Invalid private key upload', { error: redactedError(error) });
      return reply.code(400).send({
        error: 'Bad Request',
        message: publicErrorMessage(error, {
          fallback: 'Invalid private key upload.',
          allowedMessages: [
            'Key name may only contain letters, numbers, dots, underscores, and dashes.',
            'Invalid key path.',
          ],
          allowedPatterns: [/^Private key must be between 1 byte and \d+ bytes\.$/],
        }),
      });
    }
  });
};
