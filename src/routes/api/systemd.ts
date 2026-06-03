import type { FastifyPluginAsync } from 'fastify';
import { controlSystemdService, isSystemdServiceAction, listSystemdServices } from '../../services/systemdService.js';
import { ServerNotFoundError } from '../../services/sshConnection.js';
import type { JsonStore } from '../../storage/json-store.js';
import type { KeyStore } from '../../storage/key-store.js';
import { logRouteError, publicErrorMessage, redactedError } from '../../utils/api-errors.js';

interface SystemdRoutesOptions {
  store: JsonStore;
  keyStore: KeyStore;
}

interface SystemdListQuery {
  includeUser?: string;
  refresh?: string;
}

interface SystemdActionQuery {
  scope?: string;
}

export const systemdRoutes: FastifyPluginAsync<SystemdRoutesOptions> = async (fastify, { store, keyStore }) => {
  fastify.get<{ Params: { id: string }; Querystring: SystemdListQuery }>('/api/servers/:id/services', async (request, reply) => {
    try {
      const includeUser = request.query.includeUser === 'true';
      const forceRefresh = request.query.refresh === 'true';
      const result = await listSystemdServices(store, keyStore, request.params.id, includeUser, forceRefresh);

      if (!result.ok) {
        logRouteError(request.log, 'Systemd service list failed', {
          serverId: request.params.id,
          error: result.error,
        });
        return reply.code(400).send({
          error: 'Systemd Service Error',
          message: publicSystemdError(result.error, 'Unable to list systemd services.'),
        });
      }

      return reply.send({ services: result.services });
    } catch (error) {
      if (error instanceof ServerNotFoundError) {
        return reply.code(404).send({
          error: 'Not Found',
          message: error.message,
        });
      }

      logRouteError(request.log, 'Systemd service list failed', {
        serverId: request.params.id,
        error: redactedError(error),
      });
      return reply.code(400).send({
        error: 'Systemd Service Error',
        message: publicSystemdError(error, 'Unable to list systemd services.'),
      });
    }
  });

  fastify.post<{ Params: { id: string; serviceName: string; action: string }; Querystring: SystemdActionQuery }>('/api/servers/:id/services/:serviceName/:action', async (request, reply) => {
    if (!isSystemdServiceAction(request.params.action)) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'action must be start, stop, restart, enable, or disable.',
      });
    }

    try {
      const scope = request.query.scope === 'user' ? 'user' : 'system';
      const result = await controlSystemdService(store, keyStore, request.params.id, request.params.serviceName, request.params.action, scope);

      if (!result.ok) {
        logRouteError(request.log, 'Systemd service control failed', {
          serverId: request.params.id,
          serviceName: request.params.serviceName,
          action: request.params.action,
          error: result.error,
        });
        return reply.code(400).send({
          error: 'Systemd Service Error',
          message: publicSystemdError(result.error, 'Unable to control systemd service.'),
        });
      }

      return reply.send(result);
    } catch (error) {
      logRouteError(request.log, 'Systemd service control failed', {
        serverId: request.params.id,
        serviceName: request.params.serviceName,
        action: request.params.action,
        error: redactedError(error),
      });
      return reply.code(400).send({
        error: 'Systemd Service Error',
        message: publicSystemdError(error, 'Unable to control systemd service.'),
      });
    }
  });
};

function publicSystemdError(error: unknown, fallback: string): string {
  return publicErrorMessage(error, {
    fallback,
    allowedMessages: [
      'scope must be system or user.',
      'action must be start, stop, restart, enable, or disable.',
      'serviceName must be a valid systemd service unit name.',
      'User service actions require a systemd .service unit name.',
      'systemctl was not found.',
      'User systemd bus is not available for this SSH user.',
      'Passwordless sudo is required to control system systemd services.',
    ],
    allowedPatterns: [
      /^Failed to [^\r\n]{1,240}$/,
      /^Unit [A-Za-z0-9_.@:+-]+(?:\.service)? [^\r\n]{1,180}$/,
      /^Job for [A-Za-z0-9_.@:+-]+(?:\.service)? failed[^\r\n]{0,220}$/,
    ],
  });
}
