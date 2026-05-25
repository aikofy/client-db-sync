import { generateKeyPairJwk } from '../src/keys.js';

const { privateKeyJwk, publicKeyJwk } = await generateKeyPairJwk();

console.log('\n✓ Ed25519 key pair generated.\n');
console.log('Add these to your .env file:\n');
console.log(`PRIVATE_KEY_JWK=${privateKeyJwk}`);
console.log(`PUBLIC_KEY_JWK=${publicKeyJwk}`);
console.log('\nKeep PRIVATE_KEY_JWK secret. PUBLIC_KEY_JWK can be shared with clients.\n');
