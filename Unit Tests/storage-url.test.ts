/**
 * Unit tests for public object-URL resolution.
 *
 * The module reads its CDN base from the environment, so each test sets the
 * environment it is asserting about rather than assuming one — that is also what
 * lets the "no base configured" case be exercised at all.
 *
 * Run with: npx vitest run "Unit Tests/storage-url.test.ts"
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publicUrl } from "../apps/web/src/lib/storage";

const CDN_BASE = "https://cdn.example.test/cartbox";

let savedBase: string | undefined;

beforeEach(() => {
  savedBase = process.env.R2_PUBLIC_BASE_URL;
  process.env.R2_PUBLIC_BASE_URL = CDN_BASE;
});

afterEach(() => {
  if (savedBase === undefined) {
    delete process.env.R2_PUBLIC_BASE_URL;
  } else {
    process.env.R2_PUBLIC_BASE_URL = savedBase;
  }
});

describe("publicUrl", () => {
  it("resolves a bucket-relative key against the configured CDN base", () => {
    expect(publicUrl("carts/abc.tic")).toBe(`${CDN_BASE}/carts/abc.tic`);
  });

  /**
   * The case this guard exists for: content that lives outside the default
   * bucket stores its full URL. Concatenating would produce
   * `https://cdn.example.test/cartbox/https://other.host/...`, which resolves to
   * nothing — so a cart seeded from another store would list correctly and then
   * fail to load, looking like a corrupt cartridge rather than a bad URL.
   */
  it("returns an absolute URL unchanged instead of nesting it under the base", () => {
    const absolute = "https://other.host/storage/v1/object/public/carts/abc.tic";
    expect(publicUrl(absolute)).toBe(absolute);
  });

  it("passes through http as well as https", () => {
    expect(publicUrl("http://localhost:9000/bucket/abc.tic")).toBe(
      "http://localhost:9000/bucket/abc.tic",
    );
  });

  it("matches the scheme case-insensitively, as URLs are", () => {
    expect(publicUrl("HTTPS://Other.Host/a.tic")).toBe("HTTPS://Other.Host/a.tic");
  });

  it("treats a key that merely mentions a scheme as a key, not a URL", () => {
    // Only a leading scheme makes it a URL; the substring appearing later is
    // part of the object's name and must still be resolved against the base.
    expect(publicUrl("carts/https-explainer.tic")).toBe(`${CDN_BASE}/carts/https-explainer.tic`);
  });

  it("needs no CDN base configured when every key is absolute", () => {
    // A deployment serving only externally-hosted objects should not be forced
    // to invent an R2 base it never uses.
    delete process.env.R2_PUBLIC_BASE_URL;
    const absolute = "https://other.host/a.tic";
    expect(publicUrl(absolute)).toBe(absolute);
  });

  it("still demands a CDN base for a relative key", () => {
    delete process.env.R2_PUBLIC_BASE_URL;
    expect(() => publicUrl("carts/abc.tic")).toThrow(/R2_PUBLIC_BASE_URL/);
  });
});
