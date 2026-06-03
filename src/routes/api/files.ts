import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { FileEntry, SFTPWrapper, Stats } from 'ssh2';
import { normalizeSshError, resolveSshTarget, ServerNotFoundError, SSH_READY_TIMEOUT_MS, withSftpSession } from '../../services/sshConnection.js';
import type { JsonStore } from '../../storage/json-store.js';
import type { KeyStore } from '../../storage/key-store.js';
import { LOCAL_FILE_ROOT } from '../../config.js';
import { logRouteError, publicFileErrorMessage, redactedError } from '../../utils/api-errors.js';

export interface FileItem {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  permissions: string;
  modifyTime: number;
}

interface FileRoutesOptions {
  store: JsonStore;
  keyStore: KeyStore;
}

interface FileQuery {
  path?: string;
  recursive?: string;
}

interface WriteFileBody {
  path?: unknown;
  content?: unknown;
}

interface UploadFileBody {
  path?: unknown;
  contentBase64?: unknown;
}

interface PathBody {
  path?: unknown;
}

interface RenameBody {
  from?: unknown;
  to?: unknown;
}

const JSON_BODY_OVERHEAD_BYTES = 64 * 1024;
export const MAX_READ_BYTES = 1024 * 1024;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const WRITE_FILE_BODY_LIMIT_BYTES = MAX_UPLOAD_BYTES + JSON_BODY_OVERHEAD_BYTES;
export const UPLOAD_FILE_BODY_LIMIT_BYTES = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + JSON_BODY_OVERHEAD_BYTES;
const SFTP_OPERATION_TIMEOUT_MS = SSH_READY_TIMEOUT_MS * 4;
const LOCAL_ROOT = path.resolve(LOCAL_FILE_ROOT);

