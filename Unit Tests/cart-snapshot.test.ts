/**
 * Undo-timeline snapshot tests
 * (apps/web/src/app/edit/[cartId]/useEditorHistory.ts).
 *
 * Snapshot equality used to byte-compare two whole cartridges on every
 * coalesced commit — several hundred KB of comparison per gesture on a
 * well-used eight-bank cart. Hashing at capture makes the common "nothing
 * actually changed" answer a single integer compare.
 *
 * That optimisation is only safe if the fallback holds: a hash match must still
 * be confirmed against the bytes, so a collision can never silently swallow a
 * real edit. These tests cover both halves, and the sidecar half that makes
 * `mesh` and `world` undoable at all.
 */

import { describe, expect, it } from "vitest";

import { hashBytes, snapshotsEqual, type CartSnapshot } from "@/app/edit/[cartId]/useEditorHistory";
import { emptySidecars, type Sidecars } from "@/lib/sidecars";

function snapshot(bytes: number[], overrides: Partial<CartSnapshot> = {}): CartSnapshot {
  const buffer = new Uint8Array(bytes);
  return {
    bytes: buffer,
    bank: 0,
    sidecars: emptySidecars(),
    hash: hashBytes(buffer),
    ...overrides,
  };
}

describe("hashBytes", () => {
  it("gives identical buffers the same hash", () => {
    expect(hashBytes(new Uint8Array([1, 2, 3]))).toBe(hashBytes(new Uint8Array([1, 2, 3])));
  });

  it("gives different buffers different hashes", () => {
    expect(hashBytes(new Uint8Array([1, 2, 3]))).not.toBe(hashBytes(new Uint8Array([1, 2, 4])));
  });

  it("notices a change anywhere in a long buffer", () => {
    const bytes = new Uint8Array(4096).fill(7);
    const before = hashBytes(bytes);
    bytes[4000] = 8;
    expect(hashBytes(bytes)).not.toBe(before);
  });

  it("distinguishes buffers that differ only in order", () => {
    expect(hashBytes(new Uint8Array([1, 2]))).not.toBe(hashBytes(new Uint8Array([2, 1])));
  });

  it("returns an unsigned 32-bit value", () => {
    const hash = hashBytes(new Uint8Array([255, 254, 253, 252]));
    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("snapshotsEqual", () => {
  it("treats two identical snapshots as the same timeline state", () => {
    expect(snapshotsEqual(snapshot([1, 2, 3]), snapshot([1, 2, 3]))).toBe(true);
  });

  it("separates snapshots whose cart bytes differ", () => {
    expect(snapshotsEqual(snapshot([1, 2, 3]), snapshot([1, 2, 4]))).toBe(false);
  });

  it("separates snapshots taken on different banks", () => {
    expect(snapshotsEqual(snapshot([1]), snapshot([1], { bank: 3 }))).toBe(false);
  });

  it("still compares the bytes when the hashes agree", () => {
    // A forged hash stands in for a collision: equality must not trust it alone.
    const a = snapshot([1, 2, 3]);
    const b = snapshot([9, 9, 9], { hash: a.hash });
    expect(snapshotsEqual(a, b)).toBe(false);
  });

  it("separates snapshots whose sidecars differ", () => {
    const withMesh: Sidecars = { ...emptySidecars(), mesh: "a-mesh-payload" };
    expect(snapshotsEqual(snapshot([1]), snapshot([1], { sidecars: withMesh }))).toBe(false);
  });

  it("puts a mesh edit on the timeline, so deleting one is undoable", () => {
    const before: Sidecars = { ...emptySidecars(), mesh: "two-meshes" };
    const after: Sidecars = { ...emptySidecars(), mesh: null };
    expect(snapshotsEqual(snapshot([1], { sidecars: before }), snapshot([1], { sidecars: after }))).toBe(false);
  });

  it("puts a world edit on the timeline too", () => {
    const before: Sidecars = { ...emptySidecars(), world: '{"tiles":[1]}' };
    const after: Sidecars = { ...emptySidecars(), world: '{"tiles":[2]}' };
    expect(snapshotsEqual(snapshot([1], { sidecars: before }), snapshot([1], { sidecars: after }))).toBe(false);
  });

  it("separates buffers of different lengths", () => {
    expect(snapshotsEqual(snapshot([1, 2]), snapshot([1, 2, 3]))).toBe(false);
  });
});
