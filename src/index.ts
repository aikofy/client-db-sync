// Programmatic API — use this when embedding the server in your own app

export { createServer } from './server.js';
export { issueToken, verifyToken, makeConsumerVerifier } from './auth.js';
export type { ConsumerVerifier, TokenPayload } from './auth.js';
export { generateKeyPairJwk, loadKeyPairFromEnv, decodePublicJwk } from './keys.js';
export { SignalingRegistry } from './signaling.js';
export type {
  ServerConfig,
  ConsumerAuthConfig,
  ClientRole,
  IssueTokenRequest,
  IssueTokenResponse,
  SignalingMessage,
  RegisterMessage,
  PeerListMessage,
  ServerListMessage,
  AuthErrMessage,
  HeartbeatMessage,
  OfferMessage,
  AnswerMessage,
  IceCandidateMessage,
} from './types.js';
