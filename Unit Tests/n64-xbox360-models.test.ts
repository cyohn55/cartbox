/**
 * The N64 and Xbox 360 era models — spec, caps, and that the built cores match.
 *
 * Like the PS1 spec tests, these do not re-assert literals for their own sake;
 * they prove the relationships the renderer and the roadmap's doctrine depend
 * on. Two things matter most here:
 *
 *  - N64 is a *true* fixed-spec era model: its caps make it look like the N64
 *    (depth-buffered, perspective-correct, filtered, starved of texture memory),
 *    and — unlike PS1 — the WebGPU path can honour them, so it keeps the GPU.
 *  - Xbox 360 is the honest outlier the roadmap calls "not console-shaped": the
 *    only model whose caps grant programmable shaders and lift every budget.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { N64_MODEL, XBOX360_MODEL, type ConsoleModelSpec } from "@cartbox/editor";
import {
  MODELS,
  SOFTWARE_RASTER_CAPS,
  framebufferBytes,
  getModel,
  rasterStyleFor,
  webgpuCanHonour,
} from "@cartbox/player";

const n64 = MODELS.n64;
const xbox360 = MODELS.xbox360;

describe("the N64 model", () => {
  it("is resolvable and shares the PS1's 320x240 frame", () => {
    // The generations differed in rendering, not resolution; the era lives in
    // renderCaps, so the frame is deliberately the PS1's.
    expect(getModel("n64")).toBe(n64);
    expect([n64.width, n64.height]).toEqual([320, 240]);
    expect(n64.kind).toBe("poly3d");
    expect(framebufferBytes(n64)).toBe(320 * 240 * 4);
  });

  it("adds everything the PS1 lacked, and starves texture memory", () => {
    // The roadmap's PS1/N64 table, as caps: the N64 fixed the artefacts (depth,
    // perspective, float) and paid with a 4KB texture cache — the defining trait.
    expect(n64.renderCaps.zBuffer).toBe(true);
    expect(n64.renderCaps.perspectiveCorrect).toBe(true);
    expect(n64.renderCaps.vertexPrecision).toBe("float");
    expect(n64.renderCaps.textureFiltering).toBe("trilinear");
    expect(n64.renderCaps.textureCacheBytes).toBe(4 * 1024);
    expect(n64.renderCaps.programmableShaders).toBe(false);
  });

  it("differs from PS1, so the two eras are not the same machine", () => {
    expect(n64.renderCaps).not.toEqual(MODELS.ps1.renderCaps);
  });

  it("is the tier that keeps the GPU, unlike PS1", () => {
    // webgpuCanHonour needs z-buffer + perspective + float — N64 has all three,
    // PS1 none. This is the split renderCaps.ts documents: PS1 falls to the
    // software rasteriser, N64 is exactly what the WebGPU path is for.
    expect(webgpuCanHonour(rasterStyleFor(n64.renderCaps))).toBe(true);
    expect(webgpuCanHonour(rasterStyleFor(MODELS.ps1.renderCaps))).toBe(false);
  });

  it("is a cartridge, not a disc — less storage than the PS1", () => {
    // The era-true inversion: better rendering, an order of magnitude less
    // storage. 64MB was the largest cartridge the generation shipped.
    expect(n64.assetBudgetBytes).toBe(64 * 1024 * 1024);
    expect(n64.assetBudgetBytes).toBeLessThan(MODELS.ps1.assetBudgetBytes);
  });

  it("agrees between runtime and authoring specs", () => {
    const authoring: ConsoleModelSpec = N64_MODEL;
    expect([authoring.width, authoring.height]).toEqual([n64.width, n64.height]);
    expect(authoring.paletteSize).toBe(n64.paletteSize);
    expect(authoring.id).toBe(n64.id);
    expect(authoring.kind).toBe(n64.kind);
  });
});

describe("the Xbox 360 model", () => {
  it("is the family's first HD frame, 1280x720 16:9", () => {
    expect(getModel("xbox360")).toBe(xbox360);
    expect([xbox360.width, xbox360.height]).toEqual([1280, 720]);
    expect(xbox360.width / xbox360.height).toBeCloseTo(16 / 9, 10);
    expect(framebufferBytes(xbox360)).toBe(1280 * 720 * 4);
  });

  it("does not yet claim programmable shaders", () => {
    // The 360 is the tier programmable shaders belong to, but the flag stays
    // false until a shader-authoring surface actually exists: setting it now
    // would claim a capability nothing consumes and break the platform's
    // fixed-spec guarantee (see render-caps.test.ts) for no gain. It flips the
    // day the shader pipeline lands; until then no shipping model grants it.
    expect(xbox360.renderCaps.programmableShaders).toBe(false);
    const withShaders = Object.values(MODELS).filter((m) => m.renderCaps.programmableShaders);
    expect(withShaders.map((m) => m.id)).toEqual([]);
  });

  it("lifts the per-frame budgets the era models enforce", () => {
    // The tier where storage and fill stop being the constraint: 0 means
    // unbounded for both caps that bind PS1 and N64.
    expect(xbox360.renderCaps.textureCacheBytes).toBe(0);
    expect(xbox360.renderCaps.polyBudget).toBe(0);
  });

  it("keeps the modern render path and the GPU", () => {
    expect(webgpuCanHonour(rasterStyleFor(xbox360.renderCaps))).toBe(true);
  });

  it("agrees between runtime and authoring specs, on the 8px tile grid", () => {
    const authoring: ConsoleModelSpec = XBOX360_MODEL;
    expect([authoring.width, authoring.height]).toEqual([xbox360.width, xbox360.height]);
    expect(authoring.screenWidth).toBe(xbox360.width / 8);
    expect(authoring.screenHeight).toBe(xbox360.height / 8);
    expect(xbox360.width % 8).toBe(0);
    expect(xbox360.height % 8).toBe(0);
  });
});

describe("the era models as a family", () => {
  it("are the three triangle-scene models", () => {
    const poly = Object.values(MODELS)
      .filter((m) => m.kind === "poly3d")
      .map((m) => m.id)
      .sort();
    expect(poly).toEqual(["n64", "ps1", "xbox360"]);
  });

  it("leave the 2D models on the stock software caps", () => {
    // Adding 3D eras must not perturb the 2D models: they still declare the
    // rasteriser's defaults, since nothing overrides them.
    for (const id of ["classic", "pro", "portrait"] as const) {
      expect(MODELS[id].renderCaps).toEqual(SOFTWARE_RASTER_CAPS);
    }
  });
});

/**
 * The built cores. Skips when they are absent, like the other engine tests.
 * Build with: node scripts/prepare-tic80.mjs && npm run engine:build:n64
 * (and :xbox360). Requires Emscripten 3.1.x — see the build scripts.
 */
