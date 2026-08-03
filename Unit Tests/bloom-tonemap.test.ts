/**
 * The arithmetic behind cinematic gap #4 — the multi-scale bloom pyramid and the
 * HDR tonemap — validated on the pure model that the GLSL is a port of, so the
 * shader is anchored to code with tests rather than checked only by eye.
 *
 * The assertions are about properties, not baked numbers: the pyramid must stop
 * exactly where a further halving would fall below the floor, the prefilter must
 * gate on and preserve hue, and the tonemap must be a monotonic curve that never
 * clips however bright the light gets. Where a concrete expectation is needed it
 * is derived from the input by the same definition, never a hand-copied constant,
 * so retuning a constant cannot leave a stale literal passing.
 */

import { describe, expect, it } from "vitest";
import {
  BLOOM_KNEE,
  MAX_PYRAMID_LEVELS,
  MIN_PYRAMID_DIMENSION,
  acesFilmic,
  acesFilmicChannel,
  defaultPostFxSettings,
  paramKey,
  pyramidLevelCount,
  pyramidLevelSize,
  softKneePrefilter,
  uniformsFromSettings,
} from "@cartbox/player";

describe("pyramidLevelCount", () => {
  it("always yields at least one level, even for a frame too small to halve", () => {
    expect(pyramidLevelCount(2, 2)).toBeGreaterThanOrEqual(1);
    expect(pyramidLevelCount(1, 1)).toBe(1);
  });

  it("never exceeds the declared ceiling however large the frame", () => {
    expect(pyramidLevelCount(4096, 4096)).toBeLessThanOrEqual(MAX_PYRAMID_LEVELS);
  });

  it("stops exactly where one more halving would fall below the floor", () => {
    // The deepest allocated level must still be at or above the floor, and the
    // level that would come after it must be below it — that boundary is the
    // whole definition of the count, checked here without repeating the loop.
    const [width, height] = [640, 360];
    const count = pyramidLevelCount(width, height);
    const deepest = pyramidLevelSize(width, height, count - 1);
    expect(Math.min(deepest.width, deepest.height)).toBeGreaterThanOrEqual(MIN_PYRAMID_DIMENSION);

    if (count < MAX_PYRAMID_LEVELS) {
      const next = pyramidLevelSize(width, height, count);
      expect(Math.min(next.width, next.height)).toBeLessThan(MIN_PYRAMID_DIMENSION);
    }
  });

  it("never gives a larger frame fewer levels than a smaller one", () => {
    let previous = 0;
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      const count = pyramidLevelCount(size, size);
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
  });
});

describe("pyramidLevelSize", () => {
  it("halves both dimensions each level, starting at half the base", () => {
    const [width, height] = [640, 360];
    for (let index = 0; index < pyramidLevelCount(width, height); index++) {
      const divisor = 2 ** (index + 1);
      expect(pyramidLevelSize(width, height, index)).toEqual({
        width: Math.floor(width / divisor),
        height: Math.floor(height / divisor),
      });
    }
  });

  it("never returns a zero dimension", () => {
    const size = pyramidLevelSize(3, 3, 8);
    expect(size.width).toBeGreaterThanOrEqual(1);
    expect(size.height).toBeGreaterThanOrEqual(1);
  });
});

