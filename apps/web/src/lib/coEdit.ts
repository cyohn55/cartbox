/**
 * Co-editing (AAA_PRODUCTION_ROADMAP.md W2), the engine side: several editors
 * of one cart see each other and each other's edits live, over any broadcast
 * channel (the realtime channel netplay uses, or a BroadcastChannel between
 * tabs).
 *
 * - **The data:** the cart's sidecars split into objects as branches split them
 *   (W3): each sidecar, and the scene's placed objects one by one, its settings
 *   and its object order as three more. Each object is a last-writer-wins
 *   register stamped with a Lamport clock and the writer's id, so every editor,
 *   whatever order the edits reach it in, settles on the same cart: a CRDT.
 *   Two people editing different objects both keep their edits; the same
 *   object, the later edit wins everywhere.
 * - **Joining:** a newcomer asks, and the others answer with every register;
 *   merging is idempotent, so more than one answer is harmless.
 * - **Presence:** each editor says who it is and what it has selected every
 *   few seconds; one silent for long enough is gone.
 * - **Locks** for binary assets (sprites, a sound file: what can't be merged):
 *   a lock is a register too (`lock:<asset>`, owner and expiry), so two who
 *   grab it at once agree on who got it.
 */

import type { Sidecars } from "./sidecars";
import { SIDECAR_KEYS } from "./sidecars";

/** One register's value: the object as JSON (null = deleted), and its stamp. */
interface Register {
  readonly value: string | null;
  readonly clock: number;
  readonly peer: string;
}

export interface CoEditMessage {
  readonly kind: "ops" | "hello" | "state" | "presence";
  readonly from: string;
  readonly ops?: readonly (readonly [key: string, value: string | null, clock: number, peer: string])[];
  readonly presence?: Presence;
}

export interface Presence {
  readonly peer: string;
  readonly name: string;
  /** What they have selected (object ids), for the others to outline. */
  readonly selection: readonly string[];
}

export interface CoEditTransport {
  send(message: CoEditMessage): void;
  onMessage(handler: (message: CoEditMessage) => void): void;
}

const newer = (a: Register, b: Register | undefined) => !b || a.clock > b.clock || (a.clock === b.clock && a.peer > b.peer);

/** A cart's sidecars as objects (W3's split): key → JSON. */
export function sidecarRegisters(sidecars: Sidecars): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of SIDECAR_KEYS) {
    const v = sidecars[key] as unknown;
    if (key === "mesh" && typeof v === "string" && v) {
      try {
        const { meshes = [], ...rest } = JSON.parse(v) as { meshes?: { id?: string }[] } & Record<string, unknown>;
        out.set("mesh:*", JSON.stringify(rest));
        out.set("mesh:#order", JSON.stringify(meshes.map((m) => m.id)));
        for (const m of meshes) if (typeof m.id === "string") out.set(`mesh:${m.id}`, JSON.stringify(m));
        continue;
      } catch {
        // An unreadable scene travels whole.
      }
    }
    if (v !== null && v !== undefined) out.set(`sidecar:${key}`, JSON.stringify(v));
  }
  return out;
}

/** Sidecars back from objects; `base` gives the empty sidecars. */
export function sidecarsFromRegisters(values: ReadonlyMap<string, string>, base: Sidecars): Sidecars {
  const out = { ...base } as Record<string, unknown>;
  for (const key of SIDECAR_KEYS) {
    const v = values.get(`sidecar:${key}`);
    out[key] = v === undefined ? null : JSON.parse(v);
  }
  const rest = values.get("mesh:*");
  if (rest !== undefined) {
    const order = JSON.parse(values.get("mesh:#order") ?? "[]") as string[];
    const ids = [...order.filter((id) => values.has(`mesh:${id}`)), ...[...values.keys()].filter((k) => k.startsWith("mesh:") && k !== "mesh:*" && k !== "mesh:#order" && !order.includes(k.slice(5))).map((k) => k.slice(5)).sort()];
    out.mesh = JSON.stringify({ ...JSON.parse(rest), meshes: ids.map((id) => JSON.parse(values.get(`mesh:${id}`)!)) });
  }
  return out as unknown as Sidecars;
}

export class CoEditSession {
  private clock = 0;
  private readonly registers = new Map<string, Register>();
  private readonly people = new Map<string, { presence: Presence; seen: number }>();
  private known: Map<string, string>;

