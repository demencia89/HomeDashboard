export async function buildWebSocketUrl(path: string, params?: Record<string, string | number | undefined>): Promise<string> {
  const token = await getWebSocketToken();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(path, `${protocol}//${window.location.host}`);

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  url.searchParams.set('token', token);
  return url.toString();
}

async function getWebSocketToken(): Promise<string> {
  const response = await fetch('/api/ws-token', { cache: 'no-store' });
  const body = (await response.json().catch(() => undefined)) as { token?: unknown; message?: string } | undefined;

  if (!response.ok || typeof body?.token !== 'string' || !body.token) {
    throw new Error(body?.message ?? 'Unable to open WebSocket session.');
  }

  return body.token;
}
