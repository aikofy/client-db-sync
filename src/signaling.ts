import type { WebSocket } from '@fastify/websocket';
import type { SignalingMessage } from './types.js';

interface Peer {
  nodeId: string;
  socket: WebSocket;
}

export class SignalingRegistry {
  // room → (nodeId → peer)
  private rooms = new Map<string, Map<string, Peer>>();

  register(nodeId: string, room: string, socket: WebSocket): void {
    if (!this.rooms.has(room)) {
      this.rooms.set(room, new Map());
    }
    const peers = this.rooms.get(room)!;

    // Replace any stale connection for the same nodeId within the room
    const existing = peers.get(nodeId);
    if (existing && existing.socket !== socket) {
      existing.socket.close(1000, 'replaced by new connection');
    }

    peers.set(nodeId, { nodeId, socket });

    // Send the new peer the list of other peers in the same room
    this._send(socket, {
      type: 'peer-list',
      peers: this._otherIds(nodeId, room),
    });

    socket.on('close', () => this._remove(nodeId, room));
    socket.on('error', () => this._remove(nodeId, room));
  }

  route(from: string, room: string, raw: string): void {
    let msg: SignalingMessage;
    try {
      msg = JSON.parse(raw) as SignalingMessage;
    } catch {
      return;
    }

    const peers = this.rooms.get(room);
    if (!peers) return;

    switch (msg.type) {
      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        const target = peers.get(msg.to);
        if (!target) {
          const sender = peers.get(from);
          if (sender) {
            this._send(sender.socket, {
              type: 'error',
              code: 'PEER_NOT_FOUND',
              message: `Peer ${msg.to} is not connected`,
            });
          }
          return;
        }
        this._send(target.socket, { ...msg, from });
        break;
      }
      default:
        break;
    }
  }

  private _remove(nodeId: string, room: string): void {
    const peers = this.rooms.get(room);
    if (!peers) return;
    peers.delete(nodeId);
    if (peers.size === 0) this.rooms.delete(room);
  }

  private _otherIds(excludeNodeId: string, room: string): string[] {
    const peers = this.rooms.get(room);
    if (!peers) return [];
    return Array.from(peers.keys()).filter((id) => id !== excludeNodeId);
  }

  private _send(socket: WebSocket, msg: SignalingMessage): void {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  get connectedCount(): number {
    let total = 0;
    for (const peers of this.rooms.values()) total += peers.size;
    return total;
  }
}
