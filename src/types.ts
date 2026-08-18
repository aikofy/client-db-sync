import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';
import type { SignalingRegistry } from './signaling.js';

// ─── Roles ──────────────────────────────────────────────────────────────────

/** Normal Clients hold a full replica and gossip; Consumer Clients only call RPC handlers. */
export type ClientRole = 'normal' | 'consumer';

// ─── Signaling messages ───────────────────────────────────────────────────────

export interface RegisterMessage {
  type: 'register';
  nodeId: string;
  /** Defaults to 'normal' when absent (backward compatible with 1.x clients). */
  role?: ClientRole;
  /** Normal Clients only — whether this node will serve Consumer RPC calls. Default true. */
  serveConsumers?: boolean;
  /** Normal Clients only — soft max concurrent Consumer sessions. */
  capacity?: number;
  /** Consumer Clients only — the IdP access token, verified server-side (defense in depth). */
  token?: string;
  protocolVersion?: number;
}

export interface PeerListMessage {
  type: 'peer-list';
  peers: string[];
}

/** Sent to a Consumer: the healthy, opted-in Normal Clients it may call (rotated, round-robin). */
export interface ServerListMessage {
  type: 'server-list';
  servers: string[];
}

/** Sent to a Consumer when its register token is rejected, just before the socket closes. */
export interface AuthErrMessage {
  type: 'auth-err';
  status: 'UNAUTHENTICATED';
  message: string;
}

/** Normal Client → server: liveness + load/capacity for the load-balancing director. */
export interface HeartbeatMessage {
  type: 'heartbeat';
  load?: { sessions?: number };
  serveConsumers?: boolean;
  capacity?: number;
}

export interface OfferMessage {
  type: 'offer';
  to: string;
  from: string;
  sdp: unknown;
  /** Stamped by the server with the sender's role so the answerer can branch early. */
  fromRole?: ClientRole;
}

export interface AnswerMessage {
  type: 'answer';
  to: string;
  from: string;
  sdp: unknown;
  fromRole?: ClientRole;
}

export interface IceCandidateMessage {
  type: 'ice-candidate';
  to: string;
  from: string;
  candidate: unknown;
  fromRole?: ClientRole;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type SignalingMessage =
  | RegisterMessage
  | PeerListMessage
  | ServerListMessage
  | AuthErrMessage
  | HeartbeatMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | ErrorMessage;

// ─── Token API ────────────────────────────────────────────────────────────────

export interface IssueTokenRequest {
  ttl: string;       // e.g. '1h', '7d', '30m'
  subject?: string;  // optional label for auditing (e.g. app name)
}

export interface IssueTokenResponse {
  token: string;
  expiresAt: string; // ISO 8601
  subject: string;
}

// ─── Server config ────────────────────────────────────────────────────────────

/**
 * Verification of Consumer Client tokens (issued by your IdP, NOT by this server). When auth is
 * enabled and this is configured, Consumers must present a valid token in their `register` message
 * (defense in depth — the Normal Client re-verifies authoritatively on the RPC channel). When auth
 * is enabled and this is absent, Consumer registrations are refused.
 */
export interface ConsumerAuthConfig {
  /** base64-encoded JSON: a single JWK, an array of JWKs, or a `{ keys: [...] }` JWKS. */
  jwks: string;
  /** Expected token `iss`, if set. */
  issuer?: string;
  /** Expected token `aud`, if set. */
  audience?: string;
  /** Allowed signature algorithms. Default `['ES256', 'RS256']`. `none` is never allowed. */
  algorithms?: string[];
}

/**
 * Config for the framework-agnostic signaling core (`createSignalingHandler`). This is
 * `ServerConfig` minus the things only a standalone HTTP server needs: no `port` (you already
 * have a server) and no `adminSecret` (embedders mint via `handler.issueToken`, not `POST /token`).
 */
export interface SignalingHandlerConfig {
  /** When false, WebSocket connections are accepted without a token. */
  authEnabled: boolean;
  privateKeyJwk?: string;  // base64-encoded JWK JSON; required when authEnabled
  publicKeyJwk?: string;   // base64-encoded JWK JSON; required when authEnabled
  /** Optional Consumer-token verification (see ConsumerAuthConfig). */
  consumerAuth?: ConsumerAuthConfig;
  /** Ms a connection may stay unregistered before being closed. 0 disables. Default 10000. */
  registerTimeoutMs?: number;
  /**
   * Pathname `handleUpgrade` claims. Default `/signal`. Pass `null` to claim every upgrade it is
   * handed, when the host has already routed by path.
   */
  path?: string | null;
}

export interface SignalingHandlerStats {
  auth: 'enabled' | 'disabled';
  peers: number;
  rooms: number;
}

export interface SignalingHandler {
  /** The pathname this handler claims in `handleUpgrade`, or null when it claims all. */
  path: string | null;
  /**
   * Take over a raw HTTP upgrade; returns false (socket untouched) when the path does not match,
   * so the host can fall through. Safe to call synchronously from an `upgrade` listener — and it
   * must be called synchronously, or the client's handshake bytes are lost.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Drive an already-upgraded socket (for hosts that perform the handshake themselves). */
  handleConnection(socket: WebSocket, requestUrl: string): Promise<void>;
  /** Mint a room token locally — no HTTP hop, no admin secret. Throws when auth is disabled. */
  issueToken(req: IssueTokenRequest): Promise<IssueTokenResponse>;
  /** The public JWK for token verification, or null when auth is disabled. */
  publicJwk(): Record<string, unknown> | null;
  /** Live counts for your own health endpoint. */
  stats(): SignalingHandlerStats;
  /** The underlying registry, for advanced hosts. */
  registry: SignalingRegistry;
  /** Close all sockets and the WebSocket server. */
  close(): Promise<void>;
}

export interface ServerConfig {
  port: number;
  /** When false, WebSocket connections are accepted without a token and POST /token is disabled. */
  authEnabled: boolean;
  adminSecret?: string;
  privateKeyJwk?: string;  // base64-encoded JWK JSON
  publicKeyJwk?: string;   // base64-encoded JWK JSON
  /** Optional Consumer-token verification (see ConsumerAuthConfig). */
  consumerAuth?: ConsumerAuthConfig;
  /** Ms a connection may stay unregistered before being closed. 0 disables. Default 10000. */
  registerTimeoutMs?: number;
}
