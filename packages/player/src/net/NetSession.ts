/**
 * The host-page side of netplay: joins a room over a {@link NetTransport},
 * assigns player slots, and relays the cart's published state and events to the
 * other players — and theirs into this cart. See netplay.ts for the pmem layout.
 *
 * Slots are assigned deterministically from the room's membership (ordered by
 * join time, then id), so every browser agrees who is in which slot without a
 * server; the lowest slot is the host. Everything is sent in one message every
 * 4 ticks (~15 Hz): the latest state (a snapshot — a lost one is replaced by the
 * next), every event raised since (a hit, a kill: at most 50 ms late), and the
 * host's match word.
 */

import {
  NET_IN_EVENT_CAPACITY,
  NET_MODE_CLIENT,
  NET_MODE_HOST,
  NET_SLOTS,
  takeNetOutbox,
  writeNetInbox,
  type NetEvent,
  type NetState,
} from "./netplay.js";

/** A room member as the transport's presence reports it. */
export interface NetPeer {
  readonly id: string;
  /** When the peer joined (ms since epoch) — orders the slots. */
  readonly joinedAt: number;
  readonly name?: string;
}

/**
 * The one message the session sends, ~15 times a second: the slots this player
 * published ([slot, w0, w1, w2]), the events raised since the last one, and (from
 * the host) the match word. One batched message per player keeps a room well
 * inside a hosted broadcast service's message-rate limits.
 */
export interface NetMessage {
  readonly s?: readonly (readonly [number, number, number, number])[];
  readonly e?: readonly NetEvent[];
  readonly m?: number;
}

/** A room-scoped broadcast channel with presence. */
export interface NetTransport {
  /** This browser's peer id. */
  readonly selfId: string;
  /** Join the room, announcing when we joined. Resolves once subscribed. */
  connect(joinedAt: number, name?: string): Promise<void>;
  /** Broadcast to every other peer (never echoed back to the sender). */
  send(message: NetMessage): void;
  onMessage(handler: (message: NetMessage, from: string) => void): void;
  /** The full membership, each time it changes (including us). */
  onPeers(handler: (peers: readonly NetPeer[]) => void): void;
  close(): void;
}

/** The session's view of the room, for a lobby UI. */
export interface NetRoomStatus {
  readonly connected: boolean;
  readonly peers: readonly NetPeer[];
  readonly mySlot: number;
  readonly isHost: boolean;
}

/** Ticks between state snapshots (60 Hz / 4 = 15 Hz). */
const STATE_EVERY = 4;
/** Remote state older than this is treated as gone (the peer dropped). */
const STALE_MS = 3000;

export class NetSession {
  private peers: readonly NetPeer[] = [];
  private connected = false;
  private readonly joinedAt = Date.now();
  private readonly remote = new Map<number, { state: NetState; at: number }>();
  private readonly pendingEvents: NetEvent[] = [];
  private hostMatch = 0;
  private tick = 0;
  private readonly outEvents: NetEvent[] = [];
  private outStates = new Map<number, NetState>();
  private readonly listeners = new Set<(status: NetRoomStatus) => void>();

  constructor(
    private readonly transport: NetTransport,
    private readonly now: () => number = () => Date.now(),
  ) {
    transport.onPeers((peers) => {
      this.peers = [...peers].sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      this.emit();
    });
    transport.onMessage((message) => this.receive(message));
  }

  /** Join the room. */
  async connect(name?: string): Promise<void> {
    await this.transport.connect(this.joinedAt, name);
    this.connected = true;
    this.emit();
  }

  close(): void {
    this.connected = false;
    this.transport.close();
    this.emit();
  }

  /** This browser's slot (0..7), or -1 while the room is full/unknown. */
  get mySlot(): number {
    const index = this.peers.findIndex((p) => p.id === this.transport.selfId);
    return index >= 0 && index < NET_SLOTS ? index : -1;
  }

  get isHost(): boolean {
    return this.mySlot === 0;
  }

