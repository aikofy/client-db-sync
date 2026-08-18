import { createServer } from './server.js';
import { generateKeyPairJwk } from './keys.js';
import type { ServerConfig } from './types.js';

async function runKeygen(): Promise<void> {
  const { privateKeyJwk, publicKeyJwk } = await generateKeyPairJwk();

  console.log('\n✓ Ed25519 key pair generated.\n');
  console.log('Add these to your .env file:\n');
  console.log(`PRIVATE_KEY_JWK=${privateKeyJwk}`);
  console.log(`PUBLIC_KEY_JWK=${publicKeyJwk}`);
  console.log('\nKeep PRIVATE_KEY_JWK secret. PUBLIC_KEY_JWK can be shared with clients.\n');
}

function printUsage(): void {
  console.log(`Usage:
  npx @aikofy/client-db-sync              Start the signaling server
  npx @aikofy/client-db-sync keygen       Generate PRIVATE_KEY_JWK and PUBLIC_KEY_JWK

After a local install of this package:
  npx client-db-sync-keygen

Required env when starting the server (unless AUTH_DISABLED=true):
  ADMIN_SECRET, PRIVATE_KEY_JWK, PUBLIC_KEY_JWK
`);
}

const command = process.argv[2];

if (command === 'keygen' || command === '--keygen') {
  await runKeygen();
  process.exit(0);
}

if (command === 'help' || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

function loadConfig(): ServerConfig {
  const authEnabled = process.env['AUTH_DISABLED'] !== 'true';

  if (!authEnabled) {
    console.warn('[client-db-sync] WARNING: Auth is disabled (AUTH_DISABLED=true). Do not use in production.');
    return {
      port: parseInt(process.env['PORT'] ?? '8080', 10),
      authEnabled: false,
    };
  }

  const missing: string[] = [];
  const require = (key: string): string => {
    const val = process.env[key];
    if (!val) missing.push(key);
    return val ?? '';
  };

  const config: ServerConfig = {
    port: parseInt(process.env['PORT'] ?? '8080', 10),
    authEnabled: true,
    adminSecret: require('ADMIN_SECRET'),
    privateKeyJwk: require('PRIVATE_KEY_JWK'),
    publicKeyJwk: require('PUBLIC_KEY_JWK'),
  };

  // Optional: verify Consumer Client tokens against your IdP's public key(s). Without this,
  // Consumer registrations are refused when auth is enabled (Normal-Client sync is unaffected).
  const consumerJwks = process.env['CONSUMER_PUBLIC_KEY_JWK'];
  if (consumerJwks) {
    config.consumerAuth = {
      jwks: consumerJwks,
      issuer: process.env['CONSUMER_ISSUER'],
      audience: process.env['CONSUMER_AUDIENCE'],
    };
    if (!process.env['CONSUMER_ISSUER'] || !process.env['CONSUMER_AUDIENCE']) {
      console.warn(
        '[client-db-sync] WARNING: CONSUMER_ISSUER and/or CONSUMER_AUDIENCE are not set. ' +
          'Consumer tokens will be accepted on signature + expiry alone (no issuer/audience check). ' +
          'Set both to bind tokens to your IdP and this service.',
      );
    }
  } else {
    console.warn(
      '[client-db-sync] CONSUMER_PUBLIC_KEY_JWK not set — Consumer Clients will be refused while ' +
        'auth is enabled. Set it (base64 JWK/JWKS of your IdP public key) to enable Consumer support.',
    );
  }

  if (missing.length > 0) {
    console.error(`[client-db-sync] Missing required env vars: ${missing.join(', ')}`);
    console.error('Run `npx @aikofy/client-db-sync keygen` to generate PRIVATE_KEY_JWK and PUBLIC_KEY_JWK.');
    console.error('Or set AUTH_DISABLED=true for local development.');
    process.exit(1);
  }

  return config;
}

const config = loadConfig();
const app = await createServer(config);

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[client-db-sync] Signaling server running on port ${config.port} (auth: ${config.authEnabled ? 'enabled' : 'DISABLED'})`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
