export type AuthMethod = 'password' | 'privateKey';

export interface ServerProfile {
  id: string;
  alias: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyName?: string;
  serverIcon?: string;
  serverIconColor?: string;
  encryptedPassword?: string;
  iv?: string;
  authTag?: string;
}

export interface CreateServerProfileBody {
  alias?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  authMethod?: unknown;
  privateKeyName?: unknown;
  serverIcon?: unknown;
  serverIconColor?: unknown;
  privateKey?: unknown;
  password?: unknown;
}

export interface UpdateServerProfileBody extends CreateServerProfileBody {}

export interface PublicServerProfile {
  id: string;
  alias: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyName?: string;
  serverIcon?: string;
  serverIconColor?: string;
  hasPassword: boolean;
}