  status(): NetRoomStatus {
    return { connected: this.connected, peers: this.peers, mySlot: this.mySlot, isHost: this.isHost };
  }

  /** Subscribe to room changes (membership, connection). */
  onStatus(listener: (status: NetRoomStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  /** Fill the cart's inbox before a tick. `words` is a live view of pmem 0..118. */
  beforeTick(words: Uint32Array): void {
    const mySlot = this.mySlot;
    if (!this.connected || mySlot < 0) {
      writeNetInbox(words, { mode: 0, mySlot: 0, humans: 0, live: 0, match: 0, seq: this.tick, slots: [], events: [] });
      return;
    }
    const now = this.now();
    let humans = 0;
    for (let slot = 0; slot < Math.min(NET_SLOTS, this.peers.length); slot += 1) humans |= 1 << slot;
    let live = 0;
    const slots: (NetState | null)[] = [];
    for (let slot = 0; slot < NET_SLOTS; slot += 1) {
      const entry = slot === mySlot ? undefined : this.remote.get(slot);
      if (entry && now - entry.at < STALE_MS) {
        slots.push(entry.state);
        live |= 1 << slot;
      } else {
        slots.push(null);
      }
    }
    const events = this.pendingEvents.slice(0, NET_IN_EVENT_CAPACITY);
    const delivered = writeNetInbox(words, {
      mode: this.isHost ? NET_MODE_HOST : NET_MODE_CLIENT,
      mySlot,
      humans,
      live,
      match: this.hostMatch,
      seq: this.tick,
      slots,
      events,
    });
    this.pendingEvents.splice(0, delivered);
  }

  /** Relay what the cart published during the tick, and clear its outbox. */
  afterTick(words: Uint32Array): void {
    const out = takeNetOutbox(words);
    this.tick += 1;
    if (!this.connected || this.mySlot < 0) return;
    for (const event of out.events) if (this.outEvents.length < 200) this.outEvents.push(event);
    for (const [slot, state] of out.states) this.outStates.set(slot, state);
    if (this.isHost) this.hostMatch = out.match;
    if (this.tick % STATE_EVERY !== 0) return;
    const message: { s?: [number, number, number, number][]; e?: NetEvent[]; m?: number } = {};
    if (this.outStates.size > 0) message.s = [...this.outStates].map(([slot, w]) => [slot, w[0], w[1], w[2]]);
    if (this.outEvents.length > 0) message.e = this.outEvents.splice(0);
    if (this.isHost) message.m = this.hostMatch;
    this.outStates = new Map();
    if (message.s || message.e || message.m !== undefined) this.transport.send(message);
  }

  private receive(message: NetMessage): void {
    const now = this.now();
    for (const [slot, a, b, c] of message.s ?? []) {
      if (slot >= 0 && slot < NET_SLOTS && slot !== this.mySlot) this.remote.set(slot, { state: [a, b, c], at: now });
    }
    // Cap the backlog: a burst beyond this is stale by the time it would land.
    for (const event of message.e ?? []) if (this.pendingEvents.length < 200) this.pendingEvents.push(event);
    if (message.m !== undefined && !this.isHost) this.hostMatch = message.m;
  }

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }
}

/**
 * An in-process room: every transport created from one hub hears the others.
 * For tests, and for simulating a match between two players on one machine.
 */
export class MemoryNetHub {
  private readonly members = new Map<string, { peer: NetPeer | null; transport: MemoryTransport }>();

  transport(id: string): NetTransport {
    const transport = new MemoryTransport(id, this);
    this.members.set(id, { peer: null, transport });
    return transport;
  }

  /** @internal */
  join(id: string, peer: NetPeer): void {
    const member = this.members.get(id);
    if (member) member.peer = peer;
    this.announce();
  }

  /** @internal */
  leave(id: string): void {
    this.members.delete(id);
    this.announce();
  }

  /** @internal */
  deliver(from: string, message: NetMessage): void {
    // Round-trip through JSON, as a real wire would.
    const wire = JSON.stringify(message);
    for (const [id, member] of this.members) if (id !== from && member.peer) member.transport.receive(JSON.parse(wire), from);
  }

