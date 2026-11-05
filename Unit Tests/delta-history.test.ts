/**
 * Delta undo (AAA_PRODUCTION_ROADMAP.md W1): undo steps that cost what changed,
 * within a memory budget instead of a fixed count, giving back exactly what
 * the whole-snapshot history did.
 */
import { describe, expect, it } from "vitest";
import { DeltaHistory, EditHistory, applyBytes, diffBytes } from "@cartbox/editor";
import { SNAPSHOT_DELTAS, type DeltaSnapshot } from "../apps/web/src/lib/historyDelta";
import { emptySidecars } from "../apps/web/src/lib/sidecars";

/** FNV-1a: comparing whole carts by value, cheaply. */
const fnv = (b: Uint8Array) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i += 1) h = Math.imul(h ^ b[i]!, 0x01000193);
  return h >>> 0;
};

/** A cart-sized byte array with a deterministic edit at `at`. */
function edited(base: Uint8Array, at: number, value: number): Uint8Array {
  const out = base.slice();
  for (let k = 0; k < 32; k += 1) out[(at + k) % out.length] = (value + k) & 255;
  return out;
}

describe("byte patches", () => {
  it("round-trip any change, including a change of length, as runs of what differs", () => {
    const a = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 255);
    const b = edited(a, 1200, 9);
    const p = diffBytes(b, a);
    expect(p.runs.length).toBe(1);
    expect(p.runs[0]!.bytes.length).toBeLessThanOrEqual(32);
    expect(applyBytes(a, p)).toEqual(b);
    const longer = Uint8Array.from([...b, 1, 2, 3]);
    expect(applyBytes(b, diffBytes(longer, b))).toEqual(longer);
    expect(applyBytes(longer, diffBytes(a, longer))).toEqual(a);
  });
});

describe("delta undo (W1)", () => {
  const cart = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 31) & 255);
  const snap = (bytes: Uint8Array, sidecars = emptySidecars(), bank = 0): DeltaSnapshot => ({ bytes, bank, sidecars, hash: bytes.length });

  it("undoes and redoes exactly as whole snapshots did, through a fork", () => {
    const states = [snap(cart)];
    for (let i = 1; i <= 20; i += 1) states.push(snap(edited(states[i - 1]!.bytes, i * 4999, i)));
    const delta = new DeltaHistory(states[0]!, SNAPSHOT_DELTAS);
    const whole = new EditHistory(states[0]!);
    for (const s of states.slice(1)) {
      delta.record(s);
      whole.record(s);
    }
    const walk = (h: { undo(): DeltaSnapshot | null; redo(): DeltaSnapshot | null }, ops: string) => [...ops].map((o) => fnv((o === "u" ? h.undo() : h.redo())!.bytes));
    const ops = "uuuuurruuuuuuuuurrr";
    expect(walk(delta, ops)).toEqual(walk(whole, ops));
    // A new edit after undoing forks the future: redo has nothing.
    const fork = snap(edited(delta.current().bytes, 77, 200));
    delta.record(fork);
    expect(delta.canRedo()).toBe(false);
    expect(fnv(delta.undo()!.bytes)).toBe(fnv(whole.current().bytes));
  });

  it("costs what changed: 200 small edits of a 300 KB cart hold a few tens of KB, not 60 MB", () => {
    const h = new DeltaHistory(snap(cart), SNAPSHOT_DELTAS);
    let s = snap(cart);
    for (let i = 1; i <= 200; i += 1) {
      s = snap(edited(s.bytes, i * 1499, i));
      h.record(s);
    }
    expect(h.size()).toBe(201); // every step kept: no fixed count
    expect(h.memory()).toBeLessThan(40_000);
    for (let i = 0; i < 200; i += 1) h.undo();
    expect(fnv(h.current().bytes)).toBe(fnv(cart));
  });

  it("forgets the oldest steps once over its budget, and counts only changed sidecars", () => {
    const h = new DeltaHistory(snap(cart), SNAPSHOT_DELTAS, { budget: 10_000 });
    let s = snap(cart);
    for (let i = 1; i <= 200; i += 1) {
      s = snap(edited(s.bytes, i * 1499, i));
      h.record(s);
    }
    expect(h.memory()).toBeLessThanOrEqual(10_000);
    expect(h.size()).toBeLessThan(201);
    let undone = 0;
    while (h.undo()) undone += 1;
    expect(undone).toBe(h.size() - 1);
    // A sidecar edit costs that sidecar only.
    const k = new DeltaHistory(snap(cart), SNAPSHOT_DELTAS);
    const sidecars = { ...emptySidecars(), flags: [1, 2, 3] } as unknown as ReturnType<typeof emptySidecars>;
    k.record(snap(cart, sidecars));
    expect(k.memory()).toBeLessThan(200);
    expect(k.undo()!.sidecars).toEqual(emptySidecars());
    expect(k.redo()!.sidecars).toBe(k.current().sidecars);
  });
});
