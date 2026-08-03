/**
 * The arithmetic behind cinematic gaps #5 (tilt-shift depth of field) and #6
 * (wet-floor screen-space reflection), validated on the pure model the GLSL is a
 * port of — the same anchoring-the-shader-to-tested-code approach bloomModel uses.
 *
 * The assertions are relational, not baked constants: a pixel in the focus band
 * is sharp and one outside it blurs more the further out it sits; a reflection is
 * absent above the waterline and fades with depth below it; the mirror maps a
 * point to its equidistant twin across the horizon. Expectations are derived from
 * the inputs by the same definitions, so retuning a constant cannot leave a stale
 * literal passing.
 */

import { describe, expect, it } from "vitest";
import {
  TILT_SHIFT_FEATHER,
  reflectionFade,
  reflectionSampleY,
  tiltShiftBlur,
} from "@cartbox/player";

describe("tiltShiftBlur", () => {
  const focus = 0.5;
  const range = 0.1;

  it("is perfectly sharp anywhere inside the focus band", () => {
    expect(tiltShiftBlur(focus, focus, range)).toBe(0);
    expect(tiltShiftBlur(focus + range, focus, range)).toBe(0);
    expect(tiltShiftBlur(focus - range, focus, range)).toBe(0);
  });

  it("blurs more the further a pixel sits outside the band", () => {
    const near = tiltShiftBlur(focus + range + 0.05, focus, range);
    const far = tiltShiftBlur(focus + range + 0.2, focus, range);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
  });

  it("is symmetric above and below the focus row", () => {
    const above = tiltShiftBlur(focus - 0.3, focus, range);
    const below = tiltShiftBlur(focus + 0.3, focus, range);
    expect(above).toBeCloseTo(below, 12);
  });

  it("saturates at 1 once past the feather, and never exceeds it", () => {
    const past = tiltShiftBlur(focus + range + TILT_SHIFT_FEATHER + 0.5, focus, range);
    expect(past).toBe(1);
  });

  it("ramps by exactly the feather width just outside the band", () => {
    // Halfway across the feather must read half blur, straight from the definition.
    const half = tiltShiftBlur(focus + range + TILT_SHIFT_FEATHER / 2, focus, range);
    expect(half).toBeCloseTo(0.5, 12);
  });

  it("treats a negative range as zero so the whole frame can blur", () => {
    expect(tiltShiftBlur(focus, focus, -0.2)).toBe(0);
    expect(tiltShiftBlur(focus + 0.05, focus, -0.2)).toBeGreaterThan(0);
  });
});

describe("reflectionSampleY", () => {
  it("maps a point to its mirror image the same distance across the horizon", () => {
    const horizon = 0.6;
    expect(reflectionSampleY(horizon + 0.15, horizon)).toBeCloseTo(horizon - 0.15, 12);
    expect(reflectionSampleY(horizon, horizon)).toBe(horizon);
  });
});

describe("reflectionFade", () => {
  const horizon = 0.6;
  const falloff = 0.3;

  it("shows nothing at or above the waterline", () => {
    expect(reflectionFade(horizon, horizon, falloff)).toBe(0);
    expect(reflectionFade(horizon - 0.2, horizon, falloff)).toBe(0);
  });

  it("is strongest just below the horizon and fades with depth", () => {
    const shallow = reflectionFade(horizon + 0.02, horizon, falloff);
    const deep = reflectionFade(horizon + 0.2, horizon, falloff);
    expect(shallow).toBeGreaterThan(deep);
    expect(shallow).toBeGreaterThan(0);
  });

  it("reaches zero by the falloff distance and never goes negative", () => {
    expect(reflectionFade(horizon + falloff, horizon, falloff)).toBeCloseTo(0, 12);
    expect(reflectionFade(horizon + falloff + 0.2, horizon, falloff)).toBe(0);
  });

  it("fades linearly — half the falloff depth is half strength", () => {
    expect(reflectionFade(horizon + falloff / 2, horizon, falloff)).toBeCloseTo(0.5, 12);
  });
});
