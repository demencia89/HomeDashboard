import type { RawData, WebSocket } from 'ws';

export interface WritableSocketStream {
  write(data: string | Buffer): unknown;
}

export function sendSocketJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === 1) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      socket.close(1011, 'WebSocket send failed.');
    }
  }
}

export function sendSocketData(socket: WebSocket, data: Buffer): void {
  if (socket.readyState !== 1) {
    return;
  }

  try {
    socket.send(data);
  } catch {
    socket.close(1011, 'WebSocket send failed.');
  }
}

export function rawDataLength(data: RawData): number {
  if (typeof data === 'string') {
    return Buffer.byteLength(data);
  }

  if (Buffer.isBuffer(data)) {
    return data.length;
  }

  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.length, 0);
  }

  return data.byteLength;
}

export function rawDataToString(data: RawData): string | undefined {
  if (typeof data === 'string') {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }

  return Buffer.from(data).toString('utf8');
}

export function writeRawData(stream: WritableSocketStream, data: RawData): void {
  if (typeof data === 'string') {
    stream.write(data);
  } else if (Buffer.isBuffer(data)) {
    stream.write(data);
  } else if (Array.isArray(data)) {
    stream.write(Buffer.concat(data));
  } else {
    stream.write(Buffer.from(data));
  }
}
