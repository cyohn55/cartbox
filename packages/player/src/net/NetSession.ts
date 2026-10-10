/**
 * The host-page side of netplay: joins a room over a {@link NetTransport},
 * assigns player slots, and relays the cart's published state and events to the
 * other players — and theirs into this cart. See netplay.ts for the pmem layout.
 *
 * Slots are the host's to give (LOCKOUT_MULTIPLAYER_ROADMAP.md L8), and they
 * stick: the host keeps a roster of who holds which, sends it round, and a
 * player keeps its slot however many leave or join around it — and gets it
 * back if it drops and rejoins within a minute. A newcomer takes the lowest
 * free slot. The host is whoever present holds the lowest slot, so when the
 * host leaves the next in line takes over, roster and all. (A brand-new room,
 * before any roster, goes by join order — every browser agrees on that.) Everything is sent in one message every
 * few ticks (30 Hz over direct links, 7.5–15 Hz over the relay): the latest state
 * (a snapshot — a lost one is replaced by the next), every event raised since
 * (a hit, a kill), and the host's match word.
 *
 * Snapshots are stamped on a clock the room shares (LOCKOUT_MULTIPLAYER_ROADMAP.md
 * L4): the host's, which every other player estimates by pinging it, NTP-style.
 * The cart gets that clock and each slot's newest snapshot with its stamp, so it
 * can draw the others a little in the past, between real snapshots.
 */

import {
  NET_IN_EVENT_CAPACITY,
  NET_MODE_CLIENT,
  NET_MODE_HOST,
  NET_SLOTS,
  netLagUnits,
  takeNetOutbox,
  writeNetInbox,
  type NetEvent,
  type NetState,
} from "./netplay.js";
import { encodeNetMessage } from "./netCodec.js";

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
  readonly s?: readonly (readonly [number, number, number, number, number])[];
  readonly e?: readonly NetEvent[];
  readonly m?: number;
  /** When the message was sent — its states taken, its events raised by then — on the room's shared clock (ms, wrapping at 2^32). */
  readonly t?: number;
  /** A ping to the host: the sender's own clock (ms, wrapping at 2^32). */
  readonly pi?: number;
  /** The host's answers: [slot, its ping, when the host heard it, when it answered] (the last two on the shared clock). */
  readonly po?: readonly (readonly [number, number, number, number])[];
  /** Transport-level: the peers a relayed copy is for (the rest have it directly); absent for everyone. */
  readonly r?: readonly string[];
  /** The host's roster (L8): [slot, peer id] for everyone in the room. */
  readonly ro?: readonly (readonly [number, string])[];
  /** Transport-level: a WebRTC handshake message for one peer (see DirectTransport). Never reaches a session. */
  readonly sig?: NetSignal;
}

/** A WebRTC handshake message, relayed to one peer. */
export interface NetSignal {
  readonly to: string;
  readonly description?: { readonly type: string; readonly sdp?: string };
  readonly candidate?: unknown;
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
  /** Ticks between messages for a room of `players`, when the transport can carry more than {@link netSendInterval}'s rate. */
  sendInterval?(players: number): number;
}

/** The session's view of the room, for a lobby UI. */
export interface NetRoomStatus {
  readonly connected: boolean;
  readonly peers: readonly NetPeer[];
  readonly mySlot: number;
  readonly isHost: boolean;
}

/**
 * Ticks between messages, by room size: 15 Hz for two players, 10 Hz up to
 * four, 7.5 Hz beyond. A room's traffic grows with players × listeners, so the
 * per-player rate falls as the room fills to keep the total inside a hosted
 * broadcast service's message budget; clients interpolate between snapshots.
 */
export function netSendInterval(players: number): number {
  return players <= 2 ? 4 : players <= 4 ? 6 : 8;
}
/** An unchanged player still says it's there this often (ticks), well inside STALE_MS. */
const KEEPALIVE_TICKS = 60;
/** Remote state older than this is treated as gone (the peer dropped). */
const STALE_MS = 3000;
/** A guest pings the host this often (ticks) — faster for its first few answers, to settle the clock quickly. */
const PING_TICKS = 30;
const PING_TICKS_EARLY = 6;
const EARLY_PINGS = 5;
/** Answers kept for the clock estimate: the one that crossed fastest wins. */
const CLOCK_SAMPLES = 8;
/** The view lag follows a snapshot older than it halfway at once, and eases back down this much a snapshot (ms). */
const LAG_RISE = 0.5;
const LAG_FALL = 0.5;

