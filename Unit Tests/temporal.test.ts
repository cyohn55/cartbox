/**
 * Temporal anti-aliasing (HALO_INFINITE_STYLE_ROADMAP.md I2), the parts
 * without a GPU: the jitter sequence, the jittered projection, the
 * reprojection between frames, when the history is trusted, the cap and the
 * quality presets, and the overlay asking for it. What the resolve does to a
 * picture is measured on real GPUs in webgpu-parity.test.ts and
 * webgl-parity.test.ts.
 */

import { describe, expect, it } from "vitest";

import { lockoutMeshSidecar, multiplyMat4, projectionMatrix, viewMatrix, type Mat4 } from "@cartbox/editor";
import { MODELS, MeshOverlaySurface, QUALITY_PRESETS, parseMeshScene, type SceneDraw, type SceneRenderer } from "@cartbox/player";

import { TEMPORAL_SAMPLES, TemporalState, halton, invertMat4, jitterProjection, temporalJitter } from "../packages/player/src/render/temporal";

const apply = (m: Mat4, p: readonly number[]) => [0, 1, 2, 3].map((r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]! * p[3]!);

describe("the jitter", () => {
  it("is the Halton 2,3 sequence, centred on the pixel", () => {
    expect([1, 2, 3, 4].map((i) => halton(i, 2))).toEqual([0.5, 0.25, 0.75, 0.125]);
    expect(halton(1, 3)).toBeCloseTo(1 / 3);
    expect(halton(2, 3)).toBeCloseTo(2 / 3);
    expect(temporalJitter(0)).toEqual([0, 1 / 3 - 0.5]);
  });

  it("cycles through eight distinct offsets inside the pixel, averaging near its centre", () => {
    const offsets = Array.from({ length: TEMPORAL_SAMPLES }, (_, i) => temporalJitter(i));
    expect(new Set(offsets.map((o) => o.join())).size).toBe(TEMPORAL_SAMPLES);
    for (const [x, y] of offsets) {
      expect(Math.abs(x)).toBeLessThan(0.5);
      expect(Math.abs(y)).toBeLessThan(0.5);
    }
    expect(temporalJitter(TEMPORAL_SAMPLES + 3)).toEqual(temporalJitter(3));
    const mean = offsets.reduce((m, [x, y]) => [m[0]! + x / TEMPORAL_SAMPLES, m[1]! + y / TEMPORAL_SAMPLES], [0, 0]);
    expect(Math.abs(mean[0]!)).toBeLessThan(0.1);
    expect(Math.abs(mean[1]!)).toBeLessThan(0.1);
  });

  it("moves every projected point by the same sub-pixel offset, perspective or orthographic", () => {
    const perspective = projectionMatrix(1, 4 / 3, 0.1, 100);
    const ortho: Mat4 = [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, -0.1, 0, 0, 0, -1, 1] as unknown as Mat4;
    for (const projection of [perspective, ortho]) {
      const jittered = jitterProjection(projection, [0.25, -0.5], 64, 48);
      for (const point of [[0, 0, -1, 1], [3, -2, -10, 1], [-1, 1, -50, 1]]) {
        const a = apply(projection, point);
        const b = apply(jittered, point);
        expect(b[0]! / b[3]! - a[0]! / a[3]!).toBeCloseTo((2 * 0.25) / 64, 9);
        expect(b[1]! / b[3]! - a[1]! / a[3]!).toBeCloseTo((2 * -0.5) / 48, 9);
        expect(b[2]! / b[3]!).toBeCloseTo(a[2]! / a[3]!, 9); // depth untouched
      }
    }
  });
});

