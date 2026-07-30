/**
 * Unit tests for the R2 bundle publisher's resume and concurrency logic.
 *
 * The payload is ~670MB across ~700 objects, including a single 162MB file, so
 * the properties that matter are not "does it call PutObject" but: an
 * interrupted run resumes instead of re-sending everything, one failed object
 * does not strand the rest, and a long upload cannot idle the other workers.
 *
 * These are pure functions driven with real inputs — no S3, no credentials.
 *
 * Run with: npx vitest run "Unit Tests/publish-bundles.test.ts"
 */

import { describe, expect, it } from "vitest";

// @ts-expect-error - plain ESM script module, no type declarations
import {
  cacheControlForKey,
  contentType,
  mapWithConcurrency,
  shouldUpload,
} from "../scripts/publish-bundles-r2.mjs";

describe("shouldUpload", () => {
  const file = { size: 1024 };

  it("uploads an object the bucket does not have", () => {
    expect(shouldUpload(file, null)).toBe(true);
  });

  it("skips an object already present at the same size", () => {
    // The resume path: a re-run after an interrupted upload must not re-send
    // the hundreds of megabytes that already landed.
    expect(shouldUpload(file, { size: 1024 })).toBe(false);
  });

  it("re-uploads when the bucket holds a different size", () => {
    // A truncated PUT, or a rebuilt bundle whose contents changed.
    expect(shouldUpload(file, { size: 512 })).toBe(true);
    expect(shouldUpload(file, { size: 2048 })).toBe(true);
  });

  it("re-uploads everything under --force", () => {
    expect(shouldUpload(file, { size: 1024 }, { force: true })).toBe(true);
  });

  it("treats a zero-length object as present rather than absent", () => {
    // `!remote.size` would misread a legitimately empty object as missing.
    expect(shouldUpload({ size: 0 }, { size: 0 })).toBe(false);
  });
});

describe("mapWithConcurrency", () => {
  it("visits every item exactly once", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen: number[] = [];

    await mapWithConcurrency(items, 6, async (item: number) => {
      seen.push(item);
    });

    expect(seen).toHaveLength(items.length);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 40 }, (_, i) => i), 5, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });

    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it("does not idle workers behind one slow item", async () => {
    // The 162MB supertux2.data case: a fixed-slice split would leave the other
    // workers finished and waiting. Pulling from a shared cursor does not.
    const items = [80, ...Array.from({ length: 30 }, () => 1)];
    const order: number[] = [];

    await mapWithConcurrency(items, 4, async (cost: number, index: number) => {
      await new Promise((resolve) => setTimeout(resolve, cost));
      order.push(index);
    });

    expect(order).toHaveLength(items.length);
    // The slow first item finishes last despite being scheduled first.
    expect(order[order.length - 1]).toBe(0);
  });

  it("handles an empty list and a limit above the item count", async () => {
    const seen: number[] = [];

    await mapWithConcurrency([], 6, async (item: number) => void seen.push(item));
    expect(seen).toEqual([]);

    await mapWithConcurrency([1, 2], 99, async (item: number) => void seen.push(item));
    expect(seen.sort()).toEqual([1, 2]);
  });
});

describe("contentType", () => {
  it("serves wasm and data payloads as the runtimes require", () => {
    // A wrong type here is not cosmetic: browsers refuse to stream-compile a
    // module that is not application/wasm.
    expect(contentType("/cube2/bb.wasm")).toBe("application/wasm");
    expect(contentType("/supertux/supertux2.data")).toBe("application/octet-stream");
    expect(contentType("/quake/id1/pak0.pak")).toBe("application/octet-stream");
    expect(contentType("/dosbox/cartbox-boot.html")).toBe("text/html; charset=utf-8");
    expect(contentType("/scummvm/scummvm.js")).toBe("text/javascript; charset=utf-8");
  });

  it("falls back to octet-stream for an unknown extension", () => {
    expect(contentType("/games/doom/freedoom1.iwad")).toBe("application/octet-stream");
  });

  it("ignores extension case", () => {
    expect(contentType("/games/WOLF3D.ZIP")).toBe("application/zip");
  });
});

describe("cacheControlForKey", () => {
  it("makes the range-streamed bundle uncacheable", () => {
    // Vercel's edge ignores the Range request header and caches what the origin
    // sends, so a cacheable pak0.pak answers every later range with the first
    // partial it stored. Only the origin can stop that entry existing.
    expect(cacheControlForKey("quake/id1/pak0.pak")).toBe("no-store");
    expect(cacheControlForKey("quake/cartbox-boot.html")).toBe("no-store");
  });

  it("leaves whole-file bundles cacheable", () => {
    // These runtimes never issue range requests, so they are unaffected by the
    // bug and should keep the benefit of the edge cache.
    for (const key of [
      "cube2/bb.wasm",
      "supertux/supertux2.data",
      "scummvm/scummvm.js",
      "dosbox/wdosbox.wasm.js",
      "games/doom/game.wasm",
    ]) {
      expect(cacheControlForKey(key)).toMatch(/^public, max-age=\d+$/);
    }
  });

  it("keys off the bundle root, not a substring of the path", () => {
    // A file merely named "quake" under another bundle must not inherit no-store.
    expect(cacheControlForKey("games/quake-clone/game.wasm")).toMatch(/^public/);
  });
});
