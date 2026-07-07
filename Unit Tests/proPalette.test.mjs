/**
 * Unit tests for the Pro 64-colour palette generator. Confirms it produces a full
 * 64-entry palette (not 16 real colours padded with black), keeps Sweetie-16 as
 * the first 16 for Classic-index compatibility, and emits well-formed colours.
 *
 * Run:  node --experimental-transform-types "Unit Tests/proPalette.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, "../packages/editor/src/model/palette.ts");
const { proPaletteHex, paletteForModel, PRO_PALETTE_SIZE, SWEETIE_16 } = await import(pathToFileURL(modulePath).href);

let passed = 0;

// 1. Exactly PRO_PALETTE_SIZE entries.
const pro = proPaletteHex();
assert.equal(pro.length, PRO_PALETTE_SIZE, "pro palette has PRO_PALETTE_SIZE colours");
assert.equal(PRO_PALETTE_SIZE, 64, "Pro authoring palette is 64");
passed += 1;

// 2. First 16 are Sweetie-16 (Classic-index compatibility).
assert.deepEqual(pro.slice(0, SWEETIE_16.length), [...SWEETIE_16], "first 16 match Sweetie-16");
passed += 1;

// 3. Every entry is a valid #rrggbb string.
for (const hex of pro) assert.match(hex, /^#[0-9a-f]{6}$/, `valid hex: ${hex}`);
passed += 1;

// 4. The extension is real colour, not padding: the 48 generated entries are
//    mostly distinct and not all black.
const generated = pro.slice(SWEETIE_16.length);
assert.equal(generated.length, 48, "48 generated colours");
assert.ok(!generated.includes("#000000") || generated.filter((c) => c === "#000000").length < 4, "not padded with black");
assert.ok(new Set(pro).size >= 56, "palette is largely distinct");
passed += 1;

// 5. paletteForModel picks by size: Classic → 16, Pro → 64.
assert.equal(paletteForModel({ paletteSize: 16 }).length, 16, "classic seeds 16");
assert.equal(paletteForModel({ paletteSize: 64 }).length, 64, "pro seeds 64");
passed += 1;

console.log(`PASS — proPalette: ${passed} checks green.`);