/** How long a dropped player's slot is held for it to come back to (ms). */
const REJOIN_MS = 60_000;
/** The host repeats its roster this often (ticks), for anyone who missed it. */
const ROSTER_TICKS = 60;

/** Two times on a 32-bit wrapping clock, b − a, wrap-safe (|b − a| < 2^31 ms). */
function since(a: number, b: number): number {
  return ((b - a) | 0);
}

/** The full shared time `stamp` (ms mod 2^32) means, near `clock` (full). */
function unwrap(stamp: number, clock: number): number {
  return clock + since(clock >>> 0, stamp >>> 0);
}

export class NetSession {
  private peers: readonly NetPeer[] = [];
  private connected = false;
  private readonly joinedAt = Date.now();
  private readonly remote = new Map<number, { state: NetState; stamp: number; at: number }>();
  /** This player's clock minus the host's (ms): shared time = now() + offset. */
  private offset = 0;
  private readonly clockSamples: { offset: number; delay: number }[] = [];
  private pingsAnswered = 0;
  private lastPingTick = -Infinity;
  /** Pings heard (as host), to answer in the next message: [slot, their ping, when heard]. */
  private readonly pongsDue: [number, number, number][] = [];
  /** How old the others' snapshots are when they arrive (ms): the slowest link's, smoothed. */
  private viewLag = 0;
  /** The view lag the last inbox carried (ms, as the cart read it). */
  private viewLagWritten = 0;
  private readonly pendingEvents: { event: NetEvent; from: number }[] = [];
  private hostMatch = 0;
  private statusCode = 0;
  private tick = 0;
  private readonly outEvents: NetEvent[] = [];
  private outStates = new Map<number, NetState>();
  /** What the last message carried (states + match), and when — to skip repeats. */
  private lastSent = "";
  private lastSentTick = -Infinity;
  private readonly listeners = new Set<(status: NetRoomStatus) => void>();
  /** Bytes sent and received so far, in the messages' binary form (for the profiler). */
  private sentBytes = 0;
  private receivedBytes = 0;
  /** Who holds which slot (peer id → slot), as the host has it (L8). */
  private roster = new Map<string, number>();
  /** Slots held for players who dropped, until they're back or REJOIN_MS is up. */
  private readonly held = new Map<string, { slot: number; until: number }>();
  /** The roster changed (as host): send it in the next message. */
  private rosterDirty = false;
  private lastRosterTick = -Infinity;

  constructor(
    private readonly transport: NetTransport,
    private readonly now: () => number = () => Date.now(),
  ) {
    transport.onPeers((peers) => {
      this.peers = [...peers].sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      // Out of the room (or into another): its roster goes with it.
      if (this.peers.length === 0) {
        this.roster.clear();
        this.held.clear();
      }
      this.reslot();
      this.emit();
    });
    transport.onMessage((message, from) => this.receive(message, from));
  }

  /** Bytes this session has sent and received, measured in the messages' binary form (netCodec.ts). */
  traffic(): { sent: number; received: number } {
    return { sent: this.sentBytes, received: this.receivedBytes };
  }

  /** The room's shared clock, ms: the host's own clock, as this player estimates it. */
  sharedNow(): number {
    return this.now() + this.offset;
  }

  /** The view lag the cart was last given (ms): how far behind the shared clock the newest snapshots are. */
  viewLagMs(): number {
    return this.viewLagWritten;
  }

  /** The clock estimate: offset to the host's clock, and the round trip of the ping it came from (0 before any answer). */
  clockSync(): { offset: number; rtt: number; samples: number } {
    const best = this.bestSample();
    return { offset: this.offset, rtt: best?.delay ?? 0, samples: this.clockSamples.length };
  }

