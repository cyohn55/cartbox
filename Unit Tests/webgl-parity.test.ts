/**
 * WebGL2 parity against the software rasteriser, in a real browser.
 *
 * The WebGL2 renderer is the GPU path for browsers without WebGPU, and like the
 * WebGPU one its contract is that a cart looks the same whichever path draws it:
 * byte-identical on the fantasy tiers, within a few 8-bit levels on the Modern
 * PBR branch (float32 against float64). This bundles a harness with esbuild,
 * runs it in headless Chromium (WebGL2 through ANGLE on software Vulkan when
 * there is no GPU), and compares frames.
 *
 * It skips when Playwright's Chromium isn't installed (as on CI); locally it
 * runs wherever `PLAYWRIGHT_BROWSERS_PATH` points at a Chromium build.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { expectTemporal, type TemporalReport } from "./helpers/temporalScene";
import { expectReflections, type ReflectionReport } from "./helpers/reflectionScene";

function findChromium(): string | null {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return null;
  for (const dir of readdirSync(root).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
    for (const bin of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
      const path = join(root, dir, bin);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

const chromiumPath = findChromium();

let browser: any = null;
let page: any = null;

/**
 * Chromium's WebGL2 prefers ANGLE on Vulkan: with Mesa's software Vulkan
 * (llvmpipe) that rasterises like hardware (8-bit subpixel precision), and the
 * frames must match exactly. Without Vulkan it falls back to SwiftShader, whose
 * coarser edge precision moves a few edge pixels — there the test only bounds
 * how many (a missing draw or a broken shader still fails it by a wide margin).
 */
const GL_ARGS = process.env.CARTBOX_GL_ARGS?.split(" ") ?? ["--use-angle=vulkan", "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"];

interface Parity {
  drawn: number;
  differing: number;
  maxDelta: number;
  /** Pixels off by more than 8 in some channel. */
  far: number;
  /** Pixels one side drew and the other didn't. */
  coverage: number;
  stats: { drawCalls: number; instances: number; triangles: number; gpuMs: number | null };
  backend: string;
  diffs: string[];
}

let exact = true;

