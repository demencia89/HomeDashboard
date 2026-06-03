interface RouteLogger {
  warn(value: unknown, message?: string): void;
}

interface PublicMessageOptions {
  fallback: string;
  allowedMessages?: readonly string[];
  allowedPatterns?: readonly RegExp[];
}

const PUBLIC_SSH_ERRORS = new Set([
  'SSH Connection Timeout or Refused',
  'SSH Authentication Failed',
  'Decryption / Authentication failure',
]);

const PATH_PATTERN = /(?:^|[\s"'=:(])(?:\/(?:[A-Za-z0-9._ -]+\/?)+)/g;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\?)+/g;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export function publicErrorMessage(value: unknown, options: PublicMessageOptions): string {
  const message = errorMessage(value);

  if (!message) {
    return options.fallback;
  }

  if (PUBLIC_SSH_ERRORS.has(message) || options.allowedMessages?.includes(message)) {
    return redactText(message);
  }

  if (options.allowedPatterns?.some((pattern) => pattern.test(message))) {
    return redactText(message);
  }

  if (/^Private key ".+" was not found in the keys directory\.$/.test(message)) {
    return 'Private key was not found in the keys directory.';
  }

  return options.fallback;
}

export function publicFileErrorMessage(value: unknown, fallback = 'File operation failed.'): string {
  const message = errorMessage(value);

  if (!message) {
    return fallback;
  }

  if (PUBLIC_SSH_ERRORS.has(message)) {
    return message;
  }

  if (message === 'Local file path escaped configured file root.') {
    return 'Local file path must stay within the configured file root.';
  }

  if (
    message === 'path cannot contain null bytes.' ||
    message === 'contentBase64 must be valid base64.' ||
    message.endsWith('must be a non-empty string.') ||
    /^(File content|Uploaded file|File|Download) exceeds \d+ MB limit\.$/.test(message)
  ) {
    return message;
  }

  return fallback;
}

export function logRouteError(logger: RouteLogger, message: string, context: Record<string, unknown>): void {
  logger.warn(redactValue(context), message);
}

export function redactedError(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    };
  }

  return redactValue(value);
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return value instanceof Error ? value.message : '';
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]),
    );
  }

  return value;
}

function redactText(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, '[redacted-private-key]')
    .replace(WINDOWS_PATH_PATTERN, '[redacted-path]')
    .replace(PATH_PATTERN, (match) => `${match[0] === '/' ? '' : match[0]}[redacted-path]`);
}
