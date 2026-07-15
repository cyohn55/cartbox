/**
 * Unit tests for the custom-handheld-art gate (apps/web/src/lib/handheldArt.ts),
 * the untrusted-input validation added for the in-app pixel editor. This gate is
 * the single place a handheld art payload is coerced before it reaches the DB or
 * localStorage, so these assert exactly what it accepts and what it drops.
 *
 * Values are built from the inputs (a synthetic data URL of a known length, a
 * plausible R2 URL) rather than fixed expected blobs.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/handheld-normalize.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.resolve(here, "../apps/web/src/lib/handheldArt.ts")).href);
const { normalizeArt } = mod;

let passed = 0;

const dataUrl = (payloadLen) => `data:image/png;base64,${"A".repeat(payloadLen)}`;

// 1. A well-formed data-URL art payload is kept, with dimensions rounded.
{
  const out = normalizeArt({ url: dataUrl(100), w: 867.4, h: 1579 });
  assert.ok(out, "valid data-url art is kept");
  assert.equal(out.w, 867, "width is rounded to an integer");
  assert.equal(out.h, 1579, "height passes through");
  assert.ok(out.url.startsWith("data:image/png;base64,"), "url preserved");
  passed += 1;
}

// 2. A plausible https (R2) URL is accepted.
{
  const url = "https://cdn.example.com/handheld/user-abc.png";
  const out = normalizeArt({ url, w: 800, h: 1200 });
  assert.ok(out, "https art url is accepted");
  assert.equal(out.url, url, "https url preserved");
  passed += 1;
}

// 3. Malformed / hostile / oversize art is dropped (returns undefined).
{
  const cases = [
    { label: "non-png data url", art: { url: "data:image/jpeg;base64,AAAA", w: 10, h: 10 } },
    { label: "javascript scheme", art: { url: "javascript:alert(1)", w: 10, h: 10 } },
    { label: "http (not https)", art: { url: "http://cdn.example.com/x.png", w: 10, h: 10 } },
    { label: "oversize dimension", art: { url: "https://cdn.example.com/x.png", w: 99999, h: 10 } },
    { label: "zero dimension", art: { url: "https://cdn.example.com/x.png", w: 0, h: 10 } },
    { label: "non-finite dimension", art: { url: "https://cdn.example.com/x.png", w: NaN, h: 10 } },
    { label: "missing dimensions", art: { url: "https://cdn.example.com/x.png" } },
    { label: "oversize data url", art: { url: dataUrl(4_000_001), w: 10, h: 10 } },
    { label: "non-object", art: "not-an-object" },
    { label: "null", art: null },
    { label: "non-string url", art: { url: 123, w: 10, h: 10 } },
  ];
  for (const testCase of cases) {
    assert.equal(normalizeArt(testCase.art), undefined, `${testCase.label} → dropped`);
  }
  passed += 1;
}

// 4. Animation fields: a valid multi-frame spec is kept and clamped; junk or a
//    single frame yields a plain static image (no frames/durationMs).
{
  const animated = normalizeArt({ url: dataUrl(100), w: 800, h: 1200, frames: 4, durationMs: 5000 });
  assert.ok(animated, "animated art is kept");
  assert.equal(animated.frames, 4, "frame count preserved");
  assert.equal(animated.durationMs, 2000, "duration clamped to the max");

  const defaulted = normalizeArt({ url: dataUrl(100), w: 800, h: 1200, frames: 3 });
  assert.equal(defaulted.durationMs, 100, "missing duration defaults");

  const tooMany = normalizeArt({ url: dataUrl(100), w: 800, h: 1200, frames: 999 });
  assert.equal(tooMany.frames, undefined, "over-limit frame count drops animation");
  const single = normalizeArt({ url: dataUrl(100), w: 800, h: 1200, frames: 1 });
  assert.equal(single.frames, undefined, "a single frame is a static image");
  const garbage = normalizeArt({ url: dataUrl(100), w: 800, h: 1200, frames: "lots" });
  assert.equal(garbage.frames, undefined, "non-numeric frame count is ignored");
  passed += 1;
}

console.log(`PASS — handheld-normalize (art gate): ${passed} checks green.`);
