/**
 * Unit tests for the game-bundle CDN rewrites in apps/web/next.config.mjs.
 *
 * These rewrites are the only thing standing between a deployed app and every
 * emulated game 404ing: the bundles are gitignored and never built on Vercel,
 * so /cube2/bb.wasm exists solely as a rewrite to R2. The rewrite must also stay
 * *same-origin to the browser* — the iframe runtimes' input bridges reach into
 * the iframe's DOM, which a cross-origin redirect would break.
 *
 * The config reads process.env at module load, so each case re-imports it with a
 * fresh module registry rather than asserting against one cached evaluation.
 *
 * Run with: npx vitest run "Unit Tests/game-cdn-rewrites.test.ts"
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONFIG_URL = new URL("../apps/web/next.config.mjs", import.meta.url);

/** The bundle roots the config declares, read from its source. */
const BUNDLE_ROOTS: string[] = (() => {
  const source = readFileSync(fileURLToPath(CONFIG_URL), "utf8");
  const declaration = source.match(/const GAME_BUNDLE_ROOTS\s*=\s*\[([^\]]*)\]/);
  if (!declaration) throw new Error("GAME_BUNDLE_ROOTS not found");
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map(([, root]) => root);
})();

/** The roots the config marks as range-streamed, read from its source. */
const RANGE_STREAMED_ROOTS: string[] = (() => {
  const source = readFileSync(fileURLToPath(CONFIG_URL), "utf8");
  const declaration = source.match(/const RANGE_STREAMED_ROOTS\s*=\s*\[([^\]]*)\]/);
  if (!declaration) throw new Error("RANGE_STREAMED_ROOTS not found in next.config.mjs");
  return [...declaration[1].matchAll(/"([^"]+)"/g)].map(([, root]) => root);
})();

/** Loads next.config.mjs fresh under the given environment. */
async function loadConfig(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  vi.resetModules();
  // Cache-bust: the module registry is keyed by URL, and resetModules alone does
  // not always re-evaluate a module loaded by absolute URL.
  const module = await import(`${CONFIG_URL.href}?t=${Math.random()}`);
  return module.default;
}

/** The afterFiles rewrites, or [] when the config declares none. */
async function rewritesFor(env: Record<string, string | undefined>) {
  const config = await loadConfig(env);
  if (typeof config.rewrites !== "function") return [];
  return (await config.rewrites()).afterFiles;
}

describe("game bundle CDN rewrites", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.GAME_CDN_URL;
    delete process.env.NEXT_PUBLIC_STATIC_EXPORT;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("routes every bundle root to the CDN by default, with no env configured", async () => {
    // The regression this guards: the URL used to live only in a per-deployment
    // env var, so a host that had not set it served 404 for every game.
    const rewrites = await rewritesFor({});

    expect(rewrites).toHaveLength(BUNDLE_ROOTS.length);

    for (const root of BUNDLE_ROOTS) {
      const rule = rewrites.find((r: { source: string }) => r.source === `/${root}/:path*`);
      expect(rule, `no rewrite for /${root}`).toBeDefined();
      expect(rule.destination).toMatch(/^https:\/\/pub-[0-9a-f]+\.r2\.dev\//);
      expect(rule.destination).toBe(`${rule.destination.split(`/${root}/`)[0]}/${root}/:path*`);
    }
  });

  it("keeps the browser's request same-origin", async () => {
    // Sources must be app-relative paths; a cross-origin source would break the
    // iframe runtimes' same-origin input bridges.
    for (const rule of await rewritesFor({})) {
      expect(rule.source.startsWith("/")).toBe(true);
    }
  });

  it("lets a deployment override the bucket", async () => {
    const rewrites = await rewritesFor({ GAME_CDN_URL: "https://cdn.example.test" });

    for (const rule of rewrites) {
      expect(rule.destination.startsWith("https://cdn.example.test/")).toBe(true);
    }
  });

  it("strips a trailing slash so destinations never double up", async () => {
    const rewrites = await rewritesFor({ GAME_CDN_URL: "https://cdn.example.test/" });

    for (const rule of rewrites) {
      expect(rule.destination).not.toContain("//:path");
      expect(rule.destination).not.toContain(".test//");
    }
  });

  it("serves bundles from public/ when the CDN is explicitly disabled", async () => {
    expect(await rewritesFor({ GAME_CDN_URL: "" })).toEqual([]);
  });

  it("sends no-store only for the range-streamed roots", async () => {
    // Over-scoping this is a real regression, not a tidiness point: no-store on
    // every root tells the browser not to cache any bundle, so a launch
    // re-downloads C&C's 13MB zip or SuperTux's 162MB data file every time and
    // the game appears to hang on its loading screen.
    const config = await loadConfig({});
    const headers = await config.headers();

    expect(headers).toHaveLength(RANGE_STREAMED_ROOTS.length);
    expect(RANGE_STREAMED_ROOTS.length).toBeLessThan(BUNDLE_ROOTS.length);

    for (const root of RANGE_STREAMED_ROOTS) {
      const rule = headers.find((h: { source: string }) => h.source === `/${root}/:path*`);
      expect(rule, `no header rule for /${root}`).toBeDefined();
      const cacheControl = rule.headers.find(
        (h: { key: string }) => h.key.toLowerCase() === "cache-control",
      );
      expect(cacheControl.value).toBe("no-store");
    }

    // Whole-file bundles keep browser caching.
    for (const root of BUNDLE_ROOTS.filter((r) => !RANGE_STREAMED_ROOTS.includes(r))) {
      expect(headers.find((h: { source: string }) => h.source === `/${root}/:path*`)).toBeUndefined();
    }
  });

  it("agrees with the publisher about which roots stream by range", async () => {
    // The config cannot import the script (Next config must stand alone), so the
    // two lists are kept honest here instead of by convention.
    const publisher = readFileSync(
      fileURLToPath(new URL("../scripts/publish-bundles-r2.mjs", import.meta.url)),
      "utf8",
    );
    const declaration = publisher.match(/const RANGE_STREAMED_ROOTS = new Set\(\[([^\]]*)\]\)/);
    expect(declaration, "RANGE_STREAMED_ROOTS not found in the publisher").toBeTruthy();

    const publisherRoots = [...declaration![1].matchAll(/"([^"]+)"/g)].map(([, r]) => r);
    expect([...publisherRoots].sort()).toEqual([...RANGE_STREAMED_ROOTS].sort());
  });

  it("declares no header overrides when bundles are served from public/", async () => {
    // Nothing is proxied then, so nothing needs its caching suppressed.
    const config = await loadConfig({ GAME_CDN_URL: "" });
    expect(config.headers).toBeUndefined();
  });

  it("declares no rewrites in a static export, which cannot perform them", async () => {
    const config = await loadConfig({ NEXT_PUBLIC_STATIC_EXPORT: "1" });

    expect(config.output).toBe("export");
    expect(config.rewrites).toBeUndefined();
    expect(config.headers).toBeUndefined();
  });
});