  constructor(
    readonly peer: string,
    private readonly transport: CoEditTransport,
    initial: Sidecars,
    private readonly base: Sidecars,
    /** Called with the merged sidecars whenever someone else's edit lands. */
    private readonly apply: (sidecars: Sidecars) => void,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.known = sidecarRegisters(initial);
    for (const [key, value] of this.known) this.registers.set(key, { value, clock: 0, peer: "" });
    transport.onMessage((m) => this.receive(m));
    transport.send({ kind: "hello", from: peer });
  }

  /** The editor changed the cart: send what changed. */
  edit(sidecars: Sidecars): void {
    const next = sidecarRegisters(sidecars);
    const ops: [string, string | null, number, string][] = [];
    for (const [key, value] of next) if (this.known.get(key) !== value) ops.push(this.stamp(key, value));
    for (const key of this.known.keys()) if (!next.has(key)) ops.push(this.stamp(key, null));
    this.known = next;
    if (ops.length > 0) this.transport.send({ kind: "ops", from: this.peer, ops });
  }

  private stamp(key: string, value: string | null): [string, string | null, number, string] {
    this.clock += 1;
    this.registers.set(key, { value, clock: this.clock, peer: this.peer });
    return [key, value, this.clock, this.peer];
  }

  /** The cart as this editor has it now. */
  sidecars(): Sidecars {
    const values = new Map<string, string>();
    for (const [key, r] of this.registers) if (r.value !== null && !key.startsWith("lock:")) values.set(key, r.value);
    return sidecarsFromRegisters(values, this.base);
  }

  private receive(m: CoEditMessage): void {
    if (m.from === this.peer) return;
    if (m.kind === "hello") {
      // A newcomer: everything we have (registers with a stamp; the shared start needs none).
      const ops = [...this.registers].filter(([, r]) => r.clock > 0).map(([key, r]) => [key, r.value, r.clock, r.peer] as const);
      this.transport.send({ kind: "state", from: this.peer, ops });
      return;
    }
    if (m.kind === "presence" && m.presence) {
      this.people.set(m.from, { presence: m.presence, seen: this.now() });
      return;
    }
    let changed = false;
    for (const [key, value, clock, peer] of m.ops ?? []) {
      this.clock = Math.max(this.clock, clock);
      const incoming = { value, clock, peer };
      if (newer(incoming, this.registers.get(key))) {
        this.registers.set(key, incoming);
        if (!key.startsWith("lock:")) changed = true;
      }
    }
    if (changed) {
      const merged = this.sidecars();
      this.known = sidecarRegisters(merged);
      this.apply(merged);
    }
  }

  /** Say who this editor is and what it has selected (call every few seconds, and on a change). */
  announce(name: string, selection: readonly string[]): void {
    this.transport.send({ kind: "presence", from: this.peer, presence: { peer: this.peer, name, selection } });
  }

  /** The other editors heard from in the last `within` ms. */
  others(within = 10_000): Presence[] {
    const t = this.now();
    return [...this.people.values()].filter((p) => t - p.seen <= within).map((p) => p.presence);
  }

  /** Take the lock on a binary asset for `ms`, unless someone else holds it. True when it's ours (as far as we know yet). */
  lock(asset: string, ms = 60_000): boolean {
    const held = this.holder(asset);
    if (held && held !== this.peer) return false;
    const op = this.stamp(`lock:${asset}`, JSON.stringify({ owner: this.peer, until: this.now() + ms }));
    this.transport.send({ kind: "ops", from: this.peer, ops: [op] });
    return true;
  }

  unlock(asset: string): void {
    if (this.holder(asset) !== this.peer) return;
    this.transport.send({ kind: "ops", from: this.peer, ops: [this.stamp(`lock:${asset}`, null)] });
  }

  /** Who holds an asset's lock now, or null. */
  holder(asset: string): string | null {
    const r = this.registers.get(`lock:${asset}`);
    if (!r?.value) return null;
    const { owner, until } = JSON.parse(r.value) as { owner: string; until: number };
    return until > this.now() ? owner : null;
  }
}

/** Between tabs of one browser (and the test hub): a BroadcastChannel per cart. */
export function broadcastChannelTransport(cartId: string): CoEditTransport & { close(): void } {
  const channel = new BroadcastChannel(`cartbox-coedit-${cartId}`);
  return {
    send: (m) => channel.postMessage(m),
    onMessage: (h) => channel.addEventListener("message", (e) => h((e as MessageEvent<CoEditMessage>).data)),
    close: () => channel.close(),
  };
}
