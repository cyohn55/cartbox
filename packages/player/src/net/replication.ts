/**
 * Entity replication (AAA_PRODUCTION_ROADMAP.md N1): any object marked
 * replicated has its pose sent by the host to every other player, beyond the 4
 * words a player publishes, with priority, relevancy by distance and delta
 * compression. Pure and transport-free: the session carries its bytes.
 *
 * - **What's sent:** an entity's position (1/256 m) and rotation (a unit
 *   quaternion, 1/16384), quantized, so both ends compare the same integers.
 * - **Priority and relevancy:** each send, every entity's score grows by its
 *   priority times how near it is to a viewer (any player's camera: 1 within
 *   `near`, falling to 0 at `far`, never sent beyond). The highest scores go
 *   first, until the packet's byte budget is spent; a sent entity's score
 *   resets. So a busy scene sends what matters, and the rest catches up.
 * - **Delta compression:** each client acks the packets it got (the newest and
 *   a bit for each of the 32 before). For each entity the host finds the newest
 *   packet that carried it and that every client got, and sends only the fields
 *   that changed since, with how many packets back that was. An entity
 *   unchanged since then isn't sent at all. With no such packet, it's sent
 *   whole. Loss costs size, never correctness.
 */

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export interface EntityPose {
  readonly id: number;
  readonly position: Vec3;
  readonly rotation: Quat;
  /** How much it matters (default 1). */
  readonly priority?: number;
}

/** Fields of a quantized pose: px, py, pz, qx, qy, qz, qw. */
type Q = readonly number[];

const POS = 256;
const ROT = 16384;
const HISTORY = 33;
const FIELDS = 7;

export interface ReplicationOptions {
  /** Metres within which an entity is fully relevant, and beyond which it isn't sent. */
  readonly near?: number;
  readonly far?: number;
  /** Bytes a host packet may hold. */
  readonly budget?: number;
}

function quantize(p: EntityPose): number[] {
  const q = p.rotation;
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  // One hemisphere, so a quaternion and its negation quantize alike.
  const s = q[3] < 0 ? -1 / len : 1 / len;
  return [...p.position.map((v) => Math.round(v * POS)), ...q.map((v) => Math.round(v * s * ROT))];
}

function dequantize(id: number, q: Q): EntityPose {
  return { id, position: [q[0]! / POS, q[1]! / POS, q[2]! / POS], rotation: [q[3]! / ROT, q[4]! / ROT, q[5]! / ROT, q[6]! / ROT] };
}

class Writer {
  private bytes = new Uint8Array(256);
  private view = new DataView(this.bytes.buffer);
  at = 0;
  private grow(n: number) {
    if (this.at + n <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.at + n));
    next.set(this.bytes);
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number) {
    this.grow(1);
    this.bytes[this.at++] = v & 0xff;
  }
  u16(v: number) {
    this.grow(2);
    this.view.setUint16(this.at, v, true);
    this.at += 2;
  }
  u32(v: number) {
    this.grow(4);
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
  }
  i32(v: number) {
    this.grow(4);
    this.view.setInt32(this.at, v | 0, true);
    this.at += 4;
  }
  done() {
    return this.bytes.slice(0, this.at);
  }
}

class Reader {
  private readonly view: DataView;
  at = 0;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get left() {
    return this.bytes.length - this.at;
  }
  u8() {
    return this.bytes[this.at++]!;
  }
  u16() {
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }
  i32() {
    const v = this.view.getInt32(this.at, true);
    this.at += 4;
    return v;
  }
}

const HOST = 1;
const CLIENT = 2;

/** The host's half: what to send each tick. */
export class ReplicationHost {
  private seq = 0;
  /** Each packet's entities and the values they were sent at. */
  private readonly history = new Map<number, Map<number, Q>>();
  /** Each client's acks: its newest packet and the 32 before it, as a set of seqs. */
  private readonly acks = new Map<string, Set<number>>();
  private readonly score = new Map<number, number>();
  private readonly near: number;
  private readonly far: number;
  private readonly budget: number;
  /** Entities sent in the last packet (tests and the profiler). */
  lastSent = 0;

  constructor(options: ReplicationOptions = {}) {
    this.near = options.near ?? 20;
    this.far = Math.max(this.near + 1e-6, options.far ?? 120);
    this.budget = options.budget ?? 1200;
  }

  /** A client's ack packet (and where its camera is). */
  receive(client: string, bytes: Uint8Array): Vec3 | null {
    const r = new Reader(bytes);
    if (r.left < 21 || r.u8() !== CLIENT) return null;
    const newest = r.u32();
    const bits = r.u32();
    const got = new Set<number>([newest]);
    for (let k = 0; k < 32; k += 1) if (bits & (1 << k)) got.add(newest - 1 - k);
    this.acks.set(client, got);
    return [r.i32() / POS, r.i32() / POS, r.i32() / POS];
  }

  /** A client gone: its acks no longer hold baselines back. */
  forget(client: string): void {
    this.acks.delete(client);
  }

