import { SignJWT, jwtVerify, createLocalJWKSet, type JWK, type KeyLike } from 'jose';
import type { ConsumerAuthConfig, IssueTokenRequest, IssueTokenResponse } from './types.js';

const ISSUER = 'aikofy:client-db-sync';
const AUDIENCE = 'aikofy:client-db';

export interface TokenPayload {
  sub: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
}

/** Issue a signed JWT with the given TTL. */
export async function issueToken(
  privateKey: KeyLike,
  req: IssueTokenRequest,
): Promise<IssueTokenResponse> {
  const subject = req.subject ?? 'default';

  const jwt = await new SignJWT({ sub: subject })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(req.ttl)
    .sign(privateKey);

  // Decode the expiry without full verification just to return it
  const parts = jwt.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { exp: number };
  const expiresAt = new Date(payload.exp * 1000).toISOString();

  return { token: jwt, expiresAt, subject };
}

/** Verify a JWT from a WebSocket connection request. Throws on failure. */
export async function verifyToken(
  token: string,
  publicKey: KeyLike,
): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return payload as unknown as TokenPayload;
}

/** A function that verifies a Consumer's IdP token, resolving its claims or throwing. */
export type ConsumerVerifier = (token: string) => Promise<Record<string, unknown>>;

/**
 * Build a verifier for Consumer Client tokens from the configured IdP public key(s). This server
 * only VERIFIES these tokens (they are minted by your IdP). `none` is never allowed and the
 * algorithm whitelist defaults to ES256/RS256 — matching `@aikofy/client-db`'s `createTokenVerifier`.
 */
export function makeConsumerVerifier(cfg: ConsumerAuthConfig): ConsumerVerifier {
  const decoded = JSON.parse(Buffer.from(cfg.jwks, 'base64').toString('utf8')) as
    | JWK
    | JWK[]
    | { keys: JWK[] };
  const keys: JWK[] = Array.isArray(decoded)
    ? decoded
    : 'keys' in decoded && Array.isArray(decoded.keys)
      ? decoded.keys
      : [decoded as JWK];

  const jwkSet = createLocalJWKSet({ keys });
  const algorithms = cfg.algorithms ?? ['ES256', 'RS256'];

  return async (token: string): Promise<Record<string, unknown>> => {
    const { payload } = await jwtVerify(token, jwkSet, {
      algorithms,
      issuer: cfg.issuer,
      audience: cfg.audience,
    });
    return payload as Record<string, unknown>;
  };
}