  /** Forget the current room's state (remote players, queued events, the host's
   *  match word) — for moving to another room without carrying anything over. */
  resetRoom(): void {
    this.remote.clear();
    this.clockSamples.length = 0;
    this.pongsDue.length = 0;
    this.pingsAnswered = 0;
    this.lastPingTick = -Infinity;
    this.viewLag = 0;
    this.pendingEvents.length = 0;
    this.outEvents.length = 0;
    this.outStates = new Map();
    this.hostMatch = 0;
    this.lastSent = "";
    this.roster.clear();
    this.held.clear();
    this.reslot();
  }

  /** A status for the cart (0..7, read as net()'s fifth value) — e.g. matchmaking progress. */
  setStatus(code: number): void {
    this.statusCode = code & 7;
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
    return this.slotOf(this.transport.selfId);
  }

  /** The host's slot: the lowest held by anyone present (-1 in an empty room). */
  get hostSlot(): number {
    let lowest = -1;
    for (const peer of this.peers) {
      const slot = this.roster.get(peer.id);
      if (slot !== undefined && (lowest < 0 || slot < lowest)) lowest = slot;
    }
    return lowest;
  }

  get isHost(): boolean {
    return this.mySlot >= 0 && this.mySlot === this.hostSlot;
  }

  /** A peer's slot, by the roster (-1 when it has none yet). */
  slotOf(id: string): number {
    return this.roster.get(id) ?? -1;
  }

  /** Who holds which slot, as this browser has it. */
  slots(): ReadonlyMap<string, number> {
    return this.roster;
  }