  /** How relevant a position is to the nearest viewer, 0..1. */
  private relevance(at: Vec3, viewers: readonly Vec3[]): number {
    if (viewers.length === 0) return 1;
    let best = 0;
    for (const v of viewers) {
      const d = Math.hypot(at[0] - v[0], at[1] - v[1], at[2] - v[2]);
      best = Math.max(best, d <= this.near ? 1 : d >= this.far ? 0 : 1 - (d - this.near) / (this.far - this.near));
    }
    return best;
  }

  /** The newest packet carrying `id` that every client got, and its value. */
  private baseline(id: number): { seq: number; value: Q } | null {
    if (this.acks.size === 0) return null;
    for (let s = this.seq - 1; s >= this.seq - HISTORY && s > 0; s -= 1) {
      const value = this.history.get(s)?.get(id);
      if (!value) continue;
      let all = true;
      for (const got of this.acks.values()) if (!got.has(s)) all = false;
      if (all) return { seq: s, value };
    }
    return null;
  }

  /** This tick's packet: the entities that matter most, as deltas where it can, within the budget. */
  send(entities: readonly EntityPose[], viewers: readonly Vec3[]): Uint8Array {
    this.seq += 1;
    const seq = this.seq;
    const w = new Writer();
    w.u8(HOST);
    w.u32(seq);
    const countAt = w.at;
    w.u16(0);
    const sent = new Map<number, Q>();
    // Score everything, then go down the list.
    const ranked = entities
      .map((e) => {
        const relevance = this.relevance(e.position, viewers);
        const score = relevance > 0 ? (this.score.get(e.id) ?? 0) + (e.priority ?? 1) * relevance : 0;
        this.score.set(e.id, score);
        return { e, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.e.id - b.e.id);
    let count = 0;
    for (const { e } of ranked) {
      const q = quantize(e);
      const base = this.baseline(e.id);
      let mask = 0;
      for (let f = 0; f < FIELDS; f += 1) if (!base || base.value[f] !== q[f]) mask |= 1 << f;
      if (base && mask === 0) {
        // Unchanged since what everyone has: nothing to send (and not recorded as sent: no client has it in this packet).
        this.score.set(e.id, 0);
        continue;
      }
      const size = 2 + 1 + 1 + 4 * popcount(mask);
      if (w.at + size > this.budget) continue;
      w.u16(e.id);
      w.u8(base ? Math.min(255, seq - base.seq) : 0);
      w.u8(mask);
      for (let f = 0; f < FIELDS; f += 1) if (mask & (1 << f)) w.i32(q[f]!);
      sent.set(e.id, q);
      this.score.set(e.id, 0);
      count += 1;
    }
    this.history.set(seq, sent);
    this.history.delete(seq - HISTORY - 1);
    this.lastSent = count;
    const out = w.done();
    new DataView(out.buffer).setUint16(countAt, count, true);
    return out;
  }
}

function popcount(v: number): number {
  let n = 0;
  for (let x = v; x; x &= x - 1) n += 1;
  return n;
}

/** A client's half: the entities' poses as last heard, and the acks to send back. */
export class ReplicationClient {
  private readonly history = new Map<number, Map<number, Q>>();
  private newest = 0;
  private readonly current = new Map<number, Q>();

  /** A host packet. Returns false when it can't be read (a delta whose baseline this client never got). */
  receive(bytes: Uint8Array): boolean {
    const r = new Reader(bytes);
    if (r.left < 7 || r.u8() !== HOST) return false;
    const seq = r.u32();
    const count = r.u16();
    const got = new Map<number, Q>();
    for (let i = 0; i < count; i += 1) {
      const id = r.u16();
      const back = r.u8();
      const mask = r.u8();
      const base = back > 0 ? this.history.get(seq - back)?.get(id) : undefined;
      if (back > 0 && !base) return false;
      const q = base ? [...base] : new Array<number>(FIELDS).fill(0);
      for (let f = 0; f < FIELDS; f += 1) if (mask & (1 << f)) q[f] = r.i32();
      got.set(id, q);
    }
    this.history.set(seq, got);
    for (const s of this.history.keys()) if (s < seq - HISTORY) this.history.delete(s);
    // Only a newer packet moves what's shown: one arriving late still counts as received.
    if (seq > this.newest) {
      for (const [id, q] of got) this.current.set(id, q);
      this.newest = seq;
    }
    return true;
  }

  /** The ack to send: the newest packet and which of the 32 before it arrived, with this camera. */
  ack(viewer: Vec3): Uint8Array {
    const w = new Writer();
    w.u8(CLIENT);
    w.u32(this.newest);
    let bits = 0;
    for (let k = 0; k < 32; k += 1) if (this.history.has(this.newest - 1 - k)) bits |= 1 << k;
    w.u32(bits >>> 0);
    for (const v of viewer) w.i32(Math.round(v * POS));
    return w.done();
  }

  /** Every entity's pose as last heard. */
  poses(): Map<number, EntityPose> {
    return new Map([...this.current].map(([id, q]) => [id, dequantize(id, q)]));
  }
}
