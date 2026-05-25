import { SignJWT, jwtVerify, type KeyLike } from 'jose';
import type { IssueTokenRequest, IssueTokenResponse } from './types.js';

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
