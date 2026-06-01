# Changelog

All notable changes to `@aikofy/client-db-sync` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

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
