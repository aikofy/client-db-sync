# @aikofy/client-db-sync

Minimal WebRTC signaling server for [`@aikofy/client-db`](https://www.npmjs.com/package/@aikofy/client-db).

Handles peer discovery (offer/answer/ICE exchange) over WebSocket with **room-based isolation** — peers only see other peers in the same room. Protected by **Ed25519 JWT tokens** with configurable TTL.

**New in 2.0.0:** role-aware support for `@aikofy/client-db` **Consumer Clients** — thin clients that call a Normal Client's RPC functions instead of replicating. The server keeps Consumers out of the gossip mesh and acts as a load-balancing **director** (see [Consumer Clients](#consumer-clients)). Normal-Client-only sync is unchanged and needs no configuration change.

[![npm version](https://img.shields.io/npm/v/@aikofy/client-db-sync)](https://www.npmjs.com/package/@aikofy/client-db-sync)
[![license](https://img.shields.io/npm/l/@aikofy/client-db-sync)](./LICENSE)

---

## How It Works

```
Your backend ──POST /token──► Signaling server (issues JWT scoped to a room)
                                      │
Client A ──WS /signal?token=JWT──►   │   ◄──WS /signal?token=JWT── Client B
              (room = user-123)       │         (room = user-123)
                    ◄── peer-list ────┤  (only peers in same room)
                    ── offer ────────►│──────────────────────────►
                    ◄── answer ───────│◄──────────────────────────
                    ── ice-candidate ►│──────────────────────────►
```

After the WebRTC handshake, all sync data flows **directly peer-to-peer** — nothing passes through this server.

### Room isolation

Each client connects to a **room** identified by their DB name. Peers in different rooms are completely invisible to each other — they receive no peer-list entries and cannot exchange signals.

When auth is enabled, the room is enforced by the JWT token: a token issued with `subject: "user-123"` can **only** join room `user-123`. Knowing a room name (e.g. a userID) is not enough to join it without a valid token.

### Registry rules

The peer registry is keyed by `(room, nodeId)`. A second connection arriving with the **same `nodeId` in the same room** evicts the previous one with WebSocket close code `1000 'replaced by new connection'`.

This is a feature — it lets a reconnecting client take over from a stale socket without waiting for the previous one to time out. It becomes a problem when two *different* clients (e.g. two browser tabs of the same user) accidentally share a `nodeId`: each new connection kicks the other, producing a reconnect loop.

**Always pass a per-tab unique `nodeId`** when running multiple tabs of the same browser. `@aikofy/client-db` supports this via `sync.nodeId` — see its README for the `sessionStorage` pattern.

---

## Consumer Clients

`@aikofy/client-db` 2.0.0 adds a second client role. **Normal Clients** hold a full replica and
gossip with each other (as above). **Consumer Clients** hold no data — they connect to a Normal
Client and call its RPC functions. This server brokers both and keeps them apart:

- A client declares its role in the `register` message (`role: "normal" | "consumer"`; default
  `"normal"`, so 1.x clients are unaffected).
- **Normal Clients** get a `peer-list` of *other Normal Clients only* — Consumers are never gossip
  peers, and consumer↔consumer offers are never relayed.
- **Consumer Clients** get a `server-list`: the healthy, opted-in Normal Clients they may call,
  **rotated round-robin** so independent Consumers spread across nodes. Removing a dead node from
  the list is what drives a Consumer's failover to another node.
- Relayed offers are stamped with `fromRole` so the answerer can branch early.

### Authenticating Consumers

A Consumer connects **without** a URL `?token=` and instead presents its IdP access token in the
`register` message. The server verifies it as a **defense-in-depth admission gate** (the Normal
Client re-verifies it authoritatively on the RPC data channel). Configure your IdP's public key(s):

| Variable | Description |
|----------|-------------|
| `CONSUMER_PUBLIC_KEY_JWK` | Base64-encoded JWK, JWK array, or `{ keys: [...] }` JWKS of your IdP's public key(s). **Enables Consumer support.** |
| `CONSUMER_ISSUER` | Expected token `iss` (optional) |
| `CONSUMER_AUDIENCE` | Expected token `aud` (optional) |

Tokens are verified with **ES256/RS256** (matching `@aikofy/client-db`'s `createTokenVerifier`);
`alg:none` is rejected. When auth is enabled and `CONSUMER_PUBLIC_KEY_JWK` is **not** set, Consumer
registrations are refused (Normal-Client sync still works). With `AUTH_DISABLED=true` (dev),
Consumers are accepted without verification.

> These are separate from the server's own Ed25519 **room tokens** (which gate Normal Clients via
> `POST /token`). Consumer tokens are issued by *your* IdP and only verified here.

---

## Quick Start

### 1. Generate keys

```bash
npx @aikofy/client-db-sync keygen

# After `npm install @aikofy/client-db-sync` in this project:
npx client-db-sync-keygen
```

There is no package named `@aikofy/client-db-sync-keygen`. `keygen` is a command of
`@aikofy/client-db-sync`. `bun run keygen` only exists in this repo's `package.json`, not in an
app that depends on the package.

Copy the output into your `.env` file.

### 2. Configure

**Production:**

```bash
# .env
PRIVATE_KEY_JWK=<output from keygen>
PUBLIC_KEY_JWK=<output from keygen>
ADMIN_SECRET=a-strong-random-secret
PORT=8080
```

**Local development (no auth):**

```bash
# .env
AUTH_DISABLED=true
PORT=8080
```

> ⚠️ `AUTH_DISABLED=true` lets any client connect without a token. Rooms still provide namespace separation but offer no security guarantee. Never use it in production. The server logs a warning at startup when this is set.

### 3. Run

```bash
# With npx (no install needed)
npx @aikofy/client-db-sync

# Or install globally
npm install -g @aikofy/client-db-sync
client-db-sync

# Or as a local dependency
npm install @aikofy/client-db-sync
node node_modules/@aikofy/client-db-sync/dist/index.js
```

---

### Runtime: Node or Bun

The server runs on **Node 18+** or **Bun 1.x**. Both are supported. Key generation (`npx @aikofy/client-db-sync keygen`) requires `0.1.3` or newer when running under Bun — earlier versions hit a `non-extractable CryptoKey` error because Bun resolves jose's `browser` export, which creates non-extractable keys by default.

If you see that error, upgrade:

```bash
npm install @aikofy/client-db-sync@latest
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_DISABLED` | No | Set to `true` to disable JWT auth (dev only) |
| `PRIVATE_KEY_JWK` | Yes (auth on) | Base64-encoded Ed25519 private key JWK |
| `PUBLIC_KEY_JWK` | Yes (auth on) | Base64-encoded Ed25519 public key JWK |
| `ADMIN_SECRET` | Yes (auth on) | Secret for the `POST /token` endpoint |
| `CONSUMER_PUBLIC_KEY_JWK` | No | Base64 JWK/JWKS of your IdP's public key(s) — enables Consumer Client support (see [Consumer Clients](#consumer-clients)) |
| `CONSUMER_ISSUER` | No | Expected `iss` for consumer tokens |
| `CONSUMER_AUDIENCE` | No | Expected `aud` for consumer tokens |
| `PORT` | No | Server port (default `8080`) |

---

## Docker

```dockerfile
FROM node:22-alpine
RUN npm install -g @aikofy/client-db-sync
EXPOSE 8080
CMD ["client-db-sync"]
```

```bash
docker run -p 8080:8080 \
  -e PRIVATE_KEY_JWK="..." \
  -e PUBLIC_KEY_JWK="..." \
  -e ADMIN_SECRET="..." \
  your-image
```

---

## API

### `GET /health`

Returns server status and total connected peer count. No authentication required.

```json
{ "status": "ok", "auth": "enabled", "peers": 3, "ts": "2026-01-01T00:00:00.000Z" }
```

---

### `GET /public-key`

Returns the Ed25519 public key as a JWK. No authentication required.

Clients can use this to verify tokens locally if needed.

```json
{
  "alg": "EdDSA",
  "crv": "Ed25519",
  "kty": "OKP",
  "x": "..."
}
```

---

### `POST /token`

Issues a signed JWT scoped to a room. **Requires the admin secret.**

The `subject` field becomes the room name — clients using a token can only join the room that matches their token's subject. Set `subject` to the user's DB name (typically their userID).

**Headers:**

```
x-admin-secret: <your ADMIN_SECRET>
```

or:

```
Authorization: Bearer <your ADMIN_SECRET>
```

**Body:**

```json
{
  "ttl": "24h",
  "subject": "user-123"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `ttl` | `string` | Token lifetime — e.g. `"1h"`, `"7d"`, `"30m"` |
| `subject` | `string` (optional) | The room this token authorizes. Set to the DB name / userID. Defaults to `"default"`. |

**Response `201`:**

```json
{
  "token": "eyJ...",
  "expiresAt": "2026-01-02T00:00:00.000Z",
  "subject": "user-123"
}
```

---

### `WS /signal?token=<jwt>&room=<room>&nodeId=<uuid>`

WebSocket endpoint for WebRTC signaling.

| Query param | Required | Description |
|-------------|----------|-------------|
| `token` | Yes (auth on) | JWT issued by `POST /token` |
| `room` | Yes | The room to join. Must match `token.sub` when auth is enabled. Set automatically by `@aikofy/client-db` from the DB name. |
| `nodeId` | No | Client's node UUID (falls back to JWT subject) |

**Room validation (auth enabled):** If the `room` param does not match the token's `subject`, the connection is closed with code `4003`.

**Auth disabled:** The `room` param is accepted as-is. If omitted, defaults to `"default"`. No token required.

**Close codes:**

| Code | Reason |
|------|--------|
| `4001` | Missing token (auth enabled) |
| `4003` | Invalid or expired token, or room does not match token subject |
| `1000` | Replaced by a new connection from the same nodeId |

---

## Connecting from `@aikofy/client-db`

The `room` param is appended automatically from the DB name — you only need to pass the token:

```typescript
// Backend (Node.js / any server)
const res = await fetch('https://your-signal-server.example.com/token', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-admin-secret': process.env.ADMIN_SECRET,
  },
  // subject must equal the DB name the client will use
  body: JSON.stringify({ ttl: '24h', subject: req.user.id }),
});
const { token } = await res.json();
// Return token to the client
```

```typescript
// Client (React / browser)
import { createDB } from '@aikofy/client-db';

const db = await createDB({
  name: currentUser.id,   // DB name = room — must match the token subject
  version: 1,
  collections: { todos: { indexes: ['status'] } },
  sync: {
    // The library appends ?room=<dbName> automatically
    signalingServer: `wss://your-signal-server.example.com/signal?token=${token}`,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  },
});
```

---

## Programmatic API

Two entrypoints, depending on whether you want your own HTTP server.

### Standalone — `createServer`

Runs the whole thing: `/health`, `/public-key`, `POST /token` and `WS /signal` on a Fastify
instance you listen on yourself. This is what the CLI uses.

```typescript
import { createServer, generateKeyPairJwk } from '@aikofy/client-db-sync';

// Generate keys once and store them in env/secrets manager
const { privateKeyJwk, publicKeyJwk } = await generateKeyPairJwk();

const app = await createServer({
  port: 8080,
  authEnabled: true,
  adminSecret: 'my-secret',
  privateKeyJwk,
  publicKeyJwk,
});

await app.listen({ port: 8080, host: '0.0.0.0' });
```

### Embedded — `createSignalingHandler`

Mounts signaling on an HTTP server you already have, **sharing its port** with whatever else is
running there (socket.io, Express, Hono, …). No second service, no second port, no admin secret:
the process holds the signing key, so it mints tokens with a direct call.

Import from `@aikofy/client-db-sync/embed` to keep Fastify out of your dependency graph — that
entrypoint pulls in only `ws`, `jose` and `uuid`.

```typescript
import { createServer as createHttp } from 'node:http';
import { Server as IOServer } from 'socket.io';
import { createSignalingHandler } from '@aikofy/client-db-sync/embed';

const signaling = await createSignalingHandler({
  authEnabled: true,
  privateKeyJwk,
  publicKeyJwk,
  // path: '/signal' by default; pass null to claim every upgrade you hand it
});

const httpServer = createHttp(myApp);

// Share the port with socket.io. `destroyUpgrade: false` stops engine.io from
// reaping upgrades on paths it does not own — see the note below.
const io = new IOServer(httpServer, { destroyUpgrade: false });

httpServer.on('upgrade', (req, socket, head) => {
  if (signaling.handleUpgrade(req, socket, head)) return;   // claimed /signal
  if (!(req.url ?? '').startsWith('/socket.io/')) socket.destroy();
});

httpServer.listen(3001);
```

Mint room tokens for your own authenticated users — no HTTP hop, no `ADMIN_SECRET`:

```typescript
const { token, expiresAt, subject } = await signaling.issueToken({
  ttl: '24h',
  subject: `mmgr-user-${userId}`,   // MUST equal the client's room name
});
```

Expose signaling health on your existing health endpoint:

```typescript
app.get('/healthz', () => ({ ...myStats, signaling: signaling.stats() }));
// { auth: 'enabled', peers: 12, rooms: 5 }
```

#### Two rules when embedding

1. **Call `handleUpgrade` synchronously** from the `upgrade` listener. It takes the socket over
   immediately, so no client bytes are lost; any `await` before it and the handshake dies. All
   async work (token verification) already happens after the upgrade, inside the handler.
2. **If socket.io shares the port, pass `destroyUpgrade: false`.** By default engine.io arms a 1 s
   timer on every upgrade for a path it does not own and destroys the socket. Your own fallback
   branch (above) should destroy unknown paths instead.

`handleUpgrade` returns `false` without touching the socket when the path is not this handler's,
so your routing stays in charge.

### Full embedded surface

| Member | Purpose |
|---|---|
| `handleUpgrade(req, socket, head)` | Claim a raw upgrade. Sync-safe. Returns `false` on a path mismatch. |
| `handleConnection(ws, requestUrl)` | Drive an already-upgraded socket (hosts that handshake themselves). |
| `issueToken({ ttl, subject })` | Mint a room token locally. Throws when `authEnabled` is false. |
| `publicJwk()` | The public JWK, for your own `/public-key`. `null` when auth is off. |
| `stats()` | `{ auth, peers, rooms }`. |
| `registry` | The underlying `SignalingRegistry`. |
| `close()` | Close all sockets and the WebSocket server. |

---

## Security Notes

- **Never expose `PRIVATE_KEY_JWK`** — only the server needs it
- **`PUBLIC_KEY_JWK`** is safe to share with clients for local token verification
- **`ADMIN_SECRET`** should only be known by your backend — never sent to browsers
- Tokens are signed with Ed25519 (`EdDSA`) and verified on every WebSocket connection
- **Room enforcement** — a token for room `user-123` cannot join room `user-456`, even if the attacker knows the room name. Security depends on your backend's auth, not the secrecy of the room identifier.
- Expired tokens are rejected — reconnect logic in `@aikofy/client-db` handles token refresh

---

## Project Structure

```
src/
  types.ts       # Message types + config interfaces
  keys.ts        # Ed25519 key pair loading and generation
  auth.ts        # JWT issuance and verification
  signaling.ts   # Room-keyed peer registry + message routing
  handler.ts     # Framework-agnostic signaling core (upgrade + connection logic)
  server.ts      # Standalone Fastify server + HTTP routes (wraps handler.ts)
  cli.ts         # CLI entry point (bin: client-db-sync)
  index.ts       # Programmatic exports
  embed.ts       # Fastify-free exports (@aikofy/client-db-sync/embed)
scripts/
  generate-keys.ts  # Key generation helper (bin: client-db-sync-keygen)
```

---

## Contributing

```bash
bun install
bun run build
bun run typecheck
```

---

## License

MIT © Lwin Maung Maung
