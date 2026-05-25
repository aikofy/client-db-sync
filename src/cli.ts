import { createServer } from './server.js';
import type { ServerConfig } from './types.js';

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

  if (missing.length > 0) {
    console.error(`[client-db-sync] Missing required env vars: ${missing.join(', ')}`);
    console.error('Run `client-db-sync-keygen` to generate PRIVATE_KEY_JWK and PUBLIC_KEY_JWK.');
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