export const fileRoutes: FastifyPluginAsync<FileRoutesOptions> = async (fastify, { store, keyStore }) => {
  fastify.get<{ Params: { id: string }; Querystring: FileQuery }>('/api/servers/:id/files', async (request, reply) => {
    try {
      const target = await resolveSshTarget(store, keyStore, request.params.id);
      const requestedPath = normalizeOptionalPath(request.query.path);
      const directoryPath = target.isLocal ? await resolveExistingLocalPath(requestedPath) : requestedPath ?? '.';
      const items = target.isLocal
        ? await listLocalDirectory(directoryPath)
        : await withSftpSession(target.connectConfig, (sftp) => readdir(sftp, directoryPath));

      return reply.send({
        path: directoryPath,
        items,
      });
    } catch (error) {
      return sendFileError(request.log, reply, error, 'File list failed', { serverId: request.params.id });
    }
  });

  fastify.get<{ Params: { id: string }; Querystring: FileQuery }>('/api/servers/:id/files/read', async (request, reply) => {
    try {
      const filePath = requirePath(request.query.path);
      const target = await resolveSshTarget(store, keyStore, request.params.id);
      const buffer = target.isLocal
        ? await readLocalFile(filePath, MAX_READ_BYTES)
        : await withSftpSession(target.connectConfig, (sftp) => readRemoteFile(sftp, filePath, MAX_READ_BYTES));

      return reply.send({
        path: filePath,
        content: buffer.toString('utf8'),
        size: buffer.length,
        encoding: 'utf8',
      });
    } catch (error) {
      return sendFileError(request.log, reply, error, 'File read failed', { serverId: request.params.id });
    }
  });

  fastify.get<{ Params: { id: string }; Querystring: FileQuery }>('/api/servers/:id/files/download', async (request, reply) => {
    try {
      const filePath = requirePath(request.query.path);
      const target = await resolveSshTarget(store, keyStore, request.params.id);
      const buffer = target.isLocal
        ? await downloadLocalFile(filePath)
        : await withSftpSession(target.connectConfig, (sftp) => downloadRemoteFile(sftp, filePath));

      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${escapeHeaderFilename(path.basename(filePath))}"`)
        .send(buffer);
    } catch (error) {
      return sendFileError(request.log, reply, error, 'File download failed', { serverId: request.params.id });
    }
  });

  fastify.put<{ Params: { id: string }; Body: WriteFileBody }>('/api/servers/:id/files/write', { bodyLimit: WRITE_FILE_BODY_LIMIT_BYTES }, async (request, reply) => {
    try {
      const filePath = requirePath(request.body.path);
      const content = requireString(request.body.content, 'content');
      const target = await resolveSshTarget(store, keyStore, request.params.id);
      const data = Buffer.from(content, 'utf8');

      assertMaxBytes(data, MAX_UPLOAD_BYTES, 'File content');

      if (target.isLocal) {
        await fs.writeFile(await resolveWritableLocalPath(filePath), data, { mode: 0o600 });
      } else {
        await withSftpSession(target.connectConfig, (sftp) => writeRemoteFile(sftp, filePath, data));
      }

      return reply.send({ ok: true, path: filePath, size: data.length });
    } catch (error) {
      return sendFileError(request.log, reply, error, 'File write failed', { serverId: request.params.id });
    }
  });

  fastify.post<{ Params: { id: string }; Body: UploadFileBody }>('/api/servers/:id/files/upload', { bodyLimit: UPLOAD_FILE_BODY_LIMIT_BYTES }, async (request, reply) => {
    try {
      const filePath = requirePath(request.body.path);
      const contentBase64 = requireString(request.body.contentBase64, 'contentBase64');
      const data = decodeBase64(contentBase64);

      assertMaxBytes(data, MAX_UPLOAD_BYTES, 'Uploaded file');

      const target = await resolveSshTarget(store, keyStore, request.params.id);

      if (target.isLocal) {
        await fs.writeFile(await resolveWritableLocalPath(filePath), data, { mode: 0o600 });
      } else {
        await withSftpSession(target.connectConfig, (sftp) => writeRemoteFile(sftp, filePath, data));
      }

      return reply.code(201).send({ ok: true, path: filePath, size: data.length });
    } catch (error) {
      return sendFileError(request.log, reply, error, 'File upload failed', { serverId: request.params.id });
    }
  });

  fastify.post<{ Params: { id: string }; Body: PathBody }>('/api/servers/:id/files/mkdir', async (request, reply) => {
    try {
      const directoryPath = requirePath(request.body.path);
      const target = await resolveSshTarget(store, keyStore, request.params.id);

      if (target.isLocal) {
        await fs.mkdir(await resolveDirectoryCreateLocalPath(directoryPath), { recursive: true, mode: 0o700 });
      } else {
        await withSftpSession(target.connectConfig, (sftp) => mkdirRemote(sftp, directoryPath));
      }

      return reply.code(201).send({ ok: true, path: directoryPath });
    } catch (error) {
      return sendFileError(request.log, reply, error, 'Directory create failed', { serverId: request.params.id });
    }
  });

  fastify.post<{ Params: { id: string }; Body: RenameBody }>('/api/servers/:id/files/rename', async (request, reply) => {
    try {
      const from = requirePath(request.body.from);
      const to = requirePath(request.body.to);
      const target = await resolveSshTarget(store, keyStore, request.params.id);

      if (target.isLocal) {
        await fs.rename(await resolveCheckedLocalPath(from), await resolveWritableLocalPath(to));
      } else {
        await withSftpSession(target.connectConfig, (sftp) => renameRemote(sftp, from, to));
      }

      return reply.send({ ok: true, from, to });
    } catch (error) {
      return sendFileError(request.log, reply, error, 'File rename failed', { serverId: request.params.id });
    }
  });

  fastify.delete<{ Params: { id: string }; Querystring: FileQuery }>('/api/servers/:id/files', async (request, reply) => {
    try {
      const filePath = requirePath(request.query.path);
      const recursive = request.query.recursive === 'true';
      const target = await resolveSshTarget(store, keyStore, request.params.id);

      if (target.isLocal) {
        await fs.rm(await resolveCheckedLocalPath(filePath), { recursive, force: false });
      } else {
        await withSftpSession(target.connectConfig, (sftp) => deleteRemote(sftp, filePath, recursive));
      }

      return reply.send({ ok: true, path: filePath });
    } catch (error) {
      return sendFileError(request.log, reply, error, 'File delete failed', { serverId: request.params.id });
    }
  });
};

function readdir(sftp: SFTPWrapper, directory: string): Promise<FileItem[]> {
  return withSftpOperation('SFTP readdir', (done) => {
    sftp.readdir(directory, (error, entries) => {
      if (error) {
        done(error);
        return;
      }

      done(undefined, entries.map(mapSftpEntry).sort(sortFileItems));
    });
  });
}

function readRemoteFile(sftp: SFTPWrapper, filePath: string, maxBytes?: number): Promise<Buffer> {
  return withSftpOperation('SFTP readFile', (done) => {
    sftp.readFile(filePath, (error, buffer) => {
      if (error) {
        done(error);
        return;
      }

      try {
        if (maxBytes) {
          assertMaxBytes(buffer, maxBytes, 'File');
        }

        done(undefined, buffer);
      } catch (sizeError) {
        done(sizeError instanceof Error ? sizeError : new Error('File read failed.'));
      }
    });
  });
}

async function downloadRemoteFile(sftp: SFTPWrapper, filePath: string): Promise<Buffer> {
  const stat = await statRemote(sftp, filePath);
  assertMaxBytes(stat.size, MAX_DOWNLOAD_BYTES, 'Download');
  return readRemoteFile(sftp, filePath, MAX_DOWNLOAD_BYTES);
}

