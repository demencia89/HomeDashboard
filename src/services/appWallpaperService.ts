import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from '../config.js';

const WALLPAPER_FILE = path.join(CONFIG_DIR, 'wallpaper.json');
const MAX_WALLPAPER_BYTES = 5 * 1024 * 1024;
const SUPPORTED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

type SupportedWallpaperMimeType = typeof SUPPORTED_MIME_TYPES[number];

interface StoredWallpaper {
  mimeType: SupportedWallpaperMimeType;
  data: string;
  updatedAt: string;
}

export interface WallpaperInfo {
  exists: boolean;
  url?: string;
  updatedAt?: string;
}

export interface WallpaperImage {
  mimeType: SupportedWallpaperMimeType;
  buffer: Buffer;
  updatedAt: string;
}

export async function getWallpaperInfo(): Promise<WallpaperInfo> {
  const wallpaper = await readWallpaper();

  if (!wallpaper) {
    return { exists: false };
  }

  return wallpaperInfo(wallpaper);
}

export async function getWallpaperImage(): Promise<WallpaperImage | undefined> {
  const wallpaper = await readWallpaper();

  if (!wallpaper) {
    return undefined;
  }

  return {
    mimeType: wallpaper.mimeType,
    buffer: Buffer.from(wallpaper.data, 'base64'),
    updatedAt: wallpaper.updatedAt,
  };
}

export async function saveWallpaper(body: unknown): Promise<WallpaperInfo> {
  const parsed = parseWallpaperUpload(body);
  const updatedAt = new Date().toISOString();
  const wallpaper: StoredWallpaper = {
    mimeType: parsed.mimeType,
    data: parsed.buffer.toString('base64'),
    updatedAt,
  };

  await fs.mkdir(path.dirname(WALLPAPER_FILE), { recursive: true });
  const tempFile = `${WALLPAPER_FILE}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fs.writeFile(tempFile, JSON.stringify(wallpaper), { mode: 0o600 });
    await fs.rename(tempFile, WALLPAPER_FILE);
    await fs.chmod(WALLPAPER_FILE, 0o600);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }

  return wallpaperInfo(wallpaper);
}

export async function deleteWallpaper(): Promise<WallpaperInfo> {
  await fs.rm(WALLPAPER_FILE, { force: true });
  return { exists: false };
}

async function readWallpaper(): Promise<StoredWallpaper | undefined> {
  try {
    const raw = await fs.readFile(WALLPAPER_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredWallpaper>;

    if (!isSupportedMimeType(parsed.mimeType) || typeof parsed.data !== 'string' || typeof parsed.updatedAt !== 'string') {
      return undefined;
    }

    return {
      mimeType: parsed.mimeType,
      data: parsed.data,
      updatedAt: parsed.updatedAt,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

function parseWallpaperUpload(body: unknown): { mimeType: SupportedWallpaperMimeType; buffer: Buffer } {
  if (!body || typeof body !== 'object' || typeof (body as { dataUrl?: unknown }).dataUrl !== 'string') {
    throw new Error('Upload an image file.');
  }

  const dataUrl = (body as { dataUrl: string }).dataUrl.trim();
  const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=\s]+)$/.exec(dataUrl);

  if (!match || !isSupportedMimeType(match[1])) {
    throw new Error('Wallpaper must be a PNG, JPEG, WebP, or GIF image.');
  }

  const mimeType = match[1];
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');

  if (!buffer.length || buffer.length > MAX_WALLPAPER_BYTES) {
    throw new Error('Wallpaper image must be 5 MB or smaller.');
  }

  if (!matchesImageSignature(mimeType, buffer)) {
    throw new Error('Wallpaper image data does not match its file type.');
  }

  return { mimeType, buffer };
}

function wallpaperInfo(wallpaper: StoredWallpaper): WallpaperInfo {
  return {
    exists: true,
    url: `/api/app/wallpaper/image?v=${encodeURIComponent(wallpaper.updatedAt)}`,
    updatedAt: wallpaper.updatedAt,
  };
}

function isSupportedMimeType(value: unknown): value is SupportedWallpaperMimeType {
  return typeof value === 'string' && (SUPPORTED_MIME_TYPES as readonly string[]).includes(value);
}

function matchesImageSignature(mimeType: SupportedWallpaperMimeType, buffer: Buffer): boolean {
  if (mimeType === 'image/png') {
    return buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }

  if (mimeType === 'image/jpeg') {
    return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }

  if (mimeType === 'image/webp') {
    return buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }

  return buffer.length > 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
