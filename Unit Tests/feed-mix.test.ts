/**
 * Unit tests for the home feed's interleaver — the pure mixing that turns
 * per-source lists (carts, clips, achievements, authored posts) into one
 * TikTok-style feed with no same-kind cards adjacent when avoidable.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import { interleaveFeed } from "../apps/web/src/lib/feedMix";

interface Item {
  kind: string;
  id: string;
}

function group(kind: string, count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({ kind, id: `${kind}-${index}` }));
}

describe("interleaveFeed", () => {
  it("emits every item exactly once", () => {
    const groups = [group("cart", 4), group("news", 2), group("trivia", 3)];
    const mixed = interleaveFeed(groups);

    expect(mixed).toHaveLength(9);
    expect(new Set(mixed.map((item) => item.id)).size).toBe(9);
  });

  it("preserves each group's internal order", () => {
    const groups = [group("cart", 3), group("clip", 3)];
    const mixed = interleaveFeed(groups);

    const cartIds = mixed.filter((item) => item.kind === "cart").map((item) => item.id);
    expect(cartIds).toEqual(["cart-0", "cart-1", "cart-2"]);
  });

  it("avoids same-kind adjacency whenever another kind is available", () => {
    const groups = [group("cart", 5), group("news", 3), group("dev_tip", 3)];
    const mixed = interleaveFeed(groups);

    for (let index = 1; index < mixed.length; index += 1) {
      // With three kinds and these counts, no forced runs exist at all.
      expect(mixed[index].kind, `position ${index}`).not.toBe(mixed[index - 1].kind);
    }
  });

  it("falls back to same-kind adjacency only when nothing else remains", () => {
    const mixed = interleaveFeed([group("cart", 4), group("news", 1)]);

    expect(mixed).toHaveLength(5);
    // The single news card breaks up the carts once; the remaining carts must
    // still all be emitted even though they end up adjacent.
    expect(mixed.filter((item) => item.kind === "cart")).toHaveLength(4);
  });

  it("handles empty groups and an empty feed", () => {
    expect(interleaveFeed([])).toEqual([]);
    expect(interleaveFeed([[], group("cart", 2), []])).toHaveLength(2);
  });

  it("is deterministic for the same input", () => {
    const groups = [group("cart", 3), group("clip", 2), group("trivia", 2)];
    expect(interleaveFeed(groups)).toEqual(interleaveFeed(groups));
  });
});
