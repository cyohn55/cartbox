/**
 * Unit tests for achievement resolution (Platform P2).
 *
 * resolveUnlockedAchievements maps the FNV hashes a replay produced back to the
 * cart's registered achievements. Paired with hashEventId (which matches the
 * cartbox SDK), this closes the loop from `cartbox.unlock("key")` to a grant.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import { hashEventId, resolveUnlockedAchievements } from "@cartbox/player";

describe("resolveUnlockedAchievements", () => {
  const registered = [
    { id: "a-first", hash: hashEventId("first_blood"), key: "first_blood" },
    { id: "a-boss", hash: hashEventId("boss_slain"), key: "boss_slain" },
    { id: "a-secret", hash: hashEventId("hidden"), key: "hidden" },
  ];

  it("maps unlock hashes to their registered achievements", () => {
    const unlocked = resolveUnlockedAchievements([hashEventId("first_blood")], registered);
    expect(unlocked.map((a) => a.id)).toEqual(["a-first"]);
  });

  it("resolves multiple unlocks and ignores unregistered hashes", () => {
    const unlocked = resolveUnlockedAchievements(
      [hashEventId("boss_slain"), hashEventId("first_blood"), hashEventId("not_registered")],
      registered,
    );
    expect(unlocked.map((a) => a.id).sort()).toEqual(["a-boss", "a-first"]);
  });

  it("returns nothing when no hashes match", () => {
    expect(resolveUnlockedAchievements([12345], registered)).toEqual([]);
  });

  it("compares hashes as unsigned 32-bit (high-bit hashes match)", () => {
    // Force a hash with the top bit set to exercise the >>> 0 normalization.
    const highBitHash = 0xff00ff00;
    const unlocked = resolveUnlockedAchievements([highBitHash], [{ id: "x", hash: highBitHash }]);
    expect(unlocked.map((a) => a.id)).toEqual(["x"]);
  });
});
