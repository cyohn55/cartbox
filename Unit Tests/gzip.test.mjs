/**
 * Unit tests for the gzip text helpers (apps/web/src/lib/gzip.ts) that back the
 * handheld editor's reload-persistent draft. They must round-trip any string
 * exactly and actually shrink repetitive input (the reason a serialised document
 * fits in localStorage compressed but not raw).
 *
 * Inputs are constructed in-test (including a Unicode string and a long
 * repetitive one), so assertions follow from the inputs rather than fixed blobs.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/gzip.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.resolve(here, "../apps/web/src/lib/gzip.ts")).href);
const { gzipToBase64, base64GunzipToText } = mod;

let passed = 0;

// 1. Round-trips a range of strings exactly, including empty and Unicode.
{
  const cases = ["", "a", "Hello, handheld!", "😀 mixed ünïcödé 日本語", JSON.stringify({ layers: [1, 2, 3], name: "Skin" })];
  for (const text of cases) {
    const packed = await gzipToBase64(text);
    assert.equal(typeof packed, "string", "gzip yields a base64 string");
    assert.equal(await base64GunzipToText(packed), text, `round-trips: ${JSON.stringify(text).slice(0, 24)}`);
  }
  passed += 1;
}

// 2. Compression shrinks highly repetitive input well below its raw base64 size
//    (this is why a flat handheld render's serialised doc fits in localStorage).
{
  const repetitive = "A".repeat(200_000);
  const rawBase64Length = Buffer.from(repetitive, "utf8").toString("base64").length;
  const packed = await gzipToBase64(repetitive);
  assert.ok(packed.length < rawBase64Length / 10, "repetitive text compresses to <10% of raw base64");
  assert.equal(await base64GunzipToText(packed), repetitive, "compressed repetitive text still round-trips");
  passed += 1;
}

// 3. Corrupt base64 that is not a gzip stream rejects rather than silently
//    returning garbage (the caller treats a throw as "no saved draft").
{
  await assert.rejects(() => base64GunzipToText("bm90LWd6aXA="), "non-gzip payload is rejected");
  passed += 1;
}

console.log(`PASS — gzip: ${passed} checks green.`);