describe.skipIf(!chromiumPath)("WebGL2 parity in a real browser", () => {
  beforeAll(async () => {
    const esbuild = await import("esbuild");
    const here = fileURLToPath(new URL(".", import.meta.url));
    const bundle = await esbuild.build({
      entryPoints: [join(here, "helpers/webglParityHarness.ts")],
      bundle: true,
      write: false,
      format: "iife",
      target: "es2022",
      alias: { "@cartbox/editor": join(here, "../packages/editor/src/index.ts") },
      logLevel: "silent",
    });
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true, args: ["--no-sandbox", ...GL_ARGS] });
    page = await browser.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    const renderer: string = await page.evaluate(() => (globalThis as unknown as { glRenderer: () => string }).glRenderer());
    exact = !/SwiftShader/i.test(renderer);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  const run = (name: string): Promise<Parity> =>
    page.evaluate((n: string) => (globalThis as unknown as { runParity: (n: string) => Promise<Parity> }).runParity(n), name);

  /** Exact where the rasteriser allows it; otherwise at most `share` of the drawn pixels' bytes differ. */
  const expectMatch = (result: Parity, share = 0.03) => {
    expect(result.drawn, JSON.stringify(result.diffs)).toBeGreaterThan(100);
    if (exact) expect(result.differing, JSON.stringify(result.diffs)).toBe(0);
    else expect(result.differing, JSON.stringify(result.diffs)).toBeLessThanOrEqual(Math.ceil(result.drawn * 4 * share));
  };

  const antialiasedFrame = (name: string): Promise<{ out: number[]; error: number }> =>
    page.evaluate((n: string) => (globalThis as unknown as { runFrame: (n: string, aa: boolean) => Promise<never> }).runFrame(n, true), name);

  const antialiased = (name: string): Promise<{ changed: number; offEdge: number; outside: number; drawn: number; errors: number[] }> =>
    page.evaluate((n: string) => (globalThis as unknown as { runAntialias: (n: string) => Promise<never> }).runAntialias(n), name);

  it("anti-aliases (I1): multisampling smooths edges and nothing else", async () => {
    for (const name of ["fantasy", "transparent", "soft"]) {
      const result = await antialiased(name);
      expect(result.errors, name).toEqual([0, 0]); // no GL error, the soft scene's depth copy from the multisampled frame included
      expect(result.drawn, name).toBeGreaterThan(100);
      expect(result.changed, name).toBeGreaterThan(10); // the edges did change
      expect(result.offEdge, name).toBe(0); // and only edges did
      expect(result.outside, name).toBe(0); // each to a blend of the colours either side
    }
  }, 60_000);

  it("anti-aliases temporally (I2): converges, survives a pan, and stops the crawl", async () => {
    for (const antialias of [false, true]) {
      const result = await page.evaluate((a: boolean) => (globalThis as unknown as { runTemporal: (a: boolean) => Promise<never> }).runTemporal(a), antialias);
      expect(result, `antialias ${antialias}`).not.toHaveProperty("error");
      const { report, supported, errors } = result as { report: TemporalReport; supported: boolean; errors: number[] };
      expect(supported).toBe(true); // the context renders half floats
      expect(errors).toEqual([0]);
      expectTemporal(report);
    }
  }, 120_000);

  it("reflects in screen space (I3): the panels show in the floor, each on its side, and nothing else changes", async () => {
    for (const extra of [{}, { antialias: true }, { antialias: true, temporal: true }]) {
      const result = await page.evaluate((e: object) => (globalThis as unknown as { runReflections: (e: object) => Promise<never> }).runReflections(e), extra);
      expect(result, JSON.stringify(extra)).not.toHaveProperty("error");
      const { report, supported, errors } = result as { report: ReflectionReport; supported: boolean; errors: number[] };
      expect(supported).toBe(true); // the context renders half floats
      expect(errors).toEqual([0]);
      expectReflections(report);
    }
  }, 120_000);

  it("renders the fantasy path byte-identically", async () => {
    const result = await run("fantasy");
    expect(result.backend).toBe("webgl2");
    expectMatch(result);
  });

  it("renders instanced copies byte-identically, one draw per batch", async () => {
    const result = await run("instanced");
    expect(result.stats).toMatchObject({ drawCalls: 2, instances: 9 });
    expect(result.stats.triangles).toBeGreaterThan(0);
    expectMatch(result);
  });

  it("splits a batch larger than a uniform block into several draws", async () => {
    const result = await run("chunked");
    // 150 copies: 50 textured (one draw) and 100 untextured (two draws of ≤ 64).
    expect(result.stats).toMatchObject({ drawCalls: 3, instances: 150 });
    // Quads under 3 pixels across: even a hardware-precision rasteriser may
    // cover an edge pixel the software one doesn't, so allow two. A dropped
    // chunk would leave dozens of copies missing.
    expect(result.drawn).toBeGreaterThan(100);
    expect(result.differing, JSON.stringify(result.diffs)).toBeLessThanOrEqual(exact ? 8 : Math.ceil(result.drawn * 4 * 0.03));
  });

  it("matches the metallic-roughness path within float tolerance", async () => {
    const result = await run("pbr");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) expect(result.maxDelta).toBeLessThanOrEqual(4);
  });

  it("matches multi-light forward shading within float tolerance", async () => {
    const result = await run("lights");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) expect(result.maxDelta).toBeLessThanOrEqual(4);
  });

  it("samples the shadow map identically on the fantasy path", async () => {
    expectMatch(await run("shadowFantasy"));
  });

  it("matches directional shadows on the PBR path within float tolerance", async () => {
    const result = await run("shadow");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) expect(result.maxDelta).toBeLessThanOrEqual(4);
  });

  it("matches shield effects within float tolerance, dropping the same camo pixels", async () => {
    const result = await run("effects");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) {
      expect(result.coverage, JSON.stringify(result.diffs)).toBe(0);
      expect(result.maxDelta).toBeLessThanOrEqual(4);
    }
  });

  it("settles to the newest frame without rendering again", async () => {
    const result = await page.evaluate((n: string) => (globalThis as unknown as { settleOnce: (n: string) => Promise<{ states: string[]; differing: number; drawn: number }> }).settleOnce(n), "fantasy");
    expect(result.states.at(-1)).toBe("current");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) expect(result.differing).toBe(0);
  });

  it("draws transparency like the software rasteriser: blended, added and cut out", async () => {
    const result = await run("transparent");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) {
      expect(result.coverage, JSON.stringify(result.diffs)).toBe(0);
      expect(result.maxDelta).toBeLessThanOrEqual(5);
    }
  });

  it("fades soft see-through edges where they meet the floor, like the software rasteriser", async () => {
    const result = await run("soft");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) {
      expect(result.coverage, JSON.stringify(result.diffs)).toBe(0);
      expect(result.maxDelta).toBeLessThanOrEqual(5);
    }
  });

  it("runs material graphs like the software rasteriser: noise, fresnel, maths and a scrolling texture", async () => {
    const result = await run("graph");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) {
      expect(result.coverage, JSON.stringify(result.diffs)).toBe(0);
      expect(result.maxDelta).toBeLessThanOrEqual(6);
    }
  });

  it("shades clearcoat, brushed metal, parallax relief and wear masks like the software rasteriser (I4)", async () => {
    for (const name of ["layers", "layersLit"]) {
      const result = await run(name);
      expect(result.drawn, name).toBeGreaterThan(400);
      if (exact) {
        expect(result.coverage, JSON.stringify(result.diffs)).toBe(0);
        // The parallax march steps by the screen's UV derivatives on the GPU and
        // the triangle's exact gradients on the CPU, so a step can land on the
        // other side of a relief texel: a few pixels may differ, the rest match.
        expect(result.far, JSON.stringify(result.diffs)).toBeLessThanOrEqual(result.drawn * 0.03);
      }
    }
  });

  it("bends what's behind glass, heat haze, camo and a shield's edge like the software rasteriser (I5)", async () => {
    const result = await run("refraction");
    expect(result.drawn).toBeGreaterThan(400);
    if (exact) {
      expect(result.coverage, JSON.stringify(result.diffs)).toBe(0);
      // The warp's noise is float32 on the GPU and float64 on the CPU, so an
      // offset that lands on a texel edge can round the other way: a few
      // pixels may take the next stripe over, the rest match.
      expect(result.far, JSON.stringify(result.diffs)).toBeLessThanOrEqual(result.drawn * 0.03);
    }
    // Anti-aliased, the opaque scene is resolved before it is read: the bend still shows, with no GL error.
    const bent = await antialiasedFrame("refraction");
    const straight = await antialiasedFrame("refractionStraight");
    expect(bent.error).toBe(0);
    let changed = 0;
    for (let i = 0; i < bent.out.length; i += 4) if (Math.abs(bent.out[i]! - straight.out[i]!) + Math.abs(bent.out[i + 2]! - straight.out[i + 2]!) > 30) changed += 1;
    expect(changed).toBeGreaterThan(30);
  });

  it("shades forty point lights and four spots through the light clusters like the software rasteriser", async () => {
    const result = await run("manyLights");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) {
      expect(result.coverage, JSON.stringify(result.diffs)).toBe(0);
      expect(result.maxDelta).toBeLessThanOrEqual(4);
    }
  });

  it("picks the near shadow cascade where it covers a point, the main map elsewhere, like the software rasteriser", async () => {
    const result = await run("cascade");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) {
      expect(result.coverage, JSON.stringify(result.diffs)).toBe(0);
      expect(result.maxDelta).toBeLessThanOrEqual(4);
    }
  });

  it("casts spot and point light shadows like the software rasteriser", async () => {
    const result = await run("localShadows");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) {
      expect(result.coverage, JSON.stringify(result.diffs)).toBe(0);
      expect(result.maxDelta).toBeLessThanOrEqual(4);
    }
  });

  it("lights surfaces without light maps from the probe grid like the software rasteriser", async () => {
    const result = await run("probes");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) {
      expect(result.coverage, JSON.stringify(result.diffs)).toBe(0);
      expect(result.maxDelta).toBeLessThanOrEqual(4);
    }
  });

  it("matches distance fog within float tolerance", async () => {
    const result = await run("fog");
    expect(result.drawn).toBeGreaterThan(100);
    if (exact) expect(result.maxDelta).toBeLessThanOrEqual(4);
  });
});
