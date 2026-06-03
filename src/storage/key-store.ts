import fs from 'node:fs/promises';
import path from 'node:path';

const KEY_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MAX_KEY_BYTES = 1024 * 1024;

export interface UploadedKey {
  name: string;
  path: string;
}

export class KeyStore {
  constructor(private readonly keysDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.keysDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.keysDir, 0o700);
  }

  async list(): Promise<string[]> {
    await this.init();
    const entries = await fs.readdir(this.keysDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  async exists(name: string): Promise<boolean> {
    const filePath = this.resolveKeyPath(name);

    try {
      const stat = await fs.stat(filePath);
      return stat.isFile();
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return false;
      }

      throw error;
    }
  }

  async save(name: string, privateKey: string): Promise<UploadedKey> {
    const filePath = this.resolveKeyPath(name);
    const keyBytes = Buffer.byteLength(privateKey, 'utf8');

    if (keyBytes === 0 || keyBytes > MAX_KEY_BYTES) {
      throw new Error(`Private key must be between 1 byte and ${MAX_KEY_BYTES} bytes.`);
    }

    await this.init();
    await fs.writeFile(filePath, normalizePrivateKey(privateKey), { mode: 0o600 });
    await fs.chmod(filePath, 0o600);

    return { name, path: filePath };
  }

  resolveKeyPath(name: string): string {
    if (!KEY_NAME_PATTERN.test(name)) {
      throw new Error('Key name may only contain letters, numbers, dots, underscores, and dashes.');
    }

    const filePath = path.join(this.keysDir, name);
    const normalizedDir = path.resolve(this.keysDir);
    const normalizedFile = path.resolve(filePath);

    if (!normalizedFile.startsWith(`${normalizedDir}${path.sep}`)) {
      throw new Error('Invalid key path.');
    }

    return normalizedFile;
  }
}

function normalizePrivateKey(privateKey: string): string {
  return privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
