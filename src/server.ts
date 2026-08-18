import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { createSignalingHandler } from './handler.js';
import type { ServerConfig, IssueTokenRequest, SignalingHandler } from './types.js';
import type { WebSocket } from 'ws';

/**
 * Standalone signaling server: the HTTP surface (`/health`, `/public-key`, `POST /token`) plus the
 * `/signal` WebSocket route, on its own Fastify instance. This is what the CLI runs.
 *
 * The connection logic lives in `createSignalingHandler` and is shared verbatim with embedded
 * hosts, so a peer connected here and a peer connected through an embedded handler see identical
 * frames. To mount signaling on an HTTP server you already have, use `createSignalingHandler`
 * directly — see the README "Embedding" section.
 */
export async function createServer(config: ServerConfig) {
  const handler: SignalingHandler = await createSignalingHandler({
    authEnabled: config.authEnabled,
    privateKeyJwk: config.privateKeyJwk,
    publicKeyJwk: config.publicKeyJwk,
    consumerAuth: config.consumerAuth,
    registerTimeoutMs: config.registerTimeoutMs,
    // Fastify routes the request; the handler never sees a raw upgrade here.
    path: null,
  });

  const app = Fastify({ logger: { level: 'info' } });
  await app.register(fastifyWebsocket);

  // ─── Health ────────────────────────────────────────────────────────────────

  app.get('/health', async () => {
    const { auth, peers } = handler.stats();
    return { status: 'ok', auth, peers, ts: new Date().toISOString() };
  });

  // ─── Public key ────────────────────────────────────────────────────────────

  if (config.authEnabled) {
    app.get('/public-key', async () => handler.publicJwk());
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

        const result = await handler.issueToken(req.body);
        return reply.status(201).send(result);
      },
    );
  }

  // ─── WebSocket signaling ───────────────────────────────────────────────────

  app.get('/signal', { websocket: true }, async (socket, req) => {
    await handler.handleConnection(socket as unknown as WebSocket, req.url ?? '');
  });

  app.addHook('onClose', async () => {
    await handler.close();
  });

  return app;
}
