import fs from 'node:fs';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { CONFIG_DIR } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const FALLBACK_SECRET_FILE = path.join(CONFIG_DIR, '.secret_key');
const KDF_SALT = 'HomeDashboard:server-passwords:v1';

export interface EncryptedPasswordPayload {
  encryptedData: string;
  iv: string;
  authTag: string;
}

export class DecryptionError extends Error {
  constructor() {
    super('Decryption / Authentication failure');
    this.name = 'DecryptionError';
  }
}

export function encryptPassword(password: string): EncryptedPasswordPayload {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password must be a non-empty string.');
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedData: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

export function decryptPassword(encryptedData: string, iv: string, authTag: string): string {
  try {
    const encrypted = Buffer.from(encryptedData, 'base64');
    const ivBuffer = Buffer.from(iv, 'base64');
    const authTagBuffer = Buffer.from(authTag, 'base64');

    if (ivBuffer.length !== IV_BYTES || authTagBuffer.length !== 16 || encrypted.length === 0) {
      throw new DecryptionError();
    }

    const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), ivBuffer);
    decipher.setAuthTag(authTagBuffer);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptionError();
  }
}

function getEncryptionKey(): Buffer {
  return scryptSync(getMasterSecret(), KDF_SALT, KEY_BYTES);
}

function getMasterSecret(): string {
  const envSecret = process.env.ENCRYPTION_KEY?.trim();

  if (envSecret) {
    return envSecret;
  }

  ensureFallbackSecretFile();
  const secret = fs.readFileSync(FALLBACK_SECRET_FILE, 'utf8').trim();

  if (!secret) {
    throw new Error('Fallback encryption secret is empty.');
  }

  return secret;
}

function ensureFallbackSecretFile(): void {
  fs.mkdirSync(path.dirname(FALLBACK_SECRET_FILE), { recursive: true, mode: 0o700 });

  try {
    const existing = fs.readFileSync(FALLBACK_SECRET_FILE, 'utf8').trim();

    if (isValidStoredSecret(existing)) {
      fs.chmodSync(FALLBACK_SECRET_FILE, 0o600);
      return;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const secret = randomBytes(KEY_BYTES).toString('base64');
  const tempFile = `${FALLBACK_SECRET_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${secret}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, FALLBACK_SECRET_FILE);
  fs.chmodSync(FALLBACK_SECRET_FILE, 0o600);
}

function isValidStoredSecret(value: string): boolean {
  if (!value) {
    return false;
  }

  const decoded = Buffer.from(value, 'base64');
  const reencoded = decoded.toString('base64');
  return decoded.length >= KEY_BYTES && reencoded === value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
