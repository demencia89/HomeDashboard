export interface StrictIntegerOptions {
  min: number;
  max: number;
  defaultValue?: number;
}

export function parseStrictInteger(value: unknown, field: string, options: StrictIntegerOptions): number {
  if (value === undefined || value === null) {
    if (options.defaultValue !== undefined) {
      return options.defaultValue;
    }

    throw new Error(`${field} must be an integer between ${options.min} and ${options.max}.`);
  }

  const parsed = typeof value === 'number' ? value : parseIntegerString(value);

  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < options.min || parsed > options.max) {
    throw new Error(`${field} must be an integer between ${options.min} and ${options.max}.`);
  }

  return parsed;
}

function parseIntegerString(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();

  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
