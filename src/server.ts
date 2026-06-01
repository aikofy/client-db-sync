import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { verifyToken, issueToken, makeConsumerVerifier, type ConsumerVerifier } from './auth.js';
import { loadKeyPairFromEnv, decodePublicJwk } from './keys.js';
import { SignalingRegistry } from './signaling.js';
import type { ServerConfig, IssueTokenRequest, SignalingMessage } from './types.js';
import type { WebSocket } from '@fastify/websocket';
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

  // Optional Consumer-token verifier (IdP keys). Only relevant when auth is enabled.
  const consumerVerifier: ConsumerVerifier | null = config.consumerAuth
    ? makeConsumerVerifier(config.consumerAuth)
    : null;

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
      // Whether the URL carried a valid room-access token. Normal Clients MUST be url-authed
      // (when auth is enabled); Consumers connect token-less and authenticate via `register`.
      let urlAuthed = false;

      if (config.authEnabled) {
        const token = url.searchParams.get('token');

        if (token) {
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
            urlAuthed = true;
          } catch {
            socket.close(4003, 'Invalid or expired token');
            return;
          }
        } else {
          // No URL token → a Consumer is expected (it authenticates in its `register` message).
          // A room is still required so we know which Normal Clients it may be directed to.
          room = url.searchParams.get('room') ?? '';
          nodeId = url.searchParams.get('nodeId') ?? uuidv4();
          if (!room) {
            socket.close(4001, 'Missing room');
            return;
          }
        }
      } else {
        // Auth disabled — accept any connection; fall back to 'default' room.
        nodeId = url.searchParams.get('nodeId') ?? uuidv4();
        room = url.searchParams.get('room') ?? 'default';
      }

      // An authorized connection (Normal with a valid room token, or dev mode) may take over an
      // existing nodeId; a token-less consumer-path connection may not displace a finalized member.
      registry.addPending(nodeId, room, socket, !config.authEnabled || urlAuthed);

      socket.on('message', (data: Buffer | string) => {
        void handleMessage(nodeId, room, urlAuthed, socket, data.toString());
      });
    },
  );

  /** Dispatch a client message: `register` finalizes the role; heartbeat updates load; the rest
   *  (offer/answer/ice-candidate) is relayed by the registry. */
  async function handleMessage(
    nodeId: string,
    room: string,
    urlAuthed: boolean,
    socket: WebSocket,
    raw: string,
  ): Promise<void> {
    let msg: SignalingMessage;
    try {
      msg = JSON.parse(raw) as SignalingMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'register': {
        const role = msg.role ?? 'normal';
        if (role === 'consumer') {
          if (config.authEnabled) {
            if (!consumerVerifier) {
              sendAuthErr(socket, 'consumer authentication is not configured on this server');
              socket.close(4003, 'consumer auth not configured');
              return;
            }
            if (!msg.token) {
              sendAuthErr(socket, 'missing consumer token');
              socket.close(4003, 'missing consumer token');
              return;
            }
            try {
              await consumerVerifier(msg.token);
            } catch {
              sendAuthErr(socket, 'invalid or expired consumer token');
              socket.close(4003, 'invalid consumer token');
              return;
            }
          }
          registry.finalizeConsumer(nodeId, room);
        } else {
          // Normal Clients require a verified room token (when auth is enabled).
          if (config.authEnabled && !urlAuthed) {
            socket.close(4001, 'Normal Client requires a room token');
            return;
          }
          registry.finalizeNormal(nodeId, room, {
            serveConsumers: msg.serveConsumers,
            capacity: msg.capacity,
          });
        }
        break;
      }
      case 'heartbeat':
        registry.handleHeartbeat(nodeId, room, msg);
        break;
      default:
        registry.route(nodeId, room, msg);
        break;
    }
  }

  function sendAuthErr(socket: WebSocket, message: string): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'auth-err', status: 'UNAUTHENTICATED', message }));
    }
  }

  return app;
}
