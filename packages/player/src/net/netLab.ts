/**
 * A network lab (LOCKOUT_MULTIPLAYER_ROADMAP.md L2): a simulated network for
 * NetSessions — latency, jitter, loss, reordering and an uplink bandwidth cap
 * on a virtual clock — and a harness that runs several real carts in one room
 * over it, measuring each client's traffic and how far each client's view of
 * every player drifts from where that player's owner has it.
 *
 * Deterministic: a seeded random stream decides jitter and loss, and the
 * clock only moves when the harness advances it.
 */

import { encodeNetMessage } from "./netCodec.js";
import { NET_WORDS, takeNetOutbox, type NetState } from "./netplay.js";
import { NetSession, netSendInterval, type NetMessage, type NetPeer, type NetTransport } from "./NetSession.js";

/** How a link behaves. */
export interface LinkConditions {
  /** One-way delay, ms. */
  readonly latencyMs: number;
  /** Extra one-way delay, uniform in [0, jitterMs): messages can overtake each other. */
  readonly jitterMs?: number;
  /** Chance a message is lost, 0..1. */
  readonly loss?: number;
  /** The sender's uplink, bytes per second; a message waits for the ones before it to leave. Unlimited when absent. */
  readonly bandwidth?: number;
  /** Peers connect directly (L3: WebRTC data channels): sessions send at 30 Hz instead of the relay's rate. */
  readonly direct?: boolean;
}

/** A small seeded PRNG (mulberry32): the lab's only source of chance. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface InFlight {
  readonly at: number;
  readonly order: number;
  readonly to: string;
  readonly from: string;
  readonly wire: string;
}

/**
 * An in-process room over a simulated network. Every message is serialised
 * (as a real wire would), then each listener gets its own copy after the
 * sender's link delay — or never, if the link loses it. Presence is instant.
 */
export class SimulatedNetHub {
  private clock = 0;
  private order = 0;
  private readonly rand: () => number;
  private readonly members = new Map<string, { peer: NetPeer | null; transport: SimulatedTransport; link: LinkConditions; busyUntil: number }>();
  private queue: InFlight[] = [];
  /** Messages sent, delivered and lost so far. */
  readonly counts = { sent: 0, delivered: 0, lost: 0 };

  constructor(
    private readonly conditions: LinkConditions,
    seed = 1,
  ) {
    this.rand = random(seed);
  }

  /** The virtual time, ms. */
  now = (): number => this.clock;

  /** A transport for peer `id`; its uplink has the hub's conditions unless `link` overrides them. */
  transport(id: string, link: LinkConditions = this.conditions): NetTransport {
    const transport = new SimulatedTransport(id, this, link.direct === true);
    this.members.set(id, { peer: null, transport, link, busyUntil: 0 });
    return transport;
  }

  /** Move the clock on by `ms`, delivering every message due by then in arrival order, each at its arrival time. */
  advance(ms: number): void {
    const end = this.clock + ms;
    const due = this.queue.filter((m) => m.at <= end).sort((a, b) => a.at - b.at || a.order - b.order);
    this.queue = this.queue.filter((m) => m.at > end);
    for (const m of due) {
      const member = this.members.get(m.to);
      if (!member?.peer) continue;
      this.clock = Math.max(this.clock, m.at);
      this.counts.delivered += 1;
      member.transport.receive(JSON.parse(m.wire), m.from);
    }
    this.clock = end;
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
    this.queue = this.queue.filter((m) => m.to !== id);
    this.announce();
  }

  /** @internal */
  send(from: string, message: NetMessage): void {
    const sender = this.members.get(from);
    if (!sender) return;
    const wire = JSON.stringify(message);
    this.counts.sent += 1;
    const { link } = sender;
    // The uplink: one copy leaves after whatever is still queued ahead of it (its size as it travels: packed binary).
    const bytes = encodeNetMessage(message).length;
    const leaves = link.bandwidth ? Math.max(this.clock, sender.busyUntil) + (bytes / link.bandwidth) * 1000 : this.clock;
    sender.busyUntil = leaves;
    for (const [id, member] of this.members) {
      if (id === from || !member.peer) continue;
      if (link.loss && this.rand() < link.loss) {
        this.counts.lost += 1;
        continue;
      }
      const at = leaves + link.latencyMs + (link.jitterMs ? this.rand() * link.jitterMs : 0);
      this.queue.push({ at, order: this.order++, to: id, from, wire });
    }
  }

  private announce(): void {
    const peers = [...this.members.values()].flatMap((m) => (m.peer ? [m.peer] : []));
    for (const member of this.members.values()) if (member.peer) member.transport.peers(peers);
  }
}

class SimulatedTransport implements NetTransport {
  private messageHandler: ((message: NetMessage, from: string) => void) | null = null;
  private peersHandler: ((peers: readonly NetPeer[]) => void) | null = null;

  constructor(
    readonly selfId: string,
    private readonly hub: SimulatedNetHub,
    private readonly direct: boolean,
  ) {}

