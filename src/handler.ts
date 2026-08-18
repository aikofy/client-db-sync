import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { verifyToken, issueToken, makeConsumerVerifier, type ConsumerVerifier } from './auth.js';
import { loadKeyPairFromEnv, decodePublicJwk } from './keys.js';
import { SignalingRegistry } from './signaling.js';
import type {
  SignalingHandler,
  SignalingHandlerConfig,
  IssueTokenRequest,
  IssueTokenResponse,
  SignalingMessage,
} from './types.js';
import type { KeyLike } from 'jose';
import { v4 as uuidv4 } from 'uuid';

/**
 * Framework-agnostic signaling core. Owns the registry, the room-token keys and the WebSocket
 * upgrade, with no HTTP server of its own — mount it on any `http.Server` you already have
 * (alongside socket.io, Express, Hono, …) via `handleUpgrade`.
 *
 * `createServer` is a thin Fastify wrapper over this; both share one implementation of the
 * connection logic, so an embedded peer and a standalone one behave identically.
 */
export async function createSignalingHandler(
  config: SignalingHandlerConfig,
): Promise<SignalingHandler> {
  let privateKey: KeyLike | null = null;
  let publicKey: KeyLike | null = null;

  if (config.authEnabled) {
    if (!config.privateKeyJwk || !config.publicKeyJwk) {
      throw new Error(
        'createSignalingHandler: privateKeyJwk and publicKeyJwk are required when authEnabled is true. ' +
          'Run `npx @aikofy/client-db-sync keygen` to generate them, or set authEnabled: false for local development.',
      );
    }
    const keys = await loadKeyPairFromEnv(config.privateKeyJwk, config.publicKeyJwk);
    privateKey = keys.privateKey;
    publicKey = keys.publicKey;
  }

  const consumerVerifier: ConsumerVerifier | null = config.consumerAuth
    ? makeConsumerVerifier(config.consumerAuth)
    : null;

  const registry = new SignalingRegistry(
    config.registerTimeoutMs === undefined ? {} : { registerTimeoutMs: config.registerTimeoutMs },
  );
  const wss = new WebSocketServer({ noServer: true });
  const path = config.path ?? '/signal';

  // ─── Upgrade ───────────────────────────────────────────────────────────────

  /**
   * Take over a raw HTTP upgrade. MUST be safe to call synchronously from an `upgrade` listener,
   * and it is: `wss.handleUpgrade` consumes the socket and `head` immediately, so no client bytes
   * are lost. All async work (token verification) happens after the handshake, matching the
   * standalone server, where the socket is also upgraded before the token is checked.
   *
   * Returns `false` without touching the socket when the request is not for this handler's path,
   * so the host can fall through to its own routing.
   */
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const reqUrl = req.url ?? '/';
    if (path !== null && new URL(reqUrl, 'http://localhost').pathname !== path) {
      return false;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      void handleConnection(ws, reqUrl);
    });
    return true;
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  /**
   * Drive an already-upgraded socket. Exposed for hosts whose WebSocket layer performs the
   * handshake itself (`@fastify/websocket`, and therefore `createServer`).
   */
  async function handleConnection(socket: WebSocket, requestUrl: string): Promise<void> {
    const url = new URL(requestUrl ?? '', 'http://localhost');

    // Messages can arrive before the async token check below resolves — a client that sends
    // `register` in its `onopen` handler will beat us. Buffer from the first tick and replay,
    // rather than silently dropping the registration.
    const pending: string[] = [];
    let ready = false;
    socket.on('message', (data: Buffer | string) => {
      const raw = data.toString();
      if (ready) return;
      pending.push(raw);
    });

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

    const dispatch = (raw: string) => void handleMessage(nodeId, room, urlAuthed, socket, raw);
    ready = true;
    socket.on('message', (data: Buffer | string) => dispatch(data.toString()));
    for (const raw of pending) dispatch(raw);
  }

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

  // ─── Public surface ────────────────────────────────────────────────────────

  return {
    path,
    handleUpgrade,
    handleConnection,
    registry,

    /**
     * Mint a room token locally. This is the same operation `POST /token` performs, without the
     * HTTP hop or the admin secret — when you embed, the process already holds the signing key,
     * so an internal caller can mint directly.
     */
    async issueToken(req: IssueTokenRequest): Promise<IssueTokenResponse> {
      if (!config.authEnabled || !privateKey) {
        throw new Error('issueToken: auth is disabled on this handler, so there is no signing key.');
      }
      return issueToken(privateKey, req);
    },

    publicJwk(): Record<string, unknown> | null {
      if (!config.authEnabled || !config.publicKeyJwk) return null;
      return { alg: 'EdDSA', crv: 'Ed25519', ...decodePublicJwk(config.publicKeyJwk) };
    },

    stats() {
      return {
        auth: config.authEnabled ? ('enabled' as const) : ('disabled' as const),
        peers: registry.connectedCount,
        rooms: registry.roomCount,
      };
    },

    async close(): Promise<void> {
      // Terminate rather than close+wait: a client that never ACKs the close
      // frame would otherwise leave wss.close()'s callback unfired and hang
      // the host's shutdown (seen under bun:test's 5 s hook timeout).
      for (const client of [...wss.clients]) {
        try {
          client.terminate();
        } catch {
          /* already gone */
        }
      }
      await new Promise<void>((resolve) => {
        // bun's `ws` close callback is not always invoked after terminate();
        // a bounded wait keeps an embedding host's SIGTERM from stalling.
        const timer = setTimeout(resolve, 250);
        wss.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