const coreUrl = (model: string) =>
  fileURLToPath(new URL(`../packages/engine/dist/${model}/engine.js`, import.meta.url));

const N64_CORE = coreUrl("n64");
const XBOX360_CORE = coreUrl("xbox360");
const PS1_CORE = coreUrl("ps1");
const built = existsSync(N64_CORE) && existsSync(XBOX360_CORE) && existsSync(PS1_CORE);
const suite = built ? describe : describe.skip;
if (!built) {
  console.warn("[n64-xbox360-models] cores not all built; skipping core checks.");
}

interface Core {
  _cbx_create(sampleRate: number): number;
  _cbx_tick(handle: number, gamepad: number): void;
  _cbx_screen_ptr(handle: number): number;
  _cbx_cart_bytesize(): number;
  _cbx_cart_music_track_stride(): number;
}
async function load(path: string): Promise<Core> {
  const glue = (await import(pathToFileURL(path).href)) as { default: () => Promise<Core> };
  return glue.default();
}

suite("the built N64 and Xbox 360 cores", () => {
  let n64core: Core;
  let xboxcore: Core;
  let ps1core: Core;
  beforeAll(async () => {
    [n64core, xboxcore, ps1core] = await Promise.all([load(N64_CORE), load(XBOX360_CORE), load(PS1_CORE)]);
  }, 60_000);

  it("ship the Safari-safe 3.1.x glue, not the newer scheme import", async () => {
    // The bug that broke PS1 on iPad: newer Emscripten emits `import("node:module")`
    // and a bare top-level factory older WebKit cannot load. These cores must be
    // built with the same 3.1.x toolchain as the rest.
    const { readFile } = await import("node:fs/promises");
    for (const path of [N64_CORE, XBOX360_CORE]) {
      const glue = await readFile(path, "utf8");
      expect(glue).not.toContain("node:module");
      expect(glue).toMatch(/=\s*\(\(\)\s*=>\s*\{/); // the IIFE factory wrapper
    }
  });

  it("build the N64 core at the PS1's spec — same core, different renderCaps", () => {
    // N64 and PS1 share resolution, palette and sound, so their *cores* are
    // spec-identical; the era difference is entirely in the player's renderCaps.
    // This pins that they really do share the core spec rather than drifting.
    expect(n64core._cbx_cart_bytesize()).toBe(ps1core._cbx_cart_bytesize());
    expect(n64core._cbx_screen_ptr(n64core._cbx_create(44100))).not.toBe(0);
  });

  it("build the 360 core at a larger memory map for its HD frame", () => {
    // 1280x720 is far more than 320x240, so its cartridge/framebuffer memory
    // map is correspondingly larger — proof the -D resolution reached the core.
    expect(xboxcore._cbx_cart_bytesize()).toBeGreaterThan(ps1core._cbx_cart_bytesize());
  });

  it("run the 360 core for many frames without trapping", () => {
    // The 720p frame's per-scanline draw buffers are the largest in the family;
    // this is the check that STACK_SIZE is big enough (the regression the PS1
    // build script raised it for, now at double the height).
    const handle = xboxcore._cbx_create(44100);
    expect(handle).not.toBe(0);
    expect(() => {
      for (let f = 0; f < 240; f += 1) xboxcore._cbx_tick(handle, 0);
    }).not.toThrow();
  });

  it("carry the eight-channel sound spec, like the other 3D cores", () => {
    expect(n64core._cbx_cart_music_track_stride()).toBe(ps1core._cbx_cart_music_track_stride());
    expect(xboxcore._cbx_cart_music_track_stride()).toBe(ps1core._cbx_cart_music_track_stride());
  });
});
