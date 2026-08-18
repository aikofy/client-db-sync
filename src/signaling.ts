import type { WebSocket } from 'ws';
import type { ClientRole, SignalingMessage } from './types.js';

interface Member {
  nodeId: string;
  socket: WebSocket;
  /** null until the `register` message finalizes the role. */
  role: ClientRole | null;
  // Normal-only metadata (from register + heartbeat):
  serveConsumers: boolean;
  capacity?: number;
  sessions: number;
  /** Closes the socket if it never finalizes a role (anti-DoS for pending connections). */
  registerTimer?: ReturnType<typeof setTimeout>;
}

interface Room {
  members: Map<string, Member>;
  /** Round-robin pointer for server-list rotation (per-room fairness across Consumers). */
  rrPointer: number;
}

/** A pending connection that never sends `register` within this window is closed. */
const DEFAULT_REGISTER_TIMEOUT_MS = 10_000;

export interface SignalingRegistryOptions {
  /** Ms a connection may stay unregistered before being closed. 0 disables. Default 10000. */
  registerTimeoutMs?: number;
}

/**
 * Role-aware signaling registry / load-balancing director.
 *
 * - A connection is added in a PENDING state (`role: null`) and finalized exactly once by its
 *   `register` message: Normal Clients get a `peer-list` (other Normal Clients only); Consumer
 *   Clients get a rotated `server-list` of healthy, opted-in Normal Clients.
 * - Consumers are NEVER placed in any `peer-list`, and consumer↔consumer offers are never relayed.
 * - Offers are stamped with the sender's `fromRole`.
 */
export class SignalingRegistry {
  private rooms = new Map<string, Room>();
  private readonly registerTimeoutMs: number;

  constructor(opts: SignalingRegistryOptions = {}) {
    this.registerTimeoutMs = opts.registerTimeoutMs ?? DEFAULT_REGISTER_TIMEOUT_MS;
  }

  /**
   * Add a freshly-connected socket in the pending state (role decided on `register`).
   * `authorized` = the connection has already proven its right to this nodeId/room (a Normal with
   * a valid URL room-token, or dev mode). An UNauthorized (token-less, pre-`register`) connection
   * may not displace an already-finalized member — that would let an unauthenticated socket evict
   * a live peer by guessing its nodeId.
   */
  addPending(nodeId: string, room: string, socket: WebSocket, authorized: boolean): void {
    const r = this._room(room);

    const existing = r.members.get(nodeId);
    if (existing && existing.socket !== socket) {
      if (authorized || existing.role === null) {
        // Legitimate takeover (authed reconnect) or replacing a still-pending socket.
        existing.socket.close(1000, 'replaced by new connection');
      } else {
        // Unauthenticated connection trying to displace a finalized member → refuse it.
        socket.close(4409, 'nodeId already in use');
        return;
      }
    }

    const member: Member = { nodeId, socket, role: null, serveConsumers: true, sessions: 0 };
    if (this.registerTimeoutMs > 0) {
      member.registerTimer = setTimeout(() => {
        if (member.role === null) socket.close(4002, 'registration timeout');
      }, this.registerTimeoutMs);
      // Don't let a pending timer keep the process alive.
      (member.registerTimer as { unref?: () => void }).unref?.();
    }
    r.members.set(nodeId, member);

    // Identity-aware removal: only evict if THIS socket still owns the slot (a newer socket may
    // have legitimately replaced it; the stale socket's async close must not delete the newcomer).
    socket.on('close', () => this._remove(nodeId, room, socket));
    socket.on('error', () => this._remove(nodeId, room, socket));
  }

  /** Finalize a Normal Client (once) and send it the peer-list (other Normal Clients only). */
  finalizeNormal(
    nodeId: string,
    room: string,
    opts: { serveConsumers?: boolean; capacity?: number } = {},
  ): void {
    const member = this.rooms.get(room)?.members.get(nodeId);
    if (!member || member.role !== null) return; // finalize exactly once
    this._clearTimer(member);
    member.role = 'normal';
    member.serveConsumers = opts.serveConsumers ?? true;
    member.capacity = opts.capacity;

    this._send(member.socket, { type: 'peer-list', peers: this._normalPeerIds(nodeId, room) });
  }

