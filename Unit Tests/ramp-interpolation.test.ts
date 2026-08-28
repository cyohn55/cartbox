/**
 * Ramp de-banding — bilinear smoothing of the material ramp channels (height,
 * specular, roughness), validated on the pure model the lighting shaders (WebGL +
 * WebGPU) are ports of. Like the 16-direction normals, the 4-bit ramps step
 * visibly across a painted gradient; smoothing dissolves that at render time
 * without touching the stored art. The banding only shows on a GPU, so the
 * guarantees are pinned here on {@link sampleScalarBilinear}.
 *
 * The last test pins the property that keeps all three backends in agreement:
 * the shaders blend the whole material texel as a vec4 and take .gba, while the
 * CPU reference blends one scalar channel — bilinear is linear per channel, so
 * the two must be identical. Expectations are derived from the inputs (exact
 * linear interpolants, the repeated value), never hand-copied constants.
 */

import { describe, expect, it } from "vitest";
import { sampleScalarBilinear } from "@cartbox/player";

/** Exact bilinear of four scalars — the definition the sampler must satisfy. */
function bilinear(v00: number, v10: number, v01: number, v11: number, fx: number, fy: number): number {
  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

describe("sampleScalarBilinear", () => {
  it("leaves a uniform ramp field untouched (flat/unmapped materials)", () => {
    // Every texel the same level: smoothing must return it exactly at any sample
    // point — the property that keeps ordinary carts pixel-identical when on.
    const level = 9 / 15;
    const uniform = () => level;
    for (const [x, y] of [
      [0.5, 0.5],
      [3.25, 7.75],
      [10.1, 2.9],
    ]) {
      expect(sampleScalarBilinear(uniform, x, y)).toBeCloseTo(level, 12);
    }
  });

  it("reproduces a texel exactly when the sample lands on it (zero fraction)", () => {
    // Integer coordinates have zero fractional weight, so the result is that
    // texel's own value regardless of its neighbours.
    const field = (x: number, y: number) => ((x * 3 + y) % 16) / 15;
    for (const [x, y] of [
      [2, 5],
      [0, 0],
      [7, 3],
    ]) {
      expect(sampleScalarBilinear(field, x, y)).toBeCloseTo(field(x, y), 12);
    }
  });

  it("smooths a step edge into an intermediate value between the two levels", () => {
    // A vertical seam: columns < 5 are dark (level 2), columns >= 5 are bright
    // (level 13). Sampling astride the seam must land strictly between them —
    // the stair-step the shader dissolves per fragment.
    const dark = 2 / 15;
    const bright = 13 / 15;
    const stepField = (x: number) => (x < 5 ? dark : bright);
    const sampled = sampleScalarBilinear(stepField, 4.5, 0);

    expect(sampled).toBeGreaterThan(dark);
    expect(sampled).toBeLessThan(bright);
    // Halfway across the seam is the midpoint of the two levels.
    expect(sampled).toBeCloseTo((dark + bright) / 2, 12);
  });

  it("matches the exact bilinear interpolant at arbitrary fractions", () => {
    // A field whose four corners around (0,0)..(1,1) are known, checked against
    // the closed-form bilinear — derived from the corners, never a literal.
    const v00 = 1 / 15;
    const v10 = 6 / 15;
    const v01 = 10 / 15;
    const v11 = 15 / 15;
    const field = (x: number, y: number): number => {
      if (x <= 0 && y <= 0) return v00;
      if (x >= 1 && y <= 0) return v10;
      if (x <= 0 && y >= 1) return v01;
      return v11;
    };
    for (const [fx, fy] of [
      [0.25, 0.25],
      [0.5, 0.5],
      [0.8, 0.1],
      [0.33, 0.9],
    ]) {
      expect(sampleScalarBilinear(field, fx, fy)).toBeCloseTo(bilinear(v00, v10, v01, v11, fx, fy), 12);
    }
  });

  it("agrees with the shaders' whole-texel vec4 blend, channel by channel", () => {
    // The GLSL/WGSL sampleRampSmooth blends the material texel as a vec4 and reads
    // .gba; this reference blends one channel. Bilinear is linear per channel, so
    // for the same corners and weights they must coincide on every channel — the
    // guarantee that the three backends stay in lockstep.
    const texel = { g: [3, 11, 4, 8], b: [15, 2, 9, 6], a: [0, 7, 13, 1] } as const; // 00,10,01,11 per channel
    const toUnit = (raw: number) => raw / 15;

    const cornerGba = (corner: 0 | 1 | 2 | 3) => ({
      g: toUnit(texel.g[corner]),
      b: toUnit(texel.b[corner]),
      a: toUnit(texel.a[corner]),
    });

    for (const [fx, fy] of [
      [0.2, 0.7],
      [0.5, 0.5],
      [0.9, 0.15],
    ]) {
      // Shader path: blend the whole texel, then take each channel.
      const c00 = cornerGba(0);
      const c10 = cornerGba(1);
      const c01 = cornerGba(2);
      const c11 = cornerGba(3);
      const shaderBlend = {
        g: bilinear(c00.g, c10.g, c01.g, c11.g, fx, fy),
        b: bilinear(c00.b, c10.b, c01.b, c11.b, fx, fy),
        a: bilinear(c00.a, c10.a, c01.a, c11.a, fx, fy),
      };

      // CPU path: a per-channel field sampled at the same fractional position.
      const channelField = (channel: "g" | "b" | "a") => (x: number, y: number) => {
        const corner = (x >= 1 ? 1 : 0) + (y >= 1 ? 2 : 0);
        return toUnit(texel[channel][corner as 0 | 1 | 2 | 3]!);
      };

      expect(sampleScalarBilinear(channelField("g"), fx, fy)).toBeCloseTo(shaderBlend.g, 12);
      expect(sampleScalarBilinear(channelField("b"), fx, fy)).toBeCloseTo(shaderBlend.b, 12);
      expect(sampleScalarBilinear(channelField("a"), fx, fy)).toBeCloseTo(shaderBlend.a, 12);
    }
  });
});