describe("softKneePrefilter", () => {
  const threshold = 0.6;

  it("rejects a colour whose brightest channel is at or below threshold minus knee", () => {
    // The knee opens at threshold - knee; anything below contributes nothing.
    const dark = softKneePrefilter([threshold - BLOOM_KNEE, 0.02, 0.0], threshold, BLOOM_KNEE);
    for (const channel of dark) expect(channel).toBeCloseTo(0, 6);
  });

  it("extracts a positive, in-range glow for a pixel above the threshold", () => {
    // The prefilter is a bright *pass*: it keeps only the overshoot above the
    // threshold, so a bright pixel yields a positive glow that is never brighter
    // than the pixel itself (contribution stays within 0..1 for in-range colour).
    const input: [number, number, number] = [1, 0.9, 0.8];
    const bright = softKneePrefilter(input, threshold, BLOOM_KNEE);
    expect(bright[0]).toBeGreaterThan(0);
    for (let channel = 0; channel < 3; channel++) {
      expect(bright[channel]).toBeGreaterThan(0);
      expect(bright[channel]).toBeLessThanOrEqual(input[channel]!);
    }
  });

  it("keeps the hue by scaling every channel equally", () => {
    // A pixel in the knee should stay the same colour, only dimmer — so the
    // output/input ratio must match across the channels that are non-zero.
    const input: [number, number, number] = [0.8, 0.4, 0.2];
    const filtered = softKneePrefilter(input, threshold);
    const ratio = filtered[0] / input[0];
    expect(filtered[1] / input[1]).toBeCloseTo(ratio, 6);
    expect(filtered[2] / input[2]).toBeCloseTo(ratio, 6);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it("ramps monotonically as a pixel brightens through the knee", () => {
    let previous = -1;
    for (let brightness = 0; brightness <= 1.5; brightness += 0.1) {
      const contribution = softKneePrefilter([brightness, brightness, brightness], threshold, BLOOM_KNEE)[0];
      expect(contribution).toBeGreaterThanOrEqual(previous);
      previous = contribution;
    }
  });
});

describe("acesFilmic tonemap", () => {
  it("maps black to black", () => {
    expect(acesFilmicChannel(0)).toBeCloseTo(0, 6);
  });

  it("strictly increases through the usable range and never decreases past it", () => {
    // Below saturation the curve must rise on every step; once it reaches 1 it
    // holds there, so the whole domain is non-decreasing and the low end strict.
    let strict = -1;
    for (let x = 0; x <= 2; x += 0.1) {
      const mapped = acesFilmicChannel(x);
      expect(mapped).toBeGreaterThan(strict);
      strict = mapped;
    }
    let nonDecreasing = -1;
    for (let x = 0; x <= 12; x += 0.25) {
      const mapped = acesFilmicChannel(x);
      expect(mapped).toBeGreaterThanOrEqual(nonDecreasing);
      nonDecreasing = mapped;
    }
  });

  it("never clips: however bright the input, the output stays inside 0..1", () => {
    for (const x of [1, 2, 4, 16, 64, 1000]) {
      const mapped = acesFilmicChannel(x);
      expect(mapped).toBeGreaterThan(0);
      expect(mapped).toBeLessThanOrEqual(1);
    }
  });

  it("rolls highlights off rather than passing them straight through", () => {
    // Above 1.0 the curve must compress: the mapped value sits below the raw
    // input, which is exactly why a bloomed emissive keeps its colour.
    for (const x of [1.5, 3, 6]) {
      expect(acesFilmicChannel(x)).toBeLessThan(x);
    }
  });

  it("applies exposure as a straight pre-multiply on each channel", () => {
    const rgb: [number, number, number] = [0.3, 0.6, 1.2];
    const exposure = 1.8;
    const toned = acesFilmic(rgb, exposure);
    expect(toned).toEqual([
      acesFilmicChannel(rgb[0] * exposure),
      acesFilmicChannel(rgb[1] * exposure),
      acesFilmicChannel(rgb[2] * exposure),
    ]);
  });

  it("preserves the ordering between channels", () => {
    const [r, g, b] = acesFilmic([0.2, 0.5, 0.9], 1.5);
    expect(r).toBeLessThan(g);
    expect(g).toBeLessThan(b);
  });
});

describe("uniformsFromSettings for the new bloom/tonemap controls", () => {
  it("leaves tonemap off and the new params at their neutral defaults", () => {
    const uniforms = uniformsFromSettings(defaultPostFxSettings());
    expect(uniforms.toneMap).toBe(0);
    expect(uniforms.exposure).toBe(1);
    expect(uniforms.bloomRadius).toBe(defaultPostFxSettings().values[paramKey("bloom", "radius")]);
  });

  it("surfaces the bloom radius once bloom is enabled", () => {
    const settings = defaultPostFxSettings();
    settings.enabled.bloom = true;
    settings.values[paramKey("bloom", "radius")] = 0.85;
    expect(uniformsFromSettings(settings).bloomRadius).toBe(0.85);
  });

  it("turns the tonemap on and passes its exposure through when enabled", () => {
    const settings = defaultPostFxSettings();
    settings.enabled.tonemap = true;
    settings.values[paramKey("tonemap", "exposure")] = 2.4;
    const uniforms = uniformsFromSettings(settings);
    expect(uniforms.toneMap).toBe(1);
    expect(uniforms.exposure).toBe(2.4);
  });

  it("reads exposure as a shape parameter even while the tonemap is off", () => {
    const settings = defaultPostFxSettings();
    settings.values[paramKey("tonemap", "exposure")] = 0.5;
    const uniforms = uniformsFromSettings(settings);
    expect(uniforms.exposure).toBe(0.5);
    expect(uniforms.toneMap).toBe(0);
  });
});