function writeRemoteFile(sftp: SFTPWrapper, filePath: string, data: Buffer): Promise<void> {
  return withSftpOperation('SFTP writeFile', (done) => {
    sftp.writeFile(filePath, data, { mode: 0o600 }, (error) => {
      done(error);
    });
  });
}

function mkdirRemote(sftp: SFTPWrapper, directoryPath: string): Promise<void> {
  return withSftpOperation('SFTP mkdir', (done) => {
    sftp.mkdir(directoryPath, { mode: 0o700 }, (error) => {
      done(error);
    });
  });
}

function renameRemote(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return withSftpOperation('SFTP rename', (done) => {
    sftp.rename(from, to, (error) => {
      done(error);
    });
  });
}

async function deleteRemote(sftp: SFTPWrapper, filePath: string, recursive: boolean): Promise<void> {
  const stat = await lstatRemote(sftp, filePath);

  if (stat.isDirectory()) {
    if (recursive) {
      const entries = await readdirRaw(sftp, filePath);

      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') {
          continue;
        }

        await deleteRemote(sftp, joinRemotePath(filePath, entry.filename), true);
      }
    }

    await rmdirRemote(sftp, filePath);
    return;
  }

  await unlinkRemote(sftp, filePath);
}

function lstatRemote(sftp: SFTPWrapper, filePath: string): Promise<Stats> {
  return withSftpOperation('SFTP lstat', (done) => {
    sftp.lstat(filePath, (error, stat) => {
      if (error) {
        done(error);
        return;
      }

      done(undefined, stat);
    });
  });
}

function statRemote(sftp: SFTPWrapper, filePath: string): Promise<Stats> {
  return withSftpOperation('SFTP stat', (done) => {
    sftp.stat(filePath, (error, stat) => {
      if (error) {
        done(error);
        return;
      }

      done(undefined, stat);
    });
  });
}

function readdirRaw(sftp: SFTPWrapper, directory: string): Promise<FileEntry[]> {
  return withSftpOperation('SFTP readdir', (done) => {
    sftp.readdir(directory, (error, entries) => {
      if (error) {
        done(error);
        return;
      }

      done(undefined, entries);
    });
  });
}

function rmdirRemote(sftp: SFTPWrapper, directoryPath: string): Promise<void> {
  return withSftpOperation('SFTP rmdir', (done) => {
    sftp.rmdir(directoryPath, (error) => {
      done(error);
    });
  });
}

function unlinkRemote(sftp: SFTPWrapper, filePath: string): Promise<void> {
  return withSftpOperation('SFTP unlink', (done) => {
    sftp.unlink(filePath, (error) => {
      done(error);
    });
  });
}

function withSftpOperation<T>(
  label: string,
  start: (done: (error?: Error | null, value?: T) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const done = (error?: Error | null, value?: T) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (error) {
        reject(error);
      } else {
        resolve(value as T);
      }
    };

    timer = setTimeout(() => {
      done(new Error(`${label} timed out.`));
    }, SFTP_OPERATION_TIMEOUT_MS);

    try {
      start(done);
    } catch (error) {
      done(error instanceof Error ? error : new Error(`${label} failed.`));
    }
  });
}

async function listLocalDirectory(directory: string): Promise<FileItem[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });

  const items = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      const stat = await fs.lstat(fullPath);

      return {
        name: entry.name,
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        permissions: modeToPermissions(stat.mode),
        modifyTime: Math.floor(stat.mtimeMs / 1000),
      } satisfies FileItem;
    }),
  );

  return items.sort(sortFileItems);
}

async function readLocalFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const resolved = await resolveExistingLocalPath(filePath);
  const stat = await fs.stat(resolved);
  assertMaxBytes(stat.size, maxBytes, 'File');
  return fs.readFile(resolved);
}

async function downloadLocalFile(filePath: string): Promise<Buffer> {
  const resolved = await resolveExistingLocalPath(filePath);
  const stat = await fs.stat(resolved);
  assertMaxBytes(stat.size, MAX_DOWNLOAD_BYTES, 'Download');
  return fs.readFile(resolved);
}

function mapSftpEntry(entry: FileEntry): FileItem {
  return {
    name: entry.filename,
    type: typeFromMode(entry.attrs.mode),
    size: entry.attrs.size,
    permissions: modeToPermissions(entry.attrs.mode),
    modifyTime: entry.attrs.mtime,
  };
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  if (trimmed?.includes('\0')) {
    throw new Error('path cannot contain null bytes.');
  }

  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function requirePath(value: unknown): string {
  const filePath = requireString(value, 'path');

  if (filePath.includes('\0')) {
    throw new Error('path cannot contain null bytes.');
  }

  return filePath;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }

  return value;
}

