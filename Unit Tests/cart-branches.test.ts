/**
 * Branches (AAA_PRODUCTION_ROADMAP.md W3): two versions of a cart compared and
 * merged per object (chunks, sidecars, each placed object of the scene),
 * three-way against a common ancestor.
 */
import { describe, expect, it } from "vitest";
import { codeChunks } from "@cartbox/player";
import { compareBranches, mergeBranches } from "../apps/web/src/lib/cartBranches";
import type { SnapshotContent } from "../apps/web/src/lib/cartSnapshots";
import { emptySidecars } from "../apps/web/src/lib/sidecars";

/** A cart: its code chunk, a sprite chunk, and a scene of named objects. */
function cart(code: string, sprite: number, objects: Record<string, number>, library: Record<string, string> = {}): SnapshotContent {
  const codeBytes = codeChunks(new TextEncoder().encode(code));
  const sprites = Uint8Array.from([2, 4, 0, 0, sprite, sprite, sprite, sprite]);
  const bytes = new Uint8Array(codeBytes.length + sprites.length);
  bytes.set(codeBytes);
  bytes.set(sprites, codeBytes.length);
  const mesh = JSON.stringify({ version: 2, lighting: null, meshes: Object.entries(objects).map(([id, x]) => ({ id, name: id, mesh: "@lib:box", transform: { position: [x, 0, 0] } })), library: { box: "{}", ...library } });
  return { model: "xbox360", bytes, sidecars: { ...emptySidecars(), mesh } as SnapshotContent["sidecars"], meta: { title: "t" } as unknown as SnapshotContent["meta"] };
}
const objects = (c: SnapshotContent) => Object.fromEntries((JSON.parse(c.sidecars.mesh as unknown as string).meshes as { id: string; transform: { position: number[] } }[]).map((m) => [m.id, m.transform.position[0]]));
const code = (c: SnapshotContent) => new TextDecoder().decode(c.bytes.subarray(4, 4 + (c.bytes[1]! | (c.bytes[2]! << 8))));

describe("branches (W3)", () => {
  const base = cart("function TIC() end", 1, { door: 0, crate: 5 });

  it("lists what differs, object by object", () => {
    const theirs = cart("function TIC() cls(1) end", 1, { door: 0, crate: 6, lamp: 2 });
    const diff = compareBranches(base, theirs).map((d) => [d.label, d.change]);
    expect(diff).toEqual([
      ["code", "changed"],
      ["object “crate”", "changed"],
      ["object “lamp”", "added"],
    ]);
  });

  it("merges three ways: each side's own changes kept, a both-sides conflict resolved by choice", () => {
    // Ours moved the door and wrote code; theirs moved the crate, added a lamp, repainted the sprite, and removed nothing.
    const ours = cart("function TIC() cls(2) end", 1, { door: 3, crate: 5 });
    const theirs = cart("function TIC() end", 9, { door: 0, crate: 8, lamp: 2 }, { lampmesh: "{}" });
    const merged = mergeBranches(base, ours, theirs);
    expect(merged.conflicts).toEqual([]);
    expect(objects(merged.content)).toEqual({ door: 3, crate: 8, lamp: 2 });
    expect(code(merged.content)).toBe("function TIC() cls(2) end");
    expect(merged.content.bytes[merged.content.bytes.length - 1]).toBe(9); // their sprite
    expect(JSON.parse(merged.content.sidecars.mesh as unknown as string).library).toEqual({ box: "{}", lampmesh: "{}" });
    // Both moved the crate: a conflict, taken from whichever side is chosen.
    const both = cart("function TIC() end", 1, { door: 0, crate: 7 });
    const mine = mergeBranches(base, both, theirs);
    expect(mine.conflicts.map((c) => [c.label, c.took])).toEqual([["object “crate”", "ours"]]);
    expect(objects(mine.content).crate).toBe(7);
    expect(objects(mergeBranches(base, both, theirs, () => "theirs").content).crate).toBe(8);
  });

  it("without an ancestor, every difference is the caller's choice, and a deletion can be taken", () => {
    const ours = cart("function TIC() end", 1, { door: 0, crate: 5, old: 1 });
    const theirs = cart("function TIC() end", 1, { door: 0, crate: 5 });
    const keep = mergeBranches(null, ours, theirs);
    expect(Object.keys(objects(keep.content))).toEqual(["door", "crate", "old"]);
    const take = mergeBranches(null, ours, theirs, () => "theirs");
    expect(Object.keys(objects(take.content))).toEqual(["door", "crate"]);
  });
});
