/**
 * Unit tests for the home feed's interleaver — the pure mixing that turns
 * per-source lists (carts, clips, achievements, authored posts) into one
 * TikTok-style feed with no same-kind cards adjacent when avoidable.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import { assembleFeed, interleaveFeed, type FeedItem, type FeedItemKind } from "../apps/web/src/lib/feedMix";

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

// ---------------------------------------------------------------------------
// Assembly from independently-fetched sources
// ---------------------------------------------------------------------------

/** A real FeedItem, so the assembler is exercised against the shipped shape. */
function feedItem(kind: FeedItemKind, index: number): FeedItem {
  return {
    id: `${kind}:${index}`,
    kind,
    title: `${kind} ${index}`,
    body: "",
    authorHandle: "maker",
    authorName: "Maker",
    createdAt: "2026-07-28T00:00:00.000Z",
  };
}

function fulfilled(items: FeedItem[]): PromiseSettledResult<FeedItem[]> {
  return { status: "fulfilled", value: items };
}

function rejected(message: string): PromiseSettledResult<FeedItem[]> {
  return { status: "rejected", reason: new Error(message) };
}

describe("assembleFeed", () => {
  it("mixes every item from every source that succeeded", () => {
    const result = assembleFeed([
      fulfilled([feedItem("cart", 0), feedItem("cart", 1)]),
      fulfilled([feedItem("clip", 0)]),
      fulfilled([feedItem("news", 0), feedItem("trivia", 0)]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.id).sort()).toEqual([
      "cart:0",
      "cart:1",
      "clip:0",
      "news:0",
      "trivia:0",
    ]);
    expect(result.degraded).toBe(false);
  });

  /**
   * The bug this exists for: every source used to swallow its query error, so an
   * unreachable database produced a 200 with an empty feed — a blank homescreen
   * that looked exactly like a platform where nobody had published anything.
   */
  it("reports failure, not an empty feed, when every source failed", () => {
    const result = assembleFeed([rejected("fetch failed"), rejected("fetch failed")]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("fetch failed");
  });

  it("still renders the sources that survived when only some failed", () => {
    const result = assembleFeed([
      fulfilled([feedItem("cart", 0)]),
      rejected("replays unavailable"),
      fulfilled([feedItem("news", 0)]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toHaveLength(2);
    expect(result.degraded).toBe(true);
  });

  it("splits authored posts by kind so varieties alternate", () => {
    // News and trivia arrive from one source; without the split they would be
    // one clump and the interleaver could not separate them.
    const result = assembleFeed([
      fulfilled([feedItem("news", 0), feedItem("news", 1), feedItem("trivia", 0), feedItem("trivia", 1)]),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const kinds = result.items.map((item) => item.kind);
    for (let index = 1; index < kinds.length; index += 1) {
      expect(kinds[index]).not.toBe(kinds[index - 1]);
    }
  });

  it("treats a genuinely empty platform as a successful empty feed", () => {
    const result = assembleFeed([fulfilled([]), fulfilled([])]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items).toEqual([]);
    expect(result.degraded).toBe(false);
  });

  it("reports no failure when there were no sources to begin with", () => {
    expect(assembleFeed([])).toEqual({ ok: true, items: [], degraded: false });
  });
});
