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

  it("declares no rewrites in a static export, which cannot perform them", async () => {
    const config = await loadConfig({ NEXT_PUBLIC_STATIC_EXPORT: "1" });

    expect(config.output).toBe("export");
    expect(config.rewrites).toBeUndefined();
  });
});
