/**
 * The post-process stack's WebGPU port (AAA_FIDELITY_ROADMAP.md F0a) against
 * the WebGL pass it ports, in a real browser: the same frame and settings
 * through both, and the pictures must agree — Lockout's authored stack, and
 * every effect at once. Skips without Playwright's Chromium.
 *
 * On SwiftShader the two agree to within a level (Lockout's stack) or exactly
 * (every effect). The bounds leave room for a GPU whose WebGL runs at mediump
 * or blooms in 8-bit targets where the port keeps half-floats — and stay far
 * short of an effect left out, applied in the wrong order or sampled the wrong
 * way up.
 */

import { existsSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LOCKOUT_FX } from "@cartbox/editor";

 

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
let server: Server | null = null;
let webgpu = false;

interface PostReport {
  mean: number;
  max: number;
  over8: number;
  changed: number;
  error?: string;
}

describe.skipIf(!chromiumPath)("the post-process stack on WebGPU, against WebGL", () => {
  beforeAll(async () => {
    const esbuild = await import("esbuild");
    const here = fileURLToPath(new URL(".", import.meta.url));
    const bundle = await esbuild.build({ entryPoints: [join(here, "helpers/gpuPostFxHarness.ts")], bundle: true, write: false, format: "iife", target: "es2022", logLevel: "silent" });
    // WebGPU needs a secure context: a page from localhost is one.
    server = createServer((_, res) => res.end("<!doctype html><html><body></body></html>"));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      executablePath: chromiumPath!,
      headless: true,
      args: ["--no-sandbox", "--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--enable-features=Vulkan", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    webgpu = await page.evaluate(async () => Boolean(await (navigator as any).gpu?.requestAdapter?.()));
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  const run = (which: number): Promise<PostReport> => page.evaluate(([w, fx]: [number, unknown]) => (globalThis as any).runPost(w, fx), [which, LOCKOUT_FX]);

  it("finishes a frame through Lockout's stack as the WebGL pass does", async () => {
    if (!webgpu) return;
    const report = await run(0);
    expect(report.error).toBeUndefined();
    expect(report.changed).toBeGreaterThan(2000); // the stack does something
    expect(report.mean).toBeLessThan(0.5);
    expect(report.max).toBeLessThanOrEqual(6);
  }, 60_000);

  it("and through every effect at once", async () => {
    if (!webgpu) return;
    const report = await run(1);
    expect(report.error).toBeUndefined();
    expect(report.changed).toBeGreaterThan(5000);
    expect(report.mean).toBeLessThan(0.5);
    expect(report.over8).toBe(0);
  }, 60_000);
});