describe("the reprojection", () => {
  const projection = projectionMatrix(1, 4 / 3, 0.1, 100);

  it("inverts a view-projection", () => {
    const m = multiplyMat4(projection, viewMatrix([1, 2, 5], [0, 0, 0]));
    const identity = multiplyMat4(m, invertMat4(m)!);
    identity.forEach((v, i) => expect(v).toBeCloseTo(i % 5 === 0 ? 1 : 0, 9));
    expect(invertMat4([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as unknown as Mat4)).toBeNull();
  });

  it("starts without a history, then trusts it; a frame without it forgets", () => {
    const state = new TemporalState("ndc");
    const view = viewMatrix([0, 0, 4], [0, 0, 0]);
    expect(state.begin(view, projection, 64, 48).uniforms[18]).toBe(0);
    expect(state.begin(view, projection, 64, 48).uniforms[18]).toBe(1);
    state.reset();
    expect(state.begin(view, projection, 64, 48).uniforms[18]).toBe(0);
  });

  it("maps a pixel to itself for a still camera, whatever the jitter", () => {
    const state = new TemporalState("ndc");
    const view = viewMatrix([0, 1, 4], [0, 0, 0]);
    state.begin(view, projection, 64, 48);
    for (let i = 0; i < 4; i += 1) {
      const { uniforms } = state.begin(view, projection, 64, 48);
      const p = apply(uniforms.subarray(0, 16) as unknown as Mat4, [0.3, -0.2, 0.9, 1]);
      expect(p[0]! / p[3]!).toBeCloseTo(0.3, 4);
      expect(p[1]! / p[3]!).toBeCloseTo(-0.2, 4);
    }
  });

  it("finds where a point was last frame when the camera moves", () => {
    const state = new TemporalState("ndc");
    const before = viewMatrix([0, 0, 4], [0, 0, 0]);
    const after = viewMatrix([0.5, 0.2, 4], [0.5, 0.2, 0]);
    state.begin(before, projection, 64, 48);
    const { uniforms } = state.begin(after, projection, 64, 48);
    // A world point, seen through both cameras: the reprojection carries the one to the other.
    const world = [0.7, -0.4, -1.5, 1];
    const now = apply(multiplyMat4(projection, after), world);
    const then = apply(multiplyMat4(projection, before), world);
    const ndc = [now[0]! / now[3]!, now[1]! / now[3]!, now[2]! / now[3]!, 1];
    const p = apply(uniforms.subarray(0, 16) as unknown as Mat4, ndc);
    expect(p[0]! / p[3]!).toBeCloseTo(then[0]! / then[3]!, 4);
    expect(p[1]! / p[3]!).toBeCloseTo(then[1]! / then[3]!, 4);
  });

  it("tells the shader how the depth is stored", () => {
    const view = viewMatrix([0, 0, 4], [0, 0, 0]);
    expect(new TemporalState("ndc").begin(view, projection, 64, 48).uniforms[19]).toBe(0);
    expect(new TemporalState("unit").begin(view, projection, 64, 48).uniforms[19]).toBe(1);
  });
});

describe("the cap, the presets and the overlay", () => {
  it("is on for the Xbox 360 and Modern tiers, and the high and medium presets", () => {
    expect(MODELS.xbox360.renderCaps.temporal).toBe(true);
    expect(MODELS.modern.renderCaps.temporal).toBe(true);
    for (const id of ["classic", "pro", "portrait", "voxel", "ps1", "n64"] as const) expect(MODELS[id].renderCaps.temporal).not.toBe(true);
    expect(QUALITY_PRESETS.high.temporal).toBe(true);
    expect(QUALITY_PRESETS.medium.temporal).toBe(true);
    expect(QUALITY_PRESETS.low.temporal).toBe(false);
  });

  it("asks the renderer for it only when the cap and the quality both allow it", async () => {
    const lockout = JSON.parse(lockoutMeshSidecar());
    const raw = JSON.stringify({ version: 2, meshes: [lockout.meshes[1]], library: lockout.library, lighting: null });
    const drawWith = async (temporal: boolean | undefined, quality: keyof typeof QUALITY_PRESETS) => {
      const seen: SceneDraw[] = [];
      const renderer: SceneRenderer = { backend: "software", render: (_, draw) => void seen.push(draw), dispose: () => {} };
      const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, parseMeshScene(raw)!, renderer, temporal === undefined ? {} : { temporal });
      surface.setQuality(QUALITY_PRESETS[quality]);
      surface.blit(new Uint8Array(16 * 16 * 4));
      return seen.at(-1)!.temporal;
    };
    expect(await drawWith(true, "high")).toBe(true);
    expect(await drawWith(true, "medium")).toBe(true);
    expect(await drawWith(true, "low")).toBe(false);
    expect(await drawWith(false, "high")).toBe(false);
    expect(await drawWith(undefined, "high")).toBe(false);
  });
});
