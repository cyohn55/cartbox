/**
 * The grading LUT's shader (HALO_INFINITE_STYLE_ROADMAP.md I8) in a real
 * browser: the post-process pass draws a frame of 4,096 colours through each
 * built-in look, a blend of one, and an imported `.cube`, and every pixel must
 * land within a few levels of the CPU reference (applyLut) — the strip
 * texture's bilinear red/green and the hand-mixed blue slices are trilinear.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LUT_LOOKS } from "@cartbox/player";

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

interface LutReport {
  maxDelta: number;
  far: number;
  changed: number;
  error?: string;
}

/** A 2-step `.cube` that swaps red and blue. */
const SWAP_CUBE = ["TITLE \"swap\"", "LUT_3D_SIZE 2", ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${b} ${g} ${r}`)))].join("\n");

describe.skipIf(!chromiumPath)("the grading LUT in a real browser", () => {
  beforeAll(async () => {
    const esbuild = await import("esbuild");
    const here = fileURLToPath(new URL(".", import.meta.url));
    const bundle = await esbuild.build({ entryPoints: [join(here, "helpers/postFxLutHarness.ts")], bundle: true, write: false, format: "iife", target: "es2022", logLevel: "silent" });
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ executablePath: chromiumPath!, headless: true, args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    page = await browser.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  const run = (look: number, strength: number, cube: string | null = null): Promise<LutReport> =>
    page.evaluate(([l, s, c]: [number, number, string | null]) => (globalThis as unknown as { runLut: (l: number, s: number, c: string | null) => LutReport }).runLut(l, s, c), [look, strength, cube]);

  it("grades every colour as the CPU reference does, through every built-in look", async () => {
    for (let look = 0; look < LUT_LOOKS.length - 1; look += 1) {
      const report = await run(look, 1);
      expect(report.error, LUT_LOOKS[look]).toBeUndefined();
      expect(report.changed, LUT_LOOKS[look]).toBeGreaterThan(500); // it does grade
      expect(report.maxDelta, LUT_LOOKS[look]).toBeLessThanOrEqual(3);
    }
  }, 60_000);

  it("blends by strength", async () => {
    const report = await run(0, 0.5);
    expect(report.maxDelta).toBeLessThanOrEqual(3);
  }, 30_000);

  it("reads an imported .cube", async () => {
    const report = await run(0, 1, SWAP_CUBE);
    expect(report.error).toBeUndefined();
    expect(report.changed).toBeGreaterThan(2000); // red and blue swapped nearly everywhere
    expect(report.maxDelta).toBeLessThanOrEqual(3);
  }, 30_000);
});
