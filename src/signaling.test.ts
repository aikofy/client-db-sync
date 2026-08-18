import { describe, it, expect } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { WebSocket } from 'ws';
import { SignalingRegistry } from './signaling.js';
import { makeConsumerVerifier } from './auth.js';

// ─── Fake socket ──────────────────────────────────────────────────────────────

class FakeSocket {
  OPEN = 1;
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  closed: { code: number; reason: string } | null = null;
  private handlers = new Map<string, () => void>();

  send(s: string): void {
    this.sent.push(JSON.parse(s) as Record<string, unknown>);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  on(ev: string, cb: () => void): void {
    this.handlers.set(ev, cb);
  }
  fire(ev: string): void {
    this.handlers.get(ev)?.();
  }
  last(): Record<string, unknown> {
    return this.sent[this.sent.length - 1];
  }
}

const sock = (): FakeSocket => new FakeSocket();
const asWs = (s: FakeSocket): WebSocket => s as unknown as WebSocket;

function addNormal(
  reg: SignalingRegistry,
  room: string,
  id: string,
  opts?: { serveConsumers?: boolean; capacity?: number },
): FakeSocket {
  const s = sock();
  reg.addPending(id, room, asWs(s), true);
  reg.finalizeNormal(id, room, opts ?? {});
  return s;
}

function addConsumer(reg: SignalingRegistry, room: string, id: string): FakeSocket {
  const s = sock();
  reg.addPending(id, room, asWs(s), true);
  reg.finalizeConsumer(id, room);
  return s;
}

// ─── Registry ───────────────────────────────────────────────────────────────

describe('SignalingRegistry — roles', () => {
  it('peer-list contains only Normal Clients (never consumers)', () => {
    const reg = new SignalingRegistry();
    const a = addNormal(reg, 'r', 'A');
    addConsumer(reg, 'r', 'C'); // a consumer is present in the room
    const b = addNormal(reg, 'r', 'B');

    expect(a.sent[0]).toEqual({ type: 'peer-list', peers: [] }); // A joined first
    expect(b.last()).toEqual({ type: 'peer-list', peers: ['A'] }); // B sees A, NOT C
  });

  it('a Consumer gets a server-list of healthy Normal Clients, not a peer-list', () => {
    const reg = new SignalingRegistry();
    addNormal(reg, 'r', 'A');
    addNormal(reg, 'r', 'B');
    const c = addConsumer(reg, 'r', 'C');
    expect(c.last()['type']).toBe('server-list');
    expect(c.last()['servers']).toEqual(expect.arrayContaining(['A', 'B']));
    expect((c.last()['servers'] as string[]).length).toBe(2);
  });

  it('rotates the server-list round-robin across consumers', () => {
    const reg = new SignalingRegistry();
    addNormal(reg, 'r', 'A');
    addNormal(reg, 'r', 'B');
    addNormal(reg, 'r', 'C');
    const c1 = addConsumer(reg, 'r', 'C1');
    const c2 = addConsumer(reg, 'r', 'C2');
    expect(c1.last()['servers']).toEqual(['A', 'B', 'C']);
    expect(c2.last()['servers']).toEqual(['B', 'C', 'A']); // rotated by one
  });

  it('excludes serveConsumers:false nodes from the server-list', () => {
    const reg = new SignalingRegistry();
    addNormal(reg, 'r', 'A', { serveConsumers: false });
    addNormal(reg, 'r', 'B');
    const c = addConsumer(reg, 'r', 'C');
    expect(c.last()['servers']).toEqual(['B']);
  });

  it('excludes at-capacity nodes after a heartbeat', () => {
    const reg = new SignalingRegistry();
    addNormal(reg, 'r', 'A', { capacity: 1 });
    addNormal(reg, 'r', 'B');
    reg.handleHeartbeat('A', 'r', { load: { sessions: 1 } }); // A is now full
    const c = addConsumer(reg, 'r', 'C');
    expect(c.last()['servers']).toEqual(['B']);
  });

  it('relays an offer to its target, stamping fromRole', () => {
    const reg = new SignalingRegistry();
    const a = addNormal(reg, 'r', 'A');
    addConsumer(reg, 'r', 'C');
    reg.route('C', 'r', { type: 'offer', to: 'A', from: 'C', sdp: 'x' });
    expect(a.last()).toEqual({ type: 'offer', to: 'A', from: 'C', sdp: 'x', fromRole: 'consumer' });
  });

  it('drops signals from an un-finalized (unregistered) sender — no gossip-peer leak', () => {
    const reg = new SignalingRegistry();
    const a = addNormal(reg, 'r', 'A');
    const p = sock();
    reg.addPending('P', 'r', asWs(p), true); // connected but never sent `register`
    const before = a.sent.length;
    reg.route('P', 'r', { type: 'offer', to: 'A', from: 'P', sdp: 'x' });
    expect(a.sent.length).toBe(before); // not relayed
  });

  it('never relays consumer↔consumer offers', () => {
    const reg = new SignalingRegistry();
    addConsumer(reg, 'r', 'C1');
    const c2 = addConsumer(reg, 'r', 'C2');
    const before = c2.sent.length;
    reg.route('C1', 'r', { type: 'offer', to: 'C2', from: 'C1', sdp: 'x' });
    expect(c2.sent.length).toBe(before); // dropped
  });

  it('removes a node on socket close (drops it from later server-lists)', () => {
    const reg = new SignalingRegistry();
    const s = sock();
    reg.addPending('A', 'r', asWs(s), true);
    reg.finalizeNormal('A', 'r', {});
    addNormal(reg, 'r', 'B');
    s.fire('close'); // A disconnects
    const c = addConsumer(reg, 'r', 'C');
    expect(c.last()['servers']).toEqual(['B']);
  });

  it('replaces a stale connection with the same nodeId', () => {
    const reg = new SignalingRegistry();
    const s1 = sock();
    reg.addPending('A', 'r', asWs(s1), true);
    const s2 = sock();
    reg.addPending('A', 'r', asWs(s2), true);
    expect(s1.closed?.code).toBe(1000);
  });

  it('a same-nodeId reconnect survives the stale socket closing afterwards', () => {
    const reg = new SignalingRegistry();
    const s1 = sock();
    reg.addPending('A', 'r', asWs(s1), true);
    reg.finalizeNormal('A', 'r', {});
    const s2 = sock();
    reg.addPending('A', 'r', asWs(s2), true); // takeover
    expect(s1.closed?.code).toBe(1000);
    reg.finalizeNormal('A', 'r', {}); // finalize the new socket
    s1.fire('close'); // stale socket's async close must NOT evict the newcomer

    const c = addConsumer(reg, 'r', 'C');
    expect(c.last()['servers']).toEqual(['A']); // A (s2) is still in the room
  });

  it('an unauthorized connection cannot evict a finalized member', () => {
    const reg = new SignalingRegistry();
    const a = addNormal(reg, 'r', 'A'); // finalized normal
    const s2 = sock();
    reg.addPending('A', 'r', asWs(s2), false); // token-less, tries to take 'A'
    expect(s2.closed?.code).toBe(4409);
    expect(a.closed).toBeNull(); // the finalized member was NOT kicked
    const c = addConsumer(reg, 'r', 'C');
    expect(c.last()['servers']).toEqual(['A']);
  });

  it('closes a pending connection that never registers (anti-DoS timeout)', async () => {
    const reg = new SignalingRegistry({ registerTimeoutMs: 20 });
    const s = sock();
    reg.addPending('P', 'r', asWs(s), true);
    await new Promise((r) => setTimeout(r, 45));
    expect(s.closed?.code).toBe(4002);
  });
});

// ─── Consumer token verification ──────────────────────────────────────────────

async function makeIdp() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = (await exportJWK(publicKey)) as unknown as Record<string, unknown>;
  jwk['kid'] = 'k1';
  jwk['alg'] = 'ES256';
  const jwksB64 = Buffer.from(JSON.stringify({ keys: [jwk] })).toString('base64');
  const mint = (
    claims: Record<string, unknown>,
    opts: { iss?: string; aud?: string; exp?: string | number } = {},
  ): Promise<string> =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuedAt()
      .setIssuer(opts.iss ?? 'idp')
      .setAudience(opts.aud ?? 'aud')
      .setSubject('user1')
      .setExpirationTime(opts.exp ?? '5m')
      .sign(privateKey);
  return { jwksB64, mint };
}

