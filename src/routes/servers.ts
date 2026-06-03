import type { FastifyPluginAsync } from 'fastify';
import { testConnection } from '../services/connectionTestService.js';
import type { JsonStore } from '../storage/json-store.js';
import type { KeyStore } from '../storage/key-store.js';
import { ServerNotFoundError } from '../services/sshConnection.js';
import { sanitizeServerProfile } from '../utils/publicProfile.js';
import { logRouteError, publicErrorMessage, redactedError } from '../utils/api-errors.js';

interface ServerRoutesOptions {
  store: JsonStore;
  keyStore: KeyStore;
}

export const serverRoutes: FastifyPluginAsync<ServerRoutesOptions> = async (fastify, { store, keyStore }) => {
  fastify.get('/api/servers', async (request, reply) => {
    try {
      const servers = await store.listServers();
      return servers.map(sanitizeServerProfile);
    } catch (error) {
      logRouteError(request.log, 'Unable to list server profiles', { error: redactedError(error) });
      return reply.code(500).send({
        error: 'Storage Error',
        message: 'Unable to list server profiles.',
      });
    }
  });

  fastify.post('/api/servers', async (request, reply) => {
    try {
      const profile = await store.createServer(request.body ?? {});
      return reply.code(201).send(sanitizeServerProfile(profile));
    } catch (error) {
      logRouteError(request.log, 'Invalid server profile create request', { error: redactedError(error) });
      return reply.code(400).send({
        error: 'Bad Request',
        message: publicServerProfileError(error, 'Invalid server profile.'),
      });
    }
  });

  fastify.put<{ Params: { id: string } }>('/api/servers/:id', async (request, reply) => {
    try {
      const profile = await store.updateServer(request.params.id, request.body ?? {});

      if (!profile) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Server profile was not found.',
        });
      }

      return reply.send(sanitizeServerProfile(profile));
    } catch (error) {
      logRouteError(request.log, 'Invalid server profile update request', {
        serverId: request.params.id,
        error: redactedError(error),
      });
      return reply.code(400).send({
        error: 'Bad Request',
        message: publicServerProfileError(error, 'Invalid server profile update.'),
      });
    }
  });

  fastify.post<{ Params: { id: string } }>('/api/servers/:id/test', async (request, reply) => {
    try {
      return await testConnection(store, keyStore, request.params.id);
    } catch (error) {
      if (error instanceof ServerNotFoundError) {
        return reply.code(404).send({
          error: 'Not Found',
          message: error.message,
        });
      }

      logRouteError(request.log, 'Server connection test failed', {
        serverId: request.params.id,
        error: redactedError(error),
      });
      return reply.send({
        online: false,
        latencyMs: 0,
        error: publicErrorMessage(error, { fallback: 'Connection test failed.' }),
      });
    }
  });

  fastify.delete<{ Params: { id: string } }>('/api/servers/:id', async (request, reply) => {
    try {
      const deleted = await store.deleteServer(request.params.id);

      if (!deleted) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Server profile was not found.',
        });
      }

      return reply.code(204).send();
    } catch (error) {
      logRouteError(request.log, 'Unable to delete server profile', {
        serverId: request.params.id,
        error: redactedError(error),
      });
      return reply.code(500).send({
        error: 'Storage Error',
        message: 'Unable to delete server profile.',
      });
    }
  });
};

const SERVER_PROFILE_ERROR_PATTERNS = [
  /^.+ is required\.$/,
  /^.+ must be a string\.$/,
  /^.+ must be one of: [A-Za-z0-9, _.-]+\.$/,
  /^port must be an integer between 1 and 65535\.$/,
];

const SERVER_PROFILE_ERROR_MESSAGES = [
  'privateKey can only be supplied when authMethod is "privateKey".',
  'password is required when authMethod is "password".',
  'password can only be supplied when authMethod is "password".',
  'privateKeyName is required when authMethod is "privateKey".',
  'password is required when changing authMethod to "password".',
  'At least one server profile field must be supplied.',
  'authMethod must be either "password" or "privateKey".',
];

function publicServerProfileError(error: unknown, fallback: string): string {
  return publicErrorMessage(error, {
    fallback,
    allowedMessages: SERVER_PROFILE_ERROR_MESSAGES,
    allowedPatterns: SERVER_PROFILE_ERROR_PATTERNS,
  });
}
