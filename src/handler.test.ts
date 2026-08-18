import { describe, it, expect, afterEach } from 'vitest';
import { createServer as createHttp, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { createSignalingHandler } from './handler.js';
import { generateKeyPairJwk } from './keys.js';
import type { SignalingHandler } from './types.js';

// ─── Harness ──────────────────────────────────────────────────────────────────

const keys = await generateKeyPairJwk();
const open: Array<{ server: Server; handler: SignalingHandler }> = [];

afterEach(async () => {
  for (const { server, handler } of open.splice(0)) {
    await handler.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/** Mount a handler on a bare http.Server, the way an embedding host would. */
async function mount(opts: { authEnabled?: boolean; onOther?: (path: string) => void } = {}) {
  const handler = await createSignalingHandler({
    authEnabled: opts.authEnabled ?? true,
    privateKeyJwk: keys.privateKeyJwk,
    publicKeyJwk: keys.publicKeyJwk,
  });
  const server = createHttp((_req, res) => {
    res.writeHead(200);
    res.end('host');
  });
  server.on('upgrade', (req, socket, head) => {
    // Synchronous dispatch — the contract handleUpgrade documents.
    if (handler.handleUpgrade(req, socket, head)) return;
    opts.onOther?.(new URL(req.url ?? '/', 'http://x').pathname);
    socket.destroy();
  });
  const port = await new Promise<number>((r) =>
    server.listen(0, () => r((server.address() as { port: number }).port)),
  );
  open.push({ server, handler });
  return { handler, server, port };
}

interface Probe {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
  closed: Promise<{ code: number; reason: string }>;
  next(): Promise<Record<string, unknown>>;
}

function connect(port: number, query: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/signal${query}`);
    const messages: Array<Record<string, unknown>> = [];
    const waiters: Array<(m: Record<string, unknown>) => void> = [];
    let closeResolve: (v: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((r) => (closeResolve = r));

    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString()) as Record<string, unknown>;
      const w = waiters.shift();
      if (w) w(msg);
      else messages.push(msg);
    });
    ws.on('close', (code, reason) => closeResolve({ code, reason: reason.toString() }));
    ws.on('error', () => {});
    ws.on('open', () =>
      resolve({
        ws,
        messages,
        closed,
        next: () =>
          new Promise((r) => {
            const buffered = messages.shift();
            if (buffered) r(buffered);
            else waiters.push(r);
          }),
      }),
    );
    setTimeout(() => reject(new Error('ws did not open')), 4000);
  });
}

const tokenFor = (h: SignalingHandler, subject: string) =>
  h.issueToken({ ttl: '1h', subject }).then((r) => encodeURIComponent(r.token));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createSignalingHandler — mounted on a foreign http.Server', () => {
  it('peers in a room discover each other', async () => {
    const { handler, port } = await mount();
    const token = await tokenFor(handler, 'room-1');

    const a = await connect(port, `?token=${token}&nodeId=a`);
    a.ws.send(JSON.stringify({ type: 'register', nodeId: 'a' }));
    expect(await a.next()).toEqual({ type: 'peer-list', peers: [] });

    const b = await connect(port, `?token=${token}&nodeId=b`);
    b.ws.send(JSON.stringify({ type: 'register', nodeId: 'b' }));
    expect(await b.next()).toEqual({ type: 'peer-list', peers: ['a'] });
  });

  it('relays an offer between peers, stamping fromRole', async () => {
    const { handler, port } = await mount();
    const token = await tokenFor(handler, 'room-2');

    const a = await connect(port, `?token=${token}&nodeId=a`);
    a.ws.send(JSON.stringify({ type: 'register', nodeId: 'a' }));
    await a.next();
    const b = await connect(port, `?token=${token}&nodeId=b`);
    b.ws.send(JSON.stringify({ type: 'register', nodeId: 'b' }));
    await b.next();

    b.ws.send(JSON.stringify({ type: 'offer', to: 'a', from: 'b', sdp: { s: 1 } }));
    expect(await a.next()).toMatchObject({ type: 'offer', from: 'b', fromRole: 'normal' });
  });

  it('rejects a token whose subject does not match the room', async () => {
    const { handler, port } = await mount();
    const token = await tokenFor(handler, 'room-mine');
    const p = await connect(port, `?token=${token}&room=room-yours`);
    expect((await p.closed).code).toBe(4003);
  });

  it('rejects an unsigned/garbage token', async () => {
    const { port } = await mount();
    const p = await connect(port, `?token=not-a-jwt`);
    expect((await p.closed).code).toBe(4003);
  });

  it('does not lose a register sent immediately on open', async () => {
    // The buffering regression: `register` races the async token verification. Send it in the
    // same tick the socket opens, repeatedly, and every attempt must still be answered.
    const { handler, port } = await mount();
    const token = await tokenFor(handler, 'room-race');
    for (let i = 0; i < 15; i++) {
      const p = await connect(port, `?token=${token}&nodeId=n${i}`);
      p.ws.send(JSON.stringify({ type: 'register', nodeId: `n${i}` }));
      expect(await p.next()).toMatchObject({ type: 'peer-list' });
      p.ws.close();
    }
  });

  it('declines upgrades on other paths without touching the socket', async () => {
    const seen: string[] = [];
    const { port } = await mount({ onOther: (p) => seen.push(p) });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4`);
    await new Promise<void>((r) => {
      ws.on('error', () => r());
      ws.on('close', () => r());
    });
    expect(seen).toEqual(['/socket.io/']);
  });

  it('serves ordinary HTTP on the same port', async () => {
    const { port } = await mount();
    const res = await fetch(`http://127.0.0.1:${port}/anything`);
    expect(await res.text()).toBe('host');
  });

  it('reports live stats for a host health endpoint', async () => {
    const { handler, port } = await mount();
    expect(handler.stats()).toEqual({ auth: 'enabled', peers: 0, rooms: 0 });
    const token = await tokenFor(handler, 'room-stats');
    const p = await connect(port, `?token=${token}&nodeId=a`);
    p.ws.send(JSON.stringify({ type: 'register', nodeId: 'a' }));
    await p.next();
    expect(handler.stats()).toEqual({ auth: 'enabled', peers: 1, rooms: 1 });
  });

  it('mints tokens locally without an admin secret', async () => {
    const { handler } = await mount();
    const res = await handler.issueToken({ ttl: '30m', subject: 'room-x' });
    expect(res.subject).toBe('room-x');
    expect(res.token.split('.')).toHaveLength(3);
    expect(Date.parse(res.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('refuses to build with auth on and no keys', async () => {
    await expect(createSignalingHandler({ authEnabled: true })).rejects.toThrow(/privateKeyJwk/);
  });

  it('accepts token-less connections when auth is disabled', async () => {
    const { port } = await mount({ authEnabled: false });
    const p = await connect(port, `?room=open-room&nodeId=a`);
    p.ws.send(JSON.stringify({ type: 'register', nodeId: 'a' }));
    expect(await p.next()).toMatchObject({ type: 'peer-list' });
  });

  it('close() returns even when a socket is still open', async () => {
    const { handler, port } = await mount();
    const token = await tokenFor(handler, 'room-close');
    await connect(port, `?token=${token}&nodeId=linger`);
    await expect(handler.close()).resolves.toBeUndefined();
  });
});
