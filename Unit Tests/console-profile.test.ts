/**
 * Unit tests for the console profile/composer logic: featured-clip resolution
 * (player picks win; most-recent fallback) and community-post validation.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import {
  FEATURED_CLIP_LIMIT,
  POST_BODY_MAX,
  POST_TITLE_MAX,
  resolveFeaturedClips,
  validateFeedPostInput,
} from "../apps/web/src/lib/consoleProfile";

/** Newest-first clips, mirroring the API's ordering. */
const CLIPS = [
  { replayId: "r5", cartTitle: "Newest" },
  { replayId: "r4", cartTitle: "Fourth" },
  { replayId: "r3", cartTitle: "Third" },
  { replayId: "r2", cartTitle: "Second" },
  { replayId: "r1", cartTitle: "Oldest" },
];

describe("resolveFeaturedClips", () => {
  it("falls back to the most recent clips when nothing is picked", () => {
    const clips = resolveFeaturedClips([], CLIPS);
    expect(clips.map((clip) => clip.replayId)).toEqual(["r5", "r4", "r3"]);
  });

  it("shows the player's picks in the order they picked them", () => {
    const clips = resolveFeaturedClips(["r1", "r3"], CLIPS);
    expect(clips.map((clip) => clip.replayId)).toEqual(["r1", "r3"]);
  });

  it("ignores picks that no longer exist, keeping the rest", () => {
    const clips = resolveFeaturedClips(["deleted", "r2"], CLIPS);
    expect(clips.map((clip) => clip.replayId)).toEqual(["r2"]);
  });

  it("falls back to recents when every pick is gone", () => {
    const clips = resolveFeaturedClips(["gone-1", "gone-2"], CLIPS);
    expect(clips.map((clip) => clip.replayId)).toEqual(["r5", "r4", "r3"]);
  });

  it("caps picks at the featured limit and dedupes repeats", () => {
    const clips = resolveFeaturedClips(["r1", "r1", "r2", "r3", "r4"], CLIPS);
    expect(clips).toHaveLength(FEATURED_CLIP_LIMIT);
    expect(clips.map((clip) => clip.replayId)).toEqual(["r1", "r2", "r3"]);
  });

  it("handles a player with no clips at all", () => {
    expect(resolveFeaturedClips([], [])).toEqual([]);
    expect(resolveFeaturedClips(["r1"], [])).toEqual([]);
  });
});

describe("validateFeedPostInput", () => {
  const valid = {
    kind: "lfp",
    title: "Co-op run tonight",
    body: "Chasing the top of the leaderboard — all skill levels welcome.",
    cartId: null,
  };

  it("accepts a valid invite and normalizes whitespace", () => {
    const result = validateFeedPostInput({ ...valid, title: "  Co-op run tonight  " });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Co-op run tonight");
      expect(result.value.kind).toBe("lfp");
      expect(result.value.cartId).toBeNull();
    }
  });

  it("accepts a devlog with a linked cart id", () => {
    const result = validateFeedPostInput({
      ...valid,
      kind: "dev_post",
      cartId: "00000000-0000-4000-8000-000000000001",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cartId).toBe("00000000-0000-4000-8000-000000000001");
    }
  });

  it("rejects kinds players cannot author (news, trivia, nonsense)", () => {
    for (const kind of ["news", "trivia", "dev_tip", "cart", "", undefined]) {
      expect(validateFeedPostInput({ ...valid, kind }).ok).toBe(false);
    }
  });

  it("rejects titles that are too short, too long, or missing", () => {
    expect(validateFeedPostInput({ ...valid, title: "Hi" }).ok).toBe(false);
    expect(validateFeedPostInput({ ...valid, title: "x".repeat(POST_TITLE_MAX + 1) }).ok).toBe(false);
    expect(validateFeedPostInput({ ...valid, title: undefined }).ok).toBe(false);
  });

  it("rejects bodies that are too short or too long", () => {
    expect(validateFeedPostInput({ ...valid, body: "short" }).ok).toBe(false);
    expect(validateFeedPostInput({ ...valid, body: "x".repeat(POST_BODY_MAX + 1) }).ok).toBe(false);
  });

  it("rejects a malformed cart id but allows empty-string as none", () => {
    expect(validateFeedPostInput({ ...valid, cartId: "not-a-uuid" }).ok).toBe(false);
    const result = validateFeedPostInput({ ...valid, cartId: "" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cartId).toBeNull();
    }
  });
});
