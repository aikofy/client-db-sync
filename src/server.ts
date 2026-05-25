import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { verifyToken, issueToken } from './auth.js';
import { loadKeyPairFromEnv, decodePublicJwk } from './keys.js';
import { SignalingRegistry } from './signaling.js';
import type { ServerConfig, IssueTokenRequest } from './types.js';
import type { KeyLike } from 'jose';
import { v4 as uuidv4 } from 'uuid';

export async function createServer(config: ServerConfig) {
  let privateKey: KeyLike | null = null;
  let publicKey: KeyLike | null = null;

  if (config.authEnabled) {
    const keys = await loadKeyPairFromEnv(
      config.privateKeyJwk!,
      config.publicKeyJwk!,
    );
    privateKey = keys.privateKey;
    publicKey = keys.publicKey;
  }

  const registry = new SignalingRegistry();

  const app = Fastify({ logger: { level: 'info' } });
  await app.register(fastifyWebsocket);

  // ─── Health ────────────────────────────────────────────────────────────────

  app.get('/health', async () => ({
    status: 'ok',
    auth: config.authEnabled ? 'enabled' : 'disabled',
    peers: registry.connectedCount,
    ts: new Date().toISOString(),
  }));

  // ─── Public key ────────────────────────────────────────────────────────────

  if (config.authEnabled) {
    app.get('/public-key', async () => ({
      alg: 'EdDSA',
      crv: 'Ed25519',
      ...decodePublicJwk(config.publicKeyJwk!),
    }));
  }

  // ─── Token issuance ────────────────────────────────────────────────────────

  if (config.authEnabled) {
    app.post<{ Body: IssueTokenRequest }>(
      '/token',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ttl'],
            properties: {
              ttl: { type: 'string' },
              subject: { type: 'string' },
            },
          },
        },
      },
      async (req, reply) => {
        const adminHeader =
          (req.headers['x-admin-secret'] as string | undefined) ??
          (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');

        if (!adminHeader || adminHeader !== config.adminSecret) {
          return reply.status(401).send({ error: 'Unauthorized' });
        }

        const result = await issueToken(privateKey as KeyLike, req.body);
        return reply.status(201).send(result);
      },
    );
  }

  // ─── WebSocket signaling ───────────────────────────────────────────────────

  app.get(
    '/signal',
    { websocket: true },
    async (socket, req) => {
      const url = new URL(req.url ?? '', `http://localhost`);
      let nodeId: string;

      let room: string;

      if (config.authEnabled) {
        const token = url.searchParams.get('token');

        if (!token) {
          socket.close(4001, 'Missing token');
          return;
        }

        try {
          const payload = await verifyToken(token, publicKey as KeyLike);
          nodeId = url.searchParams.get('nodeId') ?? payload.sub;
          // Room must match the token subject — prevents a valid token from joining
          // another user's room even if the room name (e.g. userId) is known.
          room = url.searchParams.get('room') ?? payload.sub;
          if (room !== payload.sub) {
            socket.close(4003, 'Room does not match token subject');
            return;
          }
        } catch {
          socket.close(4003, 'Invalid or expired token');
          return;
        }
      } else {
        // Auth disabled — accept any connection; fall back to 'default' room
        nodeId = url.searchParams.get('nodeId') ?? uuidv4();
        room = url.searchParams.get('room') ?? 'default';
      }

      registry.register(nodeId, room, socket);

      socket.on('message', (data: Buffer | string) => {
        registry.route(nodeId, room, data.toString());
      });
    },
  );

  return app;
}