  /** Finalize a Consumer Client (once) and send it a rotated server-list of eligible Normals. */
  finalizeConsumer(nodeId: string, room: string): void {
    const member = this.rooms.get(room)?.members.get(nodeId);
    if (!member || member.role !== null) return; // finalize exactly once
    this._clearTimer(member);
    member.role = 'consumer';

    this._send(member.socket, { type: 'server-list', servers: this._serverList(room) });
  }

  /** Update a Normal Client's load/capacity (forward-compatible; liveness is WS-close driven). */
  handleHeartbeat(
    nodeId: string,
    room: string,
    msg: { load?: { sessions?: number }; serveConsumers?: boolean; capacity?: number },
  ): void {
    const member = this.rooms.get(room)?.members.get(nodeId);
    if (!member || member.role !== 'normal') return;
    if (msg.load?.sessions !== undefined) member.sessions = msg.load.sessions;
    if (msg.serveConsumers !== undefined) member.serveConsumers = msg.serveConsumers;
    if (msg.capacity !== undefined) member.capacity = msg.capacity;
  }

  /** Relay an offer/answer/ice-candidate to its target, stamping the sender's role. */
  route(from: string, room: string, msg: SignalingMessage): void {
    if (msg.type !== 'offer' && msg.type !== 'answer' && msg.type !== 'ice-candidate') return;

    const r = this.rooms.get(room);
    if (!r) return;

    const sender = r.members.get(from);
    // A client MUST finalize its role (via `register`) before it can signal. Otherwise an
    // unregistered connection's offer would be relayed with no `fromRole`, and the answerer
    // would treat it as a Normal (gossip) peer — letting a consumer's 'rpc' channel slip into
    // the gossip mesh. Drop signals from un-finalized senders.
    if (!sender || sender.role === null) return;

    const target = r.members.get(msg.to);
    if (!target) {
      this._send(sender.socket, {
        type: 'error',
        code: 'PEER_NOT_FOUND',
        message: `Peer ${msg.to} is not connected`,
      });
      return;
    }

    // Consumers never talk to consumers.
    if (sender.role === 'consumer' && target.role === 'consumer') return;

    this._send(target.socket, { ...msg, from, fromRole: sender.role });
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get connectedCount(): number {
    let total = 0;
    for (const r of this.rooms.values()) total += r.members.size;
    return total;
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private _room(room: string): Room {
    let r = this.rooms.get(room);
    if (!r) {
      r = { members: new Map(), rrPointer: 0 };
      this.rooms.set(room, r);
    }
    return r;
  }

  private _remove(nodeId: string, room: string, socket?: WebSocket): void {
    const r = this.rooms.get(room);
    if (!r) return;
    const member = r.members.get(nodeId);
    if (!member) return;
    // If a newer socket has taken this nodeId, the stale socket's close must not evict it.
    if (socket && member.socket !== socket) return;
    this._clearTimer(member);
    r.members.delete(nodeId);
    if (r.members.size === 0) this.rooms.delete(room);
  }

  private _clearTimer(member: Member): void {
    if (member.registerTimer) {
      clearTimeout(member.registerTimer);
      member.registerTimer = undefined;
    }
  }

  /** Finalized Normal Clients in the room, excluding `excludeNodeId`. */
  private _normalPeerIds(excludeNodeId: string, room: string): string[] {
    const r = this.rooms.get(room);
    if (!r) return [];
    const out: string[] = [];
    for (const m of r.members.values()) {
      if (m.role === 'normal' && m.nodeId !== excludeNodeId) out.push(m.nodeId);
    }
    return out;
  }

  /** Eligible Normal Clients (opted-in, under capacity, healthy), rotated round-robin. */
  private _serverList(room: string): string[] {
    const r = this.rooms.get(room);
    if (!r) return [];
    const eligible: string[] = [];
    for (const m of r.members.values()) {
      if (m.role !== 'normal' || !m.serveConsumers) continue;
      if (m.capacity !== undefined && m.sessions >= m.capacity) continue;
      eligible.push(m.nodeId);
    }
    if (eligible.length === 0) return [];
    // Rotate by the per-room pointer so independent Consumers start on different nodes.
    const offset = r.rrPointer % eligible.length;
    r.rrPointer = (r.rrPointer + 1) % eligible.length;
    return [...eligible.slice(offset), ...eligible.slice(0, offset)];
  }

  private _send(socket: WebSocket, msg: SignalingMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }
}
