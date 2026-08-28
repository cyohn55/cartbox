/**
 * The supersample-factor policy that gates the lighting-pass de-banding: an
 * explicit host request is honoured (clamped to a sane 1..4), and an omitted one
 * is auto-picked from the framebuffer size — 2× for standard-resolution consoles,
 * 1× for large ones (e.g. the Pro core) where the N² cost outweighs the benefit.
 *
 * Expectations are derived from the resolution boundary and the clamp range, not
 * hand-copied, so retuning the budget can't leave a stale literal passing.
 */

import { describe, expect, it } from "vitest";
import { resolveSupersample } from "@cartbox/player";

// Reference resolutions the policy is meant to split.
const STANDARD = { width: 240, height: 136 }; // TIC-80 native, 32,640 px
const PRO = { width: 640, height: 360 }; //       Pro core, 230,400 px
const PORTRAIT = { width: 360, height: 640 }; //   Pro transposed, same area

describe("resolveSupersample", () => {
  it("auto-picks 2× for a standard-resolution framebuffer", () => {
    expect(resolveSupersample(STANDARD.width, STANDARD.height)).toBe(2);
  });

  it("auto-drops to 1× for large framebuffers (Pro core, either orientation)", () => {
    expect(resolveSupersample(PRO.width, PRO.height)).toBe(1);
    expect(resolveSupersample(PORTRAIT.width, PORTRAIT.height)).toBe(1);
  });

  it("honours an explicit request over the auto policy", () => {
    // Forcing 2× on a large target, and 1× (off) on a small one, both stick.
    expect(resolveSupersample(PRO.width, PRO.height, 2)).toBe(2);
    expect(resolveSupersample(STANDARD.width, STANDARD.height, 1)).toBe(1);
  });

  it("clamps an explicit request into 1..4 and rounds to a whole factor", () => {
    expect(resolveSupersample(STANDARD.width, STANDARD.height, 0)).toBe(1);
    expect(resolveSupersample(STANDARD.width, STANDARD.height, 9)).toBe(4);
    expect(resolveSupersample(STANDARD.width, STANDARD.height, 2.4)).toBe(2);
    // A non-finite request falls back to the auto policy rather than clamping NaN.
    expect(resolveSupersample(STANDARD.width, STANDARD.height, Number.NaN)).toBe(2);
  });
});
