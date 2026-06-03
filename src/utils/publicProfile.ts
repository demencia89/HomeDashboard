import type { PublicServerProfile, ServerProfile } from '../types/server-profile.js';

export function sanitizeServerProfile(profile: ServerProfile): PublicServerProfile {
  return {
    id: profile.id,
    alias: profile.alias,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
    ...(profile.privateKeyName ? { privateKeyName: profile.privateKeyName } : {}),
    ...(profile.serverIcon ? { serverIcon: profile.serverIcon } : {}),
    ...(profile.serverIconColor ? { serverIconColor: profile.serverIconColor } : {}),
    hasPassword: Boolean(profile.encryptedPassword && profile.iv && profile.authTag),
  };
}
