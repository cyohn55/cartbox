/**
 * Anti-aliasing (HALO_INFINITE_STYLE_ROADMAP.md I1): a render cap on the
 * Xbox 360 and Modern tiers, allowed by the high and medium graphics presets,
 * asked of the scene renderer by the mesh overlay only when both agree, and
 * the held weapon's outline feathered where the software rasteriser draws it.
 * The GPU renderers' multisampling itself is checked on real devices in
 * webgl-parity.test.ts and webgpu-parity.test.ts.
 */

import { describe, expect, it } from "vitest";

import { lockoutMeshSidecar } from "@cartbox/editor";
import { MODELS, MeshOverlaySurface, QUALITY_PRESETS, parseMeshScene, smoothFrontEdges, type SceneDraw, type SceneRenderer } from "@cartbox/player";

describe("the cap and the presets", () => {
  it("is on for the Xbox 360 and Modern tiers and off for the retro ones", () => {
    expect(MODELS.xbox360.renderCaps.antialias).toBe(true);
    expect(MODELS.modern.renderCaps.antialias).toBe(true);
    for (const id of ["classic", "pro", "portrait", "voxel", "ps1", "n64"] as const) expect(MODELS[id].renderCaps.antialias).not.toBe(true);
  });

  it("is allowed by the high and medium presets and not the low one", () => {
    expect(QUALITY_PRESETS.high.antialias).toBe(true);
    expect(QUALITY_PRESETS.medium.antialias).toBe(true);
    expect(QUALITY_PRESETS.low.antialias).toBe(false);
  });
});

describe("the overlay", () => {
  /** Lockout's soldier alone, as a one-object scene. */
  function soldierScene(): string {
    const lockout = JSON.parse(lockoutMeshSidecar());
    return JSON.stringify({ version: 2, meshes: [lockout.meshes[1]], library: lockout.library, lighting: null });
  }

  async function drawWith(antialias: boolean | undefined, quality: keyof typeof QUALITY_PRESETS): Promise<SceneDraw> {
    const scene = parseMeshScene(soldierScene())!;
    const seen: SceneDraw[] = [];
    const renderer: SceneRenderer = { backend: "software", render: (_, draw) => void seen.push(draw), dispose: () => {} };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer, antialias === undefined ? {} : { antialias });
    surface.setQuality(QUALITY_PRESETS[quality]);
    surface.blit(new Uint8Array(16 * 16 * 4));
    return seen.at(-1)!;
  }

  it("asks the renderer to anti-alias only when the cap and the quality both allow it", async () => {
    expect((await drawWith(true, "high")).antialias).toBe(true);
    expect((await drawWith(true, "medium")).antialias).toBe(true);
    expect((await drawWith(true, "low")).antialias).toBe(false);
    expect((await drawWith(false, "high")).antialias).toBe(false);
    expect((await drawWith(undefined, "high")).antialias).toBe(false);
  });
});

describe("the held weapon's outline", () => {
  /** A 6×6 grey frame with a white 2×2 front-layer square at (2,2). */
  function frame(): { out: Uint8ClampedArray; depth: Float32Array } {
    const out = new Uint8ClampedArray(6 * 6 * 4);
    const depth = new Float32Array(6 * 6).fill(Infinity);
    for (let i = 0; i < 36; i += 1) out.set([60, 60, 60, 255], i * 4);
    for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3]] as const) {
      out.set([240, 240, 240, 255], (y * 6 + x) * 4);
      depth[y * 6 + x] = 0.5;
    }
    return { out, depth };
  }

  it("blends the pixels on both sides of the boundary and nothing else", () => {
    const { out, depth } = frame();
    smoothFrontEdges(out, depth, 6, 6, new Uint8ClampedArray(out.length));
    const at = (x: number, y: number) => out[(y * 6 + x) * 4]!;
    // Inside, each corner pixel has two front neighbours of four: (2·240 + 2·240 + 2·60) / 6.
    expect(at(2, 2)).toBe(Math.round((2 * 240 + 2 * 240 + 2 * 60) / 6));
    // Just outside, one front neighbour: (2·60 + 240 + 3·60) / 6.
    expect(at(1, 2)).toBe(Math.round((2 * 60 + 240 + 3 * 60) / 6));
    expect(at(2, 1)).toBe(at(1, 2));
    // Away from the boundary (and diagonal corners, which share no edge) nothing moves.
    expect(at(0, 0)).toBe(60);
    expect(at(1, 1)).toBe(60);
    expect(at(5, 5)).toBe(60);
    // Alpha is left alone.
    for (let i = 0; i < 36; i += 1) expect(out[i * 4 + 3]).toBe(255);
  });

  it("leaves a frame with no front layer untouched", () => {
    const { out } = frame();
    const before = out.slice();
    smoothFrontEdges(out, new Float32Array(36).fill(Infinity), 6, 6, new Uint8ClampedArray(out.length));
    expect(out).toEqual(before);
  });
});