describe('makeConsumerVerifier', () => {
  it('accepts a valid ES256 token and returns its claims', async () => {
    const { jwksB64, mint } = await makeIdp();
    const verify = makeConsumerVerifier({ jwks: jwksB64, issuer: 'idp', audience: 'aud' });
    const claims = await verify(await mint({ scope: 'todos:read' }));
    expect(claims['sub']).toBe('user1');
  });

  it('rejects wrong issuer or audience', async () => {
    const { jwksB64, mint } = await makeIdp();
    const verify = makeConsumerVerifier({ jwks: jwksB64, issuer: 'idp', audience: 'aud' });
    await expect(verify(await mint({}, { iss: 'evil' }))).rejects.toBeDefined();
    await expect(verify(await mint({}, { aud: 'evil' }))).rejects.toBeDefined();
  });

  it('rejects an expired token', async () => {
    const { jwksB64, mint } = await makeIdp();
    const verify = makeConsumerVerifier({ jwks: jwksB64 });
    const past = Math.floor(Date.now() / 1000) - 60;
    await expect(verify(await mint({}, { exp: past }))).rejects.toBeDefined();
  });

  it('rejects a token signed by a different key (forged)', async () => {
    const real = await makeIdp();
    const attacker = await makeIdp();
    const verify = makeConsumerVerifier({ jwks: real.jwksB64 });
    await expect(verify(await attacker.mint({}))).rejects.toBeDefined();
  });
});
