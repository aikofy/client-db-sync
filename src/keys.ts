import { importJWK, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { KeyLike } from 'jose';

export interface KeyPair {
  privateKey: KeyLike;
  publicKey: KeyLike;
  privateKeyJwk: string;
  publicKeyJwk: string;
}

/** Load Ed25519 key pair from base64-encoded JWK env vars. */
export async function loadKeyPairFromEnv(
  privateKeyJwkB64: string,
  publicKeyJwkB64: string,
): Promise<KeyPair> {
  const privateJwk = JSON.parse(Buffer.from(privateKeyJwkB64, 'base64').toString('utf8')) as JWK;
  const publicJwk = JSON.parse(Buffer.from(publicKeyJwkB64, 'base64').toString('utf8')) as JWK;

  const privateKey = await importJWK(privateJwk, 'EdDSA') as KeyLike;
  const publicKey = await importJWK(publicJwk, 'EdDSA') as KeyLike;

  return {
    privateKey,
    publicKey,
    privateKeyJwk: privateKeyJwkB64,
    publicKeyJwk: publicKeyJwkB64,
  };
}

/** Generate a fresh Ed25519 key pair and return base64-encoded JWK strings. */
export async function generateKeyPairJwk(): Promise<{ privateKeyJwk: string; publicKeyJwk: string }> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });

  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);

  return {
    privateKeyJwk: Buffer.from(JSON.stringify(privateJwk)).toString('base64'),
    publicKeyJwk: Buffer.from(JSON.stringify(publicJwk)).toString('base64'),
  };
}

/** Decode the public JWK string to a plain object (for the /public-key endpoint). */
export function decodePublicJwk(publicKeyJwkB64: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(publicKeyJwkB64, 'base64').toString('utf8')) as Record<string, unknown>;
}
