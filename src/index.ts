// Programmatic API — use this when embedding the server in your own app

export { createServer } from './server.js';
export { issueToken, verifyToken } from './auth.js';
export { generateKeyPairJwk, loadKeyPairFromEnv, decodePublicJwk } from './keys.js';
export { SignalingRegistry } from './signaling.js';
export type {
  ServerConfig,
  IssueTokenRequest,
  IssueTokenResponse,
  SignalingMessage,
} from './types.js';
