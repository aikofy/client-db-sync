// ─── Signaling messages ───────────────────────────────────────────────────────

export interface RegisterMessage {
  type: 'register';
  nodeId: string;
}

export interface PeerListMessage {
  type: 'peer-list';
  peers: string[];
}

export interface OfferMessage {
  type: 'offer';
  to: string;
  from: string;
  sdp: unknown;
}

export interface AnswerMessage {
  type: 'answer';
  to: string;
  from: string;
  sdp: unknown;
}

export interface IceCandidateMessage {
  type: 'ice-candidate';
  to: string;
  from: string;
  candidate: unknown;
}

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

export type SignalingMessage =
  | RegisterMessage
  | PeerListMessage
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

export interface ServerConfig {
  port: number;
  /** When false, WebSocket connections are accepted without a token and POST /token is disabled. */
  authEnabled: boolean;
  adminSecret?: string;
  privateKeyJwk?: string;  // base64-encoded JWK JSON
  publicKeyJwk?: string;   // base64-encoded JWK JSON
}
