/**
 * Fastify-free entrypoint: `@aikofy/client-db-sync/embed`.
 *
 * Import from here when you are mounting signaling on an HTTP server you already own. It pulls in
 * `ws`, `jose` and `uuid` only — none of the standalone server's HTTP stack — so embedding does
 * not drag Fastify into your process.
 */

export { createSignalingHandler } from './handler.js';
export { issueToken, verifyToken, makeConsumerVerifier } from './auth.js';
export type { ConsumerVerifier, TokenPayload } from './auth.js';
export { generateKeyPairJwk, loadKeyPairFromEnv, decodePublicJwk } from './keys.js';
export { SignalingRegistry } from './signaling.js';
export type { SignalingRegistryOptions } from './signaling.js';
export type {
  SignalingHandler,
  SignalingHandlerConfig,
  SignalingHandlerStats,
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
