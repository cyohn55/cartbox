/**
 * Unit tests for the session-refresh middleware.
 *
 * Middleware sits in front of every matched route, so its failure mode is the
 * whole site returning 500 (`MIDDLEWARE_INVOCATION_FAILED`) rather than one bad
 * page. These tests drive the real exported `middleware` with real `NextRequest`
 * objects and assert it degrades instead of throwing, and they derive the
 * excluded-path list from `next.config.mjs` rather than restating it, so the
 * matcher and the game-bundle rewrite cannot drift apart silently.
 *
 * Run with: npx vitest run "Unit Tests/middleware-matcher.test.ts"
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config, middleware, readSupabaseCredentials } from "../apps/web/src/middleware";

const NEXT_CONFIG_PATH = fileURLToPath(
  new URL("../apps/web/next.config.mjs", import.meta.url),
);

/**
 * The bundle roots `next.config.mjs` reroutes to the game CDN, read from the
 * config's own source. Parsing beats duplicating: the assertion below is only
 * meaningful if this list is the one the app actually ships.
 */
function gameBundleRootsFromNextConfig(): string[] {
  const source = readFileSync(NEXT_CONFIG_PATH, "utf8");
  const declaration = source.match(/const GAME_BUNDLE_ROOTS\s*=\s*\[([^\]]*)\]/);

  if (!declaration) {
    throw new Error("GAME_BUNDLE_ROOTS not found in next.config.mjs");
  }

  return [...declaration[1].matchAll(/"([^"]+)"/g)].map(([, root]) => root);
}

/** The single matcher pattern, as a regex over a request path. */
function matcherPattern(): RegExp {
  expect(config.matcher).toHaveLength(1);
  return new RegExp(`^${config.matcher[0]}$`);
}

/** The path prefixes the matcher's negative lookahead excludes. */
function excludedPrefixes(): string[] {
  const lookahead = config.matcher[0].match(/\(\?!([^)]*)\)/);

  if (!lookahead) {
    throw new Error("matcher has no negative lookahead");
  }

  return lookahead[1].split("|");
}

/** Builds a request the way Next hands one to middleware. */
function requestFor(path: string): NextRequest {
  return new NextRequest(new URL(path, "https://cartbox.test"));
}

describe("middleware matcher", () => {
  it("excludes every game bundle root that next.config.mjs reroutes to the CDN", () => {
    const excluded = excludedPrefixes();

    for (const root of gameBundleRootsFromNextConfig()) {
      expect(excluded).toContain(`${root}/`);
    }
  });

  it("does not run on game bundle downloads", () => {
    const pattern = matcherPattern();

    for (const root of gameBundleRootsFromNextConfig()) {
      expect(pattern.test(`/${root}/cartbox-boot.html`)).toBe(false);
    }
  });

  it("does not run on the engine cores or Next's static output", () => {
    const pattern = matcherPattern();

    expect(pattern.test("/engine/tic80.wasm")).toBe(false);
    expect(pattern.test("/_next/static/chunks/main.js")).toBe(false);
    expect(pattern.test("/favicon.ico")).toBe(false);
  });

  it("still runs on the pages and APIs that carry a session", () => {
    const pattern = matcherPattern();

    for (const path of ["/", "/browse", "/login", "/profile/demo", "/api/carts"]) {
      expect(pattern.test(path)).toBe(true);
    }
  });
});

describe("readSupabaseCredentials", () => {
  it("reads a configured environment", () => {
    const credentials = readSupabaseCredentials({
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: "anon-key",
    });

    expect(credentials).toEqual({
      url: "https://project.supabase.co",
      anonKey: "anon-key",
    });
  });

  it("reports an unconfigured environment rather than yielding a partial client", () => {
    expect(readSupabaseCredentials({})).toBeNull();
    expect(readSupabaseCredentials({ SUPABASE_URL: "https://project.supabase.co" })).toBeNull();
    expect(readSupabaseCredentials({ SUPABASE_ANON_KEY: "anon-key" })).toBeNull();
  });

  it("treats blank values as unconfigured", () => {
    // An env var set to "" is how a platform records "declared but empty"; it
    // reaches createServerClient as a credential and throws there.
    expect(
      readSupabaseCredentials({ SUPABASE_URL: "   ", SUPABASE_ANON_KEY: "anon-key" }),
    ).toBeNull();
  });
});

describe("middleware invocation", () => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedKey = process.env.SUPABASE_ANON_KEY;

  beforeEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = savedUrl;

    if (savedKey === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = savedKey;
  });

  it("serves the request when the deployment has no Supabase credentials", async () => {
    // The regression this guards: unset credentials used to reach
    // createServerClient through a `!` assertion, which threw and turned every
    // route into MIDDLEWARE_INVOCATION_FAILED.
    const response = await middleware(requestFor("/browse"));

    expect(response.status).toBe(200);
  });

  it("serves the request when the auth host is unreachable", async () => {
    // Port 1 refuses connections, so getUser() rejects for real rather than
    // through a stub — the transient-outage path, exercised end to end.
    process.env.SUPABASE_URL = "http://127.0.0.1:1";
    process.env.SUPABASE_ANON_KEY = "anon-key";

    const response = await middleware(requestFor("/browse"));

    expect(response.status).toBe(200);
  });

  it("passes the visitor's cookies through untouched when unconfigured", async () => {
    const request = requestFor("/browse");
    request.cookies.set("sb-access-token", "existing");

    const response = await middleware(request);

    expect(response.status).toBe(200);
    expect(request.cookies.get("sb-access-token")?.value).toBe("existing");
  });
});