function decodeBase64(value: string): Buffer {
  const normalized = value.trim();

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error('contentBase64 must be valid base64.');
  }

  return Buffer.from(normalized, 'base64');
}

function assertMaxBytes(value: Buffer | number, maxBytes: number, label: string): void {
  const length = typeof value === 'number' ? value : value.length;

  if (length > maxBytes) {
    throw new Error(`${label} exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  }
}

function joinRemotePath(directory: string, name: string): string {
  if (directory === '/' || directory.endsWith('/')) {
    return `${directory}${name}`;
  }

  return `${directory}/${name}`;
}

function sortFileItems(a: FileItem, b: FileItem): number {
  if (a.type === 'directory' && b.type !== 'directory') {
    return -1;
  }

  if (a.type !== 'directory' && b.type === 'directory') {
    return 1;
  }

  return a.name.localeCompare(b.name);
}

function modeToPermissions(mode: number): string {
  const type = typeFromMode(mode) === 'directory' ? 'd' : typeFromMode(mode) === 'symlink' ? 'l' : '-';
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const chars = ['r', 'w', 'x'];
  const permissions = bits.map((bit, index) => ((mode & bit) !== 0 ? chars[index % 3] : '-')).join('');

  return `${type}${permissions}`;
}

function typeFromMode(mode: number): FileItem['type'] {
  const fileType = mode & 0o170000;

  if (fileType === 0o040000) {
    return 'directory';
  }

  if (fileType === 0o120000) {
    return 'symlink';
  }

  return 'file';
}

function escapeHeaderFilename(value: string): string {
  return value.replace(/["\\\r\n]/g, '_');
}

function resolveLocalPath(filePath: string | undefined): string {
  const requestedPath = filePath
    ? path.resolve(path.isAbsolute(filePath) ? filePath : path.join(LOCAL_ROOT, filePath))
    : LOCAL_ROOT;

  if (!isPathWithin(LOCAL_ROOT, requestedPath)) {
    throw new Error('Local file path escaped configured file root.');
  }

  return requestedPath;
}

async function resolveExistingLocalPath(filePath: string | undefined): Promise<string> {
  const resolved = resolveLocalPath(filePath);
  return assertLocalRealPathWithinRoot(resolved);
}

async function resolveCheckedLocalPath(filePath: string): Promise<string> {
  const resolved = resolveLocalPath(filePath);
  await assertLocalRealPathWithinRoot(resolved);
  return resolved;
}

async function resolveWritableLocalPath(filePath: string): Promise<string> {
  const resolved = resolveLocalPath(filePath);

  try {
    await fs.lstat(resolved);
    await assertLocalRealPathWithinRoot(resolved);
    return resolved;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  await assertLocalRealPathWithinRoot(path.dirname(resolved));
  return resolved;
}

async function resolveDirectoryCreateLocalPath(filePath: string): Promise<string> {
  const resolved = resolveLocalPath(filePath);

  try {
    await fs.lstat(resolved);
    await assertLocalRealPathWithinRoot(resolved);
    return resolved;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const ancestor = await findExistingAncestor(path.dirname(resolved));
  await assertLocalRealPathWithinRoot(ancestor);
  return resolved;
}

async function assertLocalRealPathWithinRoot(candidate: string): Promise<string> {
  const root = await localRootRealPath();
  const realCandidate = await fs.realpath(candidate);

  if (!isPathWithin(root, realCandidate)) {
    throw new Error('Local file path escaped configured file root.');
  }

  return realCandidate;
}

async function localRootRealPath(): Promise<string> {
  await fs.mkdir(LOCAL_ROOT, { recursive: true, mode: 0o700 });
  return fs.realpath(LOCAL_ROOT);
}

async function findExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;

  while (isPathWithin(LOCAL_ROOT, current)) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }

    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  return LOCAL_ROOT;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function sendFileError(
  logger: { warn(value: unknown, message?: string): void },
  reply: FastifyReply,
  error: unknown,
  logMessage: string,
  context: Record<string, unknown>,
) {
  if (error instanceof ServerNotFoundError) {
    return reply.code(404).send({
      error: 'Not Found',
      message: error.message,
    });
  }

  const normalizedError = error instanceof Error ? new Error(normalizeSshError(error.message)) : error;
  const message = publicFileErrorMessage(normalizedError);
  const statusCode = message === 'SSH Connection Timeout or Refused' || message === 'SSH Authentication Failed' ? 502 : 400;

  logRouteError(logger, logMessage, {
    ...context,
    error: redactedError(error),
    publicMessage: message,
  });

  return reply.code(statusCode).send({
    error: 'File Explorer Error',
    message,
  });
}
