import type { FastifyPluginAsync } from 'fastify';
import { controlDockerContainer, getDockerComposeFile, getDockerContainerLogs, isDockerContainerAction, updateDockerComposeFile } from '../../services/dockerService.js';
import { MetricsStreamHub } from '../../services/metricsStreamService.js';
import { getNethogsSnapshot } from '../../services/networkService.js';
import { killProcess } from '../../services/processService.js';
import { getTemperatureSnapshot } from '../../services/temperatureService.js';
import { ServerNotFoundError } from '../../services/sshConnection.js';
import type { JsonStore } from '../../storage/json-store.js';
import type { KeyStore } from '../../storage/key-store.js';
import { acceptWebSocketConnection } from '../../security/rate-limit.js';
import { logRouteError, publicErrorMessage, redactedError } from '../../utils/api-errors.js';
import { parseStrictInteger } from '../../utils/strict-integer.js';

interface TelemetryRoutesOptions {
  store: JsonStore;
  keyStore: KeyStore;
  webSocketToken: string;
}

interface ContainerLogsQuery {
  tail?: string;
}

interface ContainerComposeBody {
  content?: string;
}

interface MetricsQuery {
  refresh?: string;
}

export const telemetryRoutes: FastifyPluginAsync<TelemetryRoutesOptions> = async (fastify, { store, keyStore, webSocketToken }) => {
  const metricsHub = new MetricsStreamHub(store, keyStore);

  fastify.addHook('onClose', (_instance, done) => {
    metricsHub.close();
    done();
  });

  fastify.get('/api/metrics/stream', { websocket: true }, (socket, request) => {
    if (!acceptWebSocketConnection(request, socket, 'Metrics stream', webSocketToken, 'metrics')) {
      return;
    }

    metricsHub.handleSocket(socket);
  });

  fastify.get<{ Params: { id: string }; Querystring: MetricsQuery }>('/api/servers/:id/metrics', async (request, reply) => {
    try {
      const metrics = await metricsHub.getSnapshot(request.params.id, request.query.refresh === 'true');
      return reply.send(metrics);
    } catch (error) {
      if (error instanceof ServerNotFoundError) {
        return reply.code(404).send({
          error: 'Not Found',
          message: error.message,
        });
      }

      throw error;
    }
  });

  fastify.get<{ Params: { id: string } }>('/api/servers/:id/network/nethogs', async (request, reply) => {
    try {
      const result = await getNethogsSnapshot(store, keyStore, request.params.id);
      return reply.send(result.error ? { ...result, error: publicTelemetryError(result.error, 'Unable to read nethogs output.') } : result);
    } catch (error) {
      if (error instanceof ServerNotFoundError) {
        return reply.code(404).send({
          error: 'Not Found',
          message: error.message,
        });
      }

      throw error;
    }
  });

  fastify.get<{ Params: { id: string } }>('/api/servers/:id/temperature', async (request, reply) => {
    try {
      const result = await getTemperatureSnapshot(store, keyStore, request.params.id);
      return reply.send(result.error ? { ...result, error: publicTelemetryError(result.error, 'Unable to read temperature sensors.') } : result);
    } catch (error) {
      if (error instanceof ServerNotFoundError) {
        return reply.code(404).send({
          error: 'Not Found',
          message: error.message,
        });
      }

      throw error;
    }
  });

  fastify.post<{ Params: { id: string; pid: string } }>('/api/servers/:id/processes/:pid/kill', async (request, reply) => {
    let pid: number;

    try {
      pid = parseStrictInteger(request.params.pid, 'pid', { min: 2, max: 4_194_304 });
    } catch (error) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: error instanceof Error ? error.message : 'pid must be an integer.',
      });
    }

    const result = await killProcess(store, keyStore, request.params.id, pid);

    if (!result.ok) {
      logRouteError(request.log, 'Process kill failed', {
        serverId: request.params.id,
        pid,
        error: result.error,
      });
      return reply.code(400).send({
        error: 'Process Control Error',
        message: publicTelemetryError(result.error, 'Unable to kill process.'),
      });
    }

    return reply.send(result);
  });

  fastify.post<{ Params: { id: string; containerId: string; action: string } }>('/api/servers/:id/containers/:containerId/:action', async (request, reply) => {
    if (!isDockerContainerAction(request.params.action)) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'action must be start, stop, or restart.',
      });
    }

    try {
      const result = await controlDockerContainer(store, keyStore, request.params.id, request.params.containerId, request.params.action);

      if (!result.ok) {
        logRouteError(request.log, 'Docker container control failed', {
          serverId: request.params.id,
          containerId: request.params.containerId,
          action: request.params.action,
          error: result.error,
        });
        return reply.code(400).send({
          error: 'Docker Control Error',
          message: publicDockerError(result.error, 'Unable to control Docker container.'),
        });
      }

      return reply.send(result);
    } catch (error) {
      logRouteError(request.log, 'Docker container control failed', {
        serverId: request.params.id,
        containerId: request.params.containerId,
        action: request.params.action,
        error: redactedError(error),
      });
      return reply.code(400).send({
        error: 'Docker Control Error',
        message: publicDockerError(error, 'Unable to control Docker container.'),
      });
    }
  });

  fastify.get<{ Params: { id: string; containerId: string }; Querystring: ContainerLogsQuery }>('/api/servers/:id/containers/:containerId/logs', async (request, reply) => {
    const tail = request.query.tail ? Number.parseInt(request.query.tail, 10) : 200;
    let result;

    try {
      result = await getDockerContainerLogs(store, keyStore, request.params.id, request.params.containerId, tail);
    } catch (error) {
      logRouteError(request.log, 'Docker logs failed', {
        serverId: request.params.id,
        containerId: request.params.containerId,
        error: redactedError(error),
      });
      return reply.code(400).send({
        error: 'Docker Logs Error',
        message: publicDockerError(error, 'Unable to read Docker container logs.'),
      });
    }

    if (!result.ok) {
      logRouteError(request.log, 'Docker logs failed', {
        serverId: request.params.id,
        containerId: request.params.containerId,
        error: result.error,
      });
      return reply.code(400).send({
        error: 'Docker Logs Error',
        message: publicDockerError(result.error, 'Unable to read Docker container logs.'),
      });
    }

    return reply.send({
      containerId: result.containerId,
      logs: result.logs ?? '',
    });
  });

  fastify.get<{ Params: { id: string; containerId: string } }>('/api/servers/:id/containers/:containerId/compose', async (request, reply) => {
    let result;

    try {
      result = await getDockerComposeFile(store, keyStore, request.params.id, request.params.containerId);
    } catch (error) {
      logRouteError(request.log, 'Docker Compose read failed', {
        serverId: request.params.id,
        containerId: request.params.containerId,
        error: redactedError(error),
      });
      return reply.code(400).send({
        error: 'Docker Compose Error',
        message: publicDockerError(error, 'Unable to read Docker Compose file.'),
      });
    }

    if (!result.ok) {
      logRouteError(request.log, 'Docker Compose read failed', {
        serverId: request.params.id,
        containerId: request.params.containerId,
        error: result.error,
      });
      return reply.code(400).send({
        error: 'Docker Compose Error',
        message: publicDockerError(result.error, 'Unable to read Docker Compose file.'),
      });
    }

    return reply.send(result);
  });

  fastify.put<{ Params: { id: string; containerId: string }; Body: ContainerComposeBody }>('/api/servers/:id/containers/:containerId/compose', async (request, reply) => {
    if (typeof request.body?.content !== 'string') {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'content must be a string.',
      });
    }

    let result;

    try {
      result = await updateDockerComposeFile(store, keyStore, request.params.id, request.params.containerId, request.body.content);
    } catch (error) {
      logRouteError(request.log, 'Docker Compose update failed', {
        serverId: request.params.id,
        containerId: request.params.containerId,
        error: redactedError(error),
      });
      return reply.code(400).send({
        error: 'Docker Compose Error',
        message: publicDockerError(error, 'Unable to update Docker Compose file.'),
      });
    }

    if (!result.ok) {
      logRouteError(request.log, 'Docker Compose update failed', {
        serverId: request.params.id,
        containerId: request.params.containerId,
        error: result.error,
      });
      return reply.code(400).send({
        error: 'Docker Compose Error',
        message: publicDockerError(result.error, 'Unable to update Docker Compose file.'),
      });
    }

    return reply.send(result);
  });
};

function publicTelemetryError(error: unknown, fallback: string): string {
  return publicErrorMessage(error, { fallback });
}

function publicDockerError(error: unknown, fallback: string): string {
  return publicErrorMessage(error, {
    fallback,
    allowedMessages: [
      'This container was not created from a discoverable Docker Compose file.',
      'action must be start, stop, or restart.',
      'containerId must be a valid Docker container id or name.',
      'Docker Compose content cannot be empty.',
      'Docker Compose content is too large.',
    ],
  });
}
