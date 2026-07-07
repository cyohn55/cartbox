/**
 * Unit tests for the palette gradient sort. Confirms it returns original indices
 * ordered as: neutrals first (dark→light), then chromatic colours by hue and, in
 * a hue, by lightness. Expectations are derived from the colours' known hue/
 * lightness, and the result is checked as the reordered colour sequence.
 *
 * Run:  node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/paletteSort.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, "../packages/editor/src/model/paletteSort.ts");
const { gradientSortOrder } = await import(pathToFileURL(modulePath).href);

const reorder = (colors) => gradientSortOrder(colors).map((index) => colors[index]);
let passed = 0;

// 1. Returns a permutation of the input indices (nothing lost or duplicated).
{
  const colors = ["#ff0000", "#00ff00", "#0000ff", "#808080"];
  const order = gradientSortOrder(colors);
  assert.equal(order.length, colors.length);
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3], "order is a permutation");
  passed += 1;
}

// 2. Neutrals lead (dark→light), then chromatic by hue (red < green < blue).
{
  const input = ["#ff0000", "#000000", "#ffffff", "#0000ff", "#808080", "#00ff00"];
  assert.deepEqual(reorder(input), ["#000000", "#808080", "#ffffff", "#ff0000", "#00ff00", "#0000ff"]);
  passed += 1;
}

// 3. Within one hue, colours sort dark→light.
{
  const input = ["#ffcccc", "#660000", "#ff0000"]; // light red, dark red, pure red
  const out = reorder(input);
  assert.deepEqual(out, ["#660000", "#ff0000", "#ffcccc"], "same hue ramps by lightness");
  passed += 1;
}

// 4. A single colour and an empty palette are handled.
{
  assert.deepEqual(gradientSortOrder(["#123456"]), [0]);
  assert.deepEqual(gradientSortOrder([]), []);
  passed += 1;
}

console.log(`PASS — paletteSort: ${passed} checks green.`);
