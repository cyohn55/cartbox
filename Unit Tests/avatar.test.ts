/**
 * Unit tests for the avatar model (Platform P1, item c).
 *
 * The pure core is normalization (any input -> a valid, in-range spec) and
 * randomization (valid, and deterministic given an injected RNG).
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import {
  AVATAR_CATEGORIES,
  AVATAR_OPTION_COUNTS,
  AVATAR_PALETTE_SIZE,
  DEFAULT_PALETTE,
  normalizeAvatar,
  randomAvatar,
} from "../apps/web/src/lib/avatar";

describe("normalizeAvatar", () => {
  it("clamps out-of-range part ids into their category range", () => {
    const spec = normalizeAvatar({ parts: { hair: 999, eyes: -5 } });
    expect(spec.parts.hair).toBe(AVATAR_OPTION_COUNTS.hair - 1);
    expect(spec.parts.eyes).toBe(0);
  });

  it("fills every category and produces a full valid palette", () => {
    const spec = normalizeAvatar({});
    for (const category of AVATAR_CATEGORIES) {
      expect(spec.parts[category]).toBeGreaterThanOrEqual(0);
      expect(spec.parts[category]).toBeLessThan(AVATAR_OPTION_COUNTS[category]);
    }
    expect(spec.palette).toHaveLength(AVATAR_PALETTE_SIZE);
    for (const color of spec.palette) {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("replaces invalid palette entries with defaults and pads to size", () => {
    const spec = normalizeAvatar({ palette: ["#abcdef", "not-a-color"] });
    expect(spec.palette[0]).toBe("#abcdef");
    expect(spec.palette[1]).toBe(DEFAULT_PALETTE[1]);
    expect(spec.palette).toHaveLength(AVATAR_PALETTE_SIZE);
  });

  it("returns a valid spec for garbage input", () => {
    for (const garbage of [null, undefined, 42, "x", []]) {
      const spec = normalizeAvatar(garbage);
      expect(Object.keys(spec.parts).sort()).toEqual([...AVATAR_CATEGORIES].sort());
    }
  });
});

describe("randomAvatar", () => {
  it("produces in-range parts and is deterministic for a fixed RNG", () => {
    // A simple deterministic RNG so the result is reproducible.
    let state = 0.123;
    const rng = () => {
      state = (state * 9301 + 0.49297) % 1;
      return state;
    };
    const cloneRng = () => {
      let s = 0.123;
      return () => {
        s = (s * 9301 + 0.49297) % 1;
        return s;
      };
    };

    const a = randomAvatar(rng);
    const b = randomAvatar(cloneRng());
    expect(a).toEqual(b);

    for (const category of AVATAR_CATEGORIES) {
      expect(a.parts[category]).toBeGreaterThanOrEqual(0);
      expect(a.parts[category]).toBeLessThan(AVATAR_OPTION_COUNTS[category]);
    }
  });
});