  /**
   * Bring the roster up to date with who is here. In a new room (no roster
   * yet) slots go by join order. After that only the host changes it: a
   * player who left has its slot held for REJOIN_MS; a newcomer gets its old
   * slot back if it's held for it, or the lowest free one.
   */
  private reslot(): void {
    if (this.roster.size === 0) {
      this.peers.slice(0, NET_SLOTS).forEach((peer, slot) => this.roster.set(peer.id, slot));
      this.rosterDirty = true;
      return;
    }
    if (!this.isHost) return;
    const now = this.now();
    const present = new Set(this.peers.map((p) => p.id));
    let changed = false;
    for (const [id, slot] of [...this.roster]) {
      if (present.has(id)) continue;
      this.roster.delete(id);
      this.held.set(id, { slot, until: now + REJOIN_MS });
      changed = true;
    }
    for (const [id, hold] of [...this.held]) if (hold.until < now) this.held.delete(id);
    for (const peer of this.peers) {
      if (this.roster.has(peer.id)) continue;
      const taken = new Set(this.roster.values());
      const back = this.held.get(peer.id);
      let slot = back && !taken.has(back.slot) ? back.slot : -1;
      if (slot < 0) {
        const kept = new Set([...this.held.values()].map((h) => h.slot));
        for (let s = 0; s < NET_SLOTS && slot < 0; s += 1) if (!taken.has(s) && !kept.has(s)) slot = s;
      }
      if (slot < 0) continue; // the room is full
      this.roster.set(peer.id, slot);
      this.held.delete(peer.id);
      changed = true;
    }
    if (changed) this.rosterDirty = true;
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
      writeNetInbox(words, { mode: 0, mySlot: 0, status: this.statusCode, humans: 0, live: 0, match: 0, clock: Math.floor(this.sharedNow()), slots: [], events: [] });
      return;
    }
    const now = this.now();
    let humans = 0;
    for (const peer of this.peers) {
      const slot = this.slotOf(peer.id);
      if (slot >= 0) humans |= 1 << slot;
    }
    let live = 0;
    const slots: (NetState | null)[] = [];
    const stamps: number[] = [];
    for (let slot = 0; slot < NET_SLOTS; slot += 1) {
      // (a player's own slot too: under a host that moves everyone, L7, the
      // host's word on it is what a guest reconciles its prediction with)
      const entry = this.remote.get(slot);
      if (entry && now - entry.at < STALE_MS) {
        slots.push(entry.state);
        stamps.push(entry.stamp);
        live |= 1 << slot;
      } else {
        slots.push(null);
        stamps.push(0);
      }
    }
    const pending = this.pendingEvents.slice(0, NET_IN_EVENT_CAPACITY);
    this.viewLagWritten = netLagUnits(this.viewLag) * 4;
    const delivered = writeNetInbox(words, {
      mode: this.isHost ? NET_MODE_HOST : NET_MODE_CLIENT,
      status: this.statusCode,
      mySlot,
      humans,
      live,
      match: this.hostMatch,
      hostSlot: this.hostSlot,
      clock: Math.floor(this.sharedNow()),
      lag: this.viewLag,
      slots,
      stamps,
      events: pending.map((p) => p.event),
      senders: pending.map((p) => p.from),
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
    const interval = this.transport.sendInterval?.(this.peers.length) ?? netSendInterval(this.peers.length);
    if (this.tick % interval !== 0) return;
    const message: {
      s?: [number, number, number, number, number][];
      e?: NetEvent[];
      m?: number;
      t?: number;
      pi?: number;
      po?: [number, number, number, number][];
      ro?: [number, string][];
    } = {};
    if (this.outStates.size > 0) message.s = [...this.outStates].map(([slot, w]) => [slot, w[0], w[1], w[2], w[3]]);
    if (this.isHost) message.m = this.hostMatch;
    this.outStates = new Map();
    // A guest keeps its clock on the host's: a ping now and then, quicker at first.
    const pingEvery = this.pingsAnswered < EARLY_PINGS ? PING_TICKS_EARLY : PING_TICKS;
    const ping = !this.isHost && this.peers.length > 1 && this.tick - this.lastPingTick >= pingEvery;
    // Nothing new (standing still, waiting in the lobby): stay quiet, bar a
    // keepalive so the others don't time this player out.
    const signature = JSON.stringify([message.s ?? null, message.m ?? null]);
    // As host, the roster when it changes, and now and then for anyone who missed it (L8).
    const roster = this.isHost && (this.rosterDirty || this.tick - this.lastRosterTick >= ROSTER_TICKS);
    if (roster) {
      message.ro = [...this.roster].map(([id, slot]) => [slot, id]);
      this.rosterDirty = false;
      this.lastRosterTick = this.tick;
    }
    const quiet = this.outEvents.length === 0 && this.pongsDue.length === 0 && !ping && !roster;
    if (quiet && signature === this.lastSent && this.tick - this.lastSentTick < KEEPALIVE_TICKS) return;
    if (this.outEvents.length > 0) message.e = this.outEvents.splice(0);
    const shared = Math.floor(this.sharedNow());
    message.t = shared >>> 0;
    if (ping) {
      message.pi = Math.floor(this.now()) >>> 0;
      this.lastPingTick = this.tick;
    }
    if (this.pongsDue.length > 0) message.po = this.pongsDue.splice(0).map(([slot, t0, t1]) => [slot, t0, t1, shared >>> 0]);
    if (message.s || message.e || message.m !== undefined || message.pi !== undefined || message.po || message.ro) {
      this.transport.send(message);
      this.sentBytes += encodeNetMessage(message).length;
      this.lastSent = signature;
      this.lastSentTick = this.tick;
    }
  }

  private receive(message: NetMessage, from?: string): void {
    this.receivedBytes += encodeNetMessage(message).length;
    const now = this.now();
    const mySlot = this.mySlot;
    // A message without a time (from an older build) counts as taken on arrival.
    const stamp = message.t !== undefined ? unwrap(message.t, this.sharedNow()) : this.sharedNow();
    if (message.s && message.t !== undefined) {
      const age = Math.max(0, this.sharedNow() - stamp);
      this.viewLag = age > this.viewLag ? this.viewLag + (age - this.viewLag) * LAG_RISE : Math.max(age, this.viewLag - LAG_FALL);
    }
    for (const [slot, a, b, c, d] of message.s ?? []) {
      if (slot < 0 || slot >= NET_SLOTS) continue;
      // Snapshots overtaken on the way (jitter) are dropped: the newest stands.
      const held = this.remote.get(slot);
      if (held && now - held.at < STALE_MS && stamp < held.stamp) continue;
      this.remote.set(slot, { state: [a, b, c, d ?? 0], stamp, at: now });
    }
    // Cap the backlog: a burst beyond this is stale by the time it would land.
    // The host's roster (L8): taken from whoever it says is host — the present
    // player it puts in the lowest slot — so a newcomer and a new host agree.
    if (message.ro && from !== undefined) this.adoptRoster(message.ro, from);
    const sender = from === undefined ? -1 : this.slotOf(from);
    for (const event of message.e ?? []) if (this.pendingEvents.length < 200 && sender >= 0 && sender < NET_SLOTS) this.pendingEvents.push({ event, from: sender });
    if (message.m !== undefined && !this.isHost) this.hostMatch = message.m;
    // The clock: answer a guest's ping (as host), or take the host's answer to ours.
    if (message.pi !== undefined && this.isHost) {
      const slot = from === undefined ? -1 : this.slotOf(from);
      if (slot > 0 && slot < NET_SLOTS && this.pongsDue.length < NET_SLOTS) this.pongsDue.push([slot, message.pi, Math.floor(this.sharedNow()) >>> 0]);
    }
    for (const [slot, t0, t1, t2] of message.po ?? []) {
      if (slot !== mySlot || this.isHost) continue;
      this.clockAnswer(t0, t1, t2, Math.floor(now));
    }
  }

  private adoptRoster(entries: readonly (readonly [number, string])[], from: string): void {
    const next = new Map(entries.map(([slot, id]) => [id, slot] as const));
    const present = new Set(this.peers.map((p) => p.id));
    let lowest = Infinity;
    for (const [id, slot] of next) if (present.has(id) && slot < lowest) lowest = slot;
    if (next.get(from) !== lowest) return;
    this.roster = next;
    for (const id of next.keys()) this.held.delete(id);
    this.emit();
  }

  /** NTP's estimate from one answered ping: t0 sent and t3 back on our clock, t1 heard and t2 answered on the host's. */
  private clockAnswer(t0: number, t1: number, t2: number, t3: number): void {
    const delay = since(t0, t3 >>> 0) - since(t1, t2);
    if (delay < 0) return;
    const offset = (since(t0, t1) + since(t3 >>> 0, t2)) / 2;
    this.clockSamples.push({ offset, delay });
    if (this.clockSamples.length > CLOCK_SAMPLES) this.clockSamples.shift();
    this.pingsAnswered += 1;
    // The fastest round trip has the least room for asymmetry: trust it.
    this.offset = this.bestSample()!.offset;
  }

  private bestSample(): { offset: number; delay: number } | undefined {
    let best: { offset: number; delay: number } | undefined;
    for (const sample of this.clockSamples) if (!best || sample.delay < best.delay) best = sample;
    return best;
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

/**
 * A transport that can be pointed at a different room (or none) while the
 * session using it keeps running — how a game moves from its title screen into
 * a matchmade room, and back out. With no room it reports no peers, so the
 * session plays offline. Each room is joined with a fresh join time, so slot
 * order in the new room is by when you arrived *there*.
 */
export class SwitchableTransport implements NetTransport {
  private inner: NetTransport | null = null;
  private readonly idle = `idle-${Math.random().toString(36).slice(2, 10)}`;
  private name: string | undefined;
  private messageHandler: ((message: NetMessage, from: string) => void) | null = null;
  private peersHandler: ((peers: readonly NetPeer[]) => void) | null = null;

  get selfId(): string {
    return this.inner?.selfId ?? this.idle;
  }

  /** The room transport in use, or null. */
  get current(): NetTransport | null {
    return this.inner;
  }

  async connect(_joinedAt: number, name?: string): Promise<void> {
    this.name = name;
    this.peersHandler?.([]);
  }

  /** Leave the current room (if any) and join `next` (or stay out when null). */
  async use(next: NetTransport | null): Promise<void> {
    const previous = this.inner;
    this.inner = null;
    previous?.close();
    this.peersHandler?.([]);
    if (!next) return;
    this.inner = next;
    next.onMessage((message, from) => {
      if (this.inner === next) this.messageHandler?.(message, from);
    });
    next.onPeers((peers) => {
      if (this.inner === next) this.peersHandler?.(peers);
    });
    await next.connect(Date.now(), this.name);
  }

  send(message: NetMessage): void {
    this.inner?.send(message);
  }
  sendInterval(players: number): number {
    return this.inner?.sendInterval?.(players) ?? netSendInterval(players);
  }
  onMessage(handler: (message: NetMessage, from: string) => void): void {
    this.messageHandler = handler;
  }
  onPeers(handler: (peers: readonly NetPeer[]) => void): void {
    this.peersHandler = handler;
  }
  close(): void {
    void this.use(null);
  }
}
