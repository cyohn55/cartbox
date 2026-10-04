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

  it("shades forty point lights and four spots through the light clusters like the software rasteriser", async () => {
    const result = await run("manyLights");
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