  async connect(joinedAt: number, name?: string): Promise<void> {
    this.hub.join(this.selfId, { id: this.selfId, joinedAt, name });
  }
  send(message: NetMessage): void {
    this.hub.send(this.selfId, message);
  }
  sendInterval(players: number): number {
    return this.direct ? 2 : netSendInterval(players);
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

// --- The harness -------------------------------------------------------------

/** One running cart, as the lab drives it. */
export interface LabCart {
  /** A live view of the cart's net words (pmem 0..118). */
  net(): Uint32Array;
  /** Run one tick with these buttons held. */
  tick(buttons: number): void;
  /** The cart's mailbox words after the tick. */
  mailbox(): Uint32Array;
}

type Point = readonly [number, number, number];

/** How the lab reads a game: where a player is, as its owner and as others see it. */
export interface LabProbe {
  /** Where a slot is by the state its owner published (null when there's nothing to compare: dead, absent). */
  owned(state: NetState): Point | null;
  /** Where `observer` (in `observerSlot`) draws slot `slot` this tick, from its mailbox (null when not drawn). */
  seen(mailbox: Uint32Array, observerSlot: number, slot: number): Point | null;
}

export interface NetLabOptions {
  readonly players: number;
  readonly conditions: LinkConditions;
  /** Ticks of play to measure (60 a second), after `warmup`. */
  readonly ticks: number;
  /** Ticks before measuring: the room forms and the host starts the match. */
  readonly warmup: number;
  readonly seed?: number;
  /** A fresh cart for a player. */
  readonly cart: () => Promise<LabCart>;
  /** The buttons player `index` holds on tick `tick` (warmup ticks count from 0). */
  readonly input: (index: number, tick: number) => number;
  readonly probe: LabProbe;
}

/** Distances between where an owner has a player and where an observer draws it, in metres. */
export interface DriftStats {
  readonly samples: number;
  readonly mean: number;
  readonly p95: number;
  readonly max: number;
}

export interface NetLabReport {
  readonly conditions: LinkConditions;
  readonly players: number;
  readonly seconds: number;
  /** Bytes per second each client sent and received (as the messages' JSON). */
  readonly bytesPerSecond: readonly { readonly sent: number; readonly received: number }[];
  /** Drift of players other humans control, and of everything a host simulates (bots). */
  readonly humans: DriftStats;
  readonly all: DriftStats;
  readonly messages: { readonly sent: number; readonly delivered: number; readonly lost: number };
}

function stats(values: number[]): DriftStats {
  if (values.length === 0) return { samples: 0, mean: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return { samples: values.length, mean, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!, max: sorted.at(-1)! };
}

/** Round a report's numbers (to the millimetre and the byte) so two runs compare exactly. */
function round(report: NetLabReport): NetLabReport {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const s = (d: DriftStats): DriftStats => ({ samples: d.samples, mean: r(d.mean), p95: r(d.p95), max: r(d.max) });
  return {
    ...report,
    bytesPerSecond: report.bytesPerSecond.map((b) => ({ sent: Math.round(b.sent), received: Math.round(b.received) })),
    humans: s(report.humans),
    all: s(report.all),
  };
}

/**
 * Run `players` carts in one room over a simulated network: warm up (the room
 * forms, the host starts), then play `ticks` ticks, comparing every tick where
 * each slot's owner has it with where every other client draws it.
 */
export async function runNetLab(options: NetLabOptions): Promise<NetLabReport> {
  const hub = new SimulatedNetHub(options.conditions, options.seed ?? 1);
  const sessions: NetSession[] = [];
  const carts: LabCart[] = [];
  for (let i = 0; i < options.players; i += 1) {
    const session = new NetSession(hub.transport(`p${i}`), hub.now);
    await session.connect(`Player ${i + 1}`);
    sessions.push(session);
    carts.push(await options.cart());
  }
  const owned = new Map<number, { at: Point | null; owner: number }>();
  const humanDrift: number[] = [];
  const allDrift: number[] = [];
  const startTraffic = sessions.map(() => ({ sent: 0, received: 0 }));
  const total = options.warmup + options.ticks;
  for (let t = 0; t < total; t += 1) {
    if (t === options.warmup) sessions.forEach((s, i) => (startTraffic[i] = s.traffic()));
    for (let i = 0; i < carts.length; i += 1) {
      const cart = carts[i]!;
      const session = sessions[i]!;
      session.beforeTick(cart.net());
      cart.tick(options.input(i, t));
      // What this player owns, read from the outbox before the session takes it.
      const peek = takeNetOutbox(new Uint32Array(cart.net().slice(0, NET_WORDS)));
      for (const [slot, state] of peek.states) owned.set(slot, { at: options.probe.owned(state), owner: i });
      session.afterTick(cart.net());
    }
    if (t >= options.warmup) {
      for (let i = 0; i < carts.length; i += 1) {
        const mySlot = sessions[i]!.mySlot;
        const mailbox = carts[i]!.mailbox();
        for (const [slot, { at, owner }] of owned) {
          if (owner === i || !at) continue;
          const seen = options.probe.seen(mailbox, mySlot, slot);
          if (!seen) continue;
          const d = Math.hypot(seen[0] - at[0], seen[1] - at[1], seen[2] - at[2]);
          allDrift.push(d);
          if (slot < options.players) humanDrift.push(d);
        }
      }
    }
    hub.advance(1000 / 60);
  }
  const seconds = options.ticks / 60;
  return round({
    conditions: options.conditions,
    players: options.players,
    seconds,
    bytesPerSecond: sessions.map((s, i) => {
      const now = s.traffic();
      return { sent: (now.sent - startTraffic[i]!.sent) / seconds, received: (now.received - startTraffic[i]!.received) / seconds };
    }),
    humans: stats(humanDrift),
    all: stats(allDrift),
    messages: { ...hub.counts },
  });
}