  private announce(): void {
    const peers = [...this.members.values()].flatMap((m) => (m.peer ? [m.peer] : []));
    for (const member of this.members.values()) if (member.peer) member.transport.peers(peers);
  }
}

class MemoryTransport implements NetTransport {
  private messageHandler: ((message: NetMessage, from: string) => void) | null = null;
  private peersHandler: ((peers: readonly NetPeer[]) => void) | null = null;

  constructor(
    readonly selfId: string,
    private readonly hub: MemoryNetHub,
  ) {}

  async connect(joinedAt: number, name?: string): Promise<void> {
    this.hub.join(this.selfId, { id: this.selfId, joinedAt, name });
  }
  send(message: NetMessage): void {
    this.hub.deliver(this.selfId, message);
  }
  onMessage(handler: (message: NetMessage, from: string) => void): void {
    this.messageHandler = handler;
  }
  onPeers(handler: (peers: readonly NetPeer[]) => void): void {
    this.peersHandler = handler;
  }
  close(): void {
    this.hub.leave(this.selfId);
  }
  /** @internal */
  receive(message: NetMessage, from: string): void {
    this.messageHandler?.(message, from);
  }
  /** @internal */
  peers(peers: readonly NetPeer[]): void {
    this.peersHandler?.(peers);
  }
}

/**
 * A room shared by the tabs of one browser (BroadcastChannel), with presence
 * from heartbeats. Handy for trying multiplayer on one machine, and the
 * fallback when no online service is configured.
 */
export class BroadcastChannelTransport implements NetTransport {
  readonly selfId: string;
  private channel: BroadcastChannel | null = null;
  private messageHandler: ((message: NetMessage, from: string) => void) | null = null;
  private peersHandler: ((peers: readonly NetPeer[]) => void) | null = null;
  private readonly seen = new Map<string, { peer: NetPeer; at: number }>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private self: NetPeer | null = null;

  constructor(private readonly room: string) {
    this.selfId = `tab-${Math.random().toString(36).slice(2, 10)}`;
  }

  async connect(joinedAt: number, name?: string): Promise<void> {
    this.self = { id: this.selfId, joinedAt, name };
    this.channel = new BroadcastChannel(`cartbox-net:${this.room}`);
    this.channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { kind: string; from: string; peer?: NetPeer; message?: NetMessage };
      if (data.from === this.selfId) return;
      if (data.kind === "hello" && data.peer) {
        const known = this.seen.has(data.from);
        this.seen.set(data.from, { peer: data.peer, at: Date.now() });
        if (!known) this.publishPeers();
      } else if (data.kind === "bye") {
        this.seen.delete(data.from);
        this.publishPeers();
      } else if (data.kind === "msg" && data.message) {
        this.messageHandler?.(data.message, data.from);
      }
    };
    const hello = () => {
      this.channel?.postMessage({ kind: "hello", from: this.selfId, peer: this.self });
      // Expire peers that stopped saying hello.
      const now = Date.now();
      let changed = false;
      for (const [id, entry] of this.seen) {
        if (now - entry.at > 3500) {
          this.seen.delete(id);
          changed = true;
        }
      }
      if (changed) this.publishPeers();
    };
    hello();
    this.heartbeat = setInterval(hello, 1000);
    this.publishPeers();
  }

  send(message: NetMessage): void {
    this.channel?.postMessage({ kind: "msg", from: this.selfId, message });
  }
  onMessage(handler: (message: NetMessage, from: string) => void): void {
    this.messageHandler = handler;
  }
  onPeers(handler: (peers: readonly NetPeer[]) => void): void {
    this.peersHandler = handler;
  }
  close(): void {
    this.channel?.postMessage({ kind: "bye", from: this.selfId });
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.channel?.close();
    this.channel = null;
  }

  private publishPeers(): void {
    const peers = [...this.seen.values()].map((entry) => entry.peer);
    if (this.self) peers.push(this.self);
    this.peersHandler?.(peers);
  }
}
