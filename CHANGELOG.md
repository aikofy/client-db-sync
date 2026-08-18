# Changelog

All notable changes to `@aikofy/client-db-sync` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## 2.1.0

### Added — first-class embedding

The signaling core is now usable without the standalone HTTP server, so it can share a port with
an app you already run (socket.io, Express, Hono, …). See the README "Embedded" section.

- **`createSignalingHandler(config)`** — framework-agnostic core built on `ws` with
  `noServer: true`. Owns the registry, the room-token keys and the WebSocket upgrade, and nothing
  else. Returns `handleUpgrade` / `handleConnection` / `issueToken` / `publicJwk` / `stats` /
  `registry` / `close`.
- **`@aikofy/client-db-sync/embed` subpath export** — the same core with no Fastify in the module
  graph (`ws`, `jose`, `uuid` only).
- **`handler.issueToken()`** mints room tokens in-process. An embedding host already holds the
  signing key, so it no longer needs `POST /token` or an `ADMIN_SECRET` round-trip to itself.
- **`handler.stats()`** → `{ auth, peers, rooms }`, so an embedded deployment can report peer
  counts on its own health endpoint. Previously `registry.connectedCount` was only reachable
  through this package's `/health` route.
- **`SignalingRegistry.roomCount`** getter.
- **`registerTimeoutMs`** is now settable through `ServerConfig` (it was already supported by
  `SignalingRegistry`, but `createServer` never passed it through).

### Fixed

- **A `register` message sent in the client's `onopen` handler could be dropped.** Connections are
  accepted before the room token is verified, and the message listener was only attached after
  that `await` resolved — so a client fast enough to register in the same tick lost its
  registration and then sat in the room unfinalized until the 10 s register timeout closed it.
  Messages arriving during verification are now buffered and replayed. Most visible under an
  embedded handler or a loaded event loop, where the verification gap is wider.
- **`handler.close()` could hang** if a client never ACKed the close frame (`wss.close()` waits
  for every socket). Shutdown now `terminate()`s remaining clients so an embedding host's
  `SIGTERM` cannot stall on a half-open `/signal` socket.

### Changed

- `createServer` is now a thin wrapper over `createSignalingHandler`; connection handling has one
  implementation, so embedded and standalone peers are guaranteed to see identical frames. The
  HTTP surface, WS route, close codes and payloads are unchanged.
- Internal types reference `ws`'s `WebSocket` rather than re-exporting it from
  `@fastify/websocket`. `ws` is now a direct dependency (it was already present transitively).

## 2.0.0

### Added — role-aware Consumer Client support

Brokers the `@aikofy/client-db` 2.0.0 **Consumer Client** role and acts as a load-balancing
director. See the README "Consumer Clients" section.

- **Roles via `register`** — clients declare `role: "normal" | "consumer"` in their `register`
  message (default `"normal"`). Registration is now finalized on the `register` message rather than
  at connect, so role-specific handling (and consumer auth) can apply.
- **Normal Clients** receive a `peer-list` of *other Normal Clients only*; Consumers are never
  gossip peers, and **consumer↔consumer offers are never relayed**.
- **Consumer Clients** receive a `server-list` of healthy, opted-in Normal Clients, **rotated
  round-robin** per room so independent Consumers spread across nodes. A node dropping out of the
  list drives Consumer failover.
- **`serveConsumers` / `capacity` / `heartbeat`** — Normal Clients can opt out of serving
  Consumers or advertise a capacity; an optional `heartbeat` updates load so at-capacity nodes are
  excluded from the `server-list`.
- **`fromRole`** is stamped on relayed offers so the answerer can branch early.
- **Consumer token verification** — `makeConsumerVerifier` / `ConsumerAuthConfig` verify a
  Consumer's IdP token (ES256/RS256, `alg:none` rejected, `iss`/`aud` checked) as a defense-in-depth
  admission gate. Configured via `CONSUMER_PUBLIC_KEY_JWK` / `CONSUMER_ISSUER` / `CONSUMER_AUDIENCE`.
- New exported types: `ClientRole`, `ConsumerAuthConfig`, `ServerListMessage`, `AuthErrMessage`,
  `HeartbeatMessage`, and the role fields on `RegisterMessage` / `OfferMessage`.
- **Tests** — added a `vitest` suite for the registry role logic and consumer-token verification.

### Compatibility

- **No breaking changes for Normal-Client-only deployments.** A client with no `role` is treated as
  `"normal"`; `peer-list`/offer/answer/ICE relaying behave as before. Room-access (Ed25519) tokens
  via `POST /token` are unchanged.
- To serve Consumers, set `CONSUMER_PUBLIC_KEY_JWK` (your IdP's public key). When auth is enabled and
  it is unset, Consumer registrations are refused but Normal-Client sync is unaffected.

## 0.1.x

- Minimal WebRTC signaling: room-based peer discovery, offer/answer/ICE relay, Ed25519 JWT room
  tokens (`POST /token`), `/health` and `/public-key` endpoints, CLI + key generation.
