export function formatBytes(value: number): string {
  if (value < 1024) {
    return String(value) + ' B';
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return size.toFixed(size >= 10 ? 0 : 1) + ' ' + units[index];
}

export function formatProcessMemory(memoryMiB: number): string {
  return formatBytes(Math.max(0, memoryMiB) * 1024 * 1024);
}

export function formatFilesystemSize(value: string): string {
  const mebibytes = parseFilesystemSizeToMebibytes(value);

  if (mebibytes === undefined) {
    return value;
  }

  if (mebibytes < 1024) {
    return `${formatSizeNumber(mebibytes)} MB`;
  }

  return `${formatSizeNumber(mebibytes / 1024)} GB`;
}

export function formatTime(epochSeconds: number): string {
  if (!epochSeconds) {
    return '-';
  }

  return new Date(epochSeconds * 1000).toLocaleString();
}

function parseFilesystemSizeToMebibytes(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([KMGTPE]?)$/i);

  if (!match) {
    return undefined;
  }

  const amount = Number(match[1]);

  if (!Number.isFinite(amount)) {
    return undefined;
  }

  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    '': 1 / 1024,
    K: 1 / 1024,
    M: 1,
    G: 1024,
    T: 1024 * 1024,
    P: 1024 * 1024 * 1024,
    E: 1024 * 1024 * 1024 * 1024,
  };

  return amount * multipliers[unit];
}

function formatSizeNumber(value: number): string {
  if (value >= 100) {
    return value.toFixed(0);
  }

  if (value >= 10) {
    return value.toFixed(1).replace(/\.0$/, '');
  }

  return value.toFixed(2).replace(/\.?0+$/, '');
}
