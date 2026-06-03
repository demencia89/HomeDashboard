import type { FastifyPluginAsync } from 'fastify';
import type { JsonStore } from '../storage/json-store.js';
import { logRouteError, redactedError } from '../utils/api-errors.js';

interface PreferenceRoutesOptions {
  store: JsonStore;
}

export const preferenceRoutes: FastifyPluginAsync<PreferenceRoutesOptions> = async (fastify, { store }) => {
  fastify.get('/api/preferences', async (request, reply) => {
    try {
      return await store.getPreferences();
    } catch (error) {
      logRouteError(request.log, 'Unable to read preferences', { error: redactedError(error) });
      return reply.code(500).send({
        error: 'Storage Error',
        message: 'Unable to read preferences.',
      });
    }
  });

  fastify.put('/api/preferences', async (request, reply) => {
    try {
      return await store.replacePreferences(request.body ?? {});
    } catch (error) {
      logRouteError(request.log, 'Invalid preferences replace request', { error: redactedError(error) });
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Invalid preferences.',
      });
    }
  });

  fastify.patch('/api/preferences', async (request, reply) => {
    try {
      return await store.patchPreferences(request.body ?? {});
    } catch (error) {
      logRouteError(request.log, 'Invalid preferences patch request', { error: redactedError(error) });
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Invalid preferences patch.',
      });
    }
  });
};
