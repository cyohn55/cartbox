/**
 * Unit tests for the sprite editor's shape/selection geometry (shapeTools.ts):
 * Bresenham lines, rectangle and ellipse outlines, magic-wand regions, and the
 * selection-bounded flood fill. Expectations are derived from the inputs (end
 * points, bounding boxes, painted regions) rather than hardcoded pixel lists.
 *
 * Run:  node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/shapeTools.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, "../apps/web/src/app/edit/[cartId]/shapeTools.ts");
const { linePoints, rectOutlinePoints, ellipseOutlinePoints, wandSelection, maskedFloodFill, pixelKey } = await import(
  pathToFileURL(modulePath).href
);

let passed = 0;

/** An in-memory PaintSurface: one tile of size×size values. */
function makeSurface(size, initial = 0) {
  const pixels = new Array(size * size).fill(initial);
  return {
    tileSize: size,
    pixels,
    getPixel: (_page, _tile, x, y) => pixels[y * size + x],
    setPixel: (_page, _tile, x, y, value) => {
      pixels[y * size + x] = value;
    },
    fill: () => {},
    cssColor: () => "#000",
  };
}

const chebyshevDistance = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// 1. Lines include both endpoints and every consecutive pair is 8-connected.
for (const [x0, y0, x1, y1] of [[0, 0, 7, 7], [7, 2, 0, 5], [3, 0, 3, 7], [0, 4, 7, 4], [1, 1, 6, 2]]) {
  const points = linePoints(x0, y0, x1, y1);
  assert.deepEqual(points[0], { x: x0, y: y0 });
  assert.deepEqual(points[points.length - 1], { x: x1, y: y1 });
  for (let index = 1; index < points.length; index += 1) {
    assert.equal(chebyshevDistance(points[index - 1], points[index]), 1, "line has a gap");
  }
  passed += 1;
}

// 2. A line's length is the Chebyshev distance + 1 (Bresenham visits one pixel per major step).
{
  const points = linePoints(2, 3, 7, 1);
  assert.equal(points.length, Math.max(Math.abs(7 - 2), Math.abs(1 - 3)) + 1);
  passed += 1;
}

// 3. Rectangle outline: every point lies on the border of the normalised box,
//    all four corners are present, and the interior is untouched.
for (const [x0, y0, x1, y1] of [[1, 1, 6, 5], [6, 5, 1, 1], [2, 2, 2, 6], [3, 3, 3, 3]]) {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  const points = rectOutlinePoints(x0, y0, x1, y1);
  for (const point of points) {
    const onBorder = point.x === left || point.x === right || point.y === top || point.y === bottom;
    assert.ok(onBorder, `interior point ${point.x},${point.y}`);
  }
  for (const corner of [[left, top], [right, top], [left, bottom], [right, bottom]]) {
    assert.ok(points.some((point) => point.x === corner[0] && point.y === corner[1]), "missing corner");
  }
  const keys = points.map((point) => `${point.x},${point.y}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate outline point");
  passed += 1;
}

// 4. Ellipse outline stays inside its bounding box and touches all four extremes.
{
  const points = ellipseOutlinePoints(0, 0, 10, 6);
  for (const point of points) {
    assert.ok(point.x >= 0 && point.x <= 10 && point.y >= 0 && point.y <= 6, "escaped bounding box");
  }
  assert.ok(points.some((point) => point.x === 0), "missing left extreme");
  assert.ok(points.some((point) => point.x === 10), "missing right extreme");
  assert.ok(points.some((point) => point.y === 0), "missing top extreme");
  assert.ok(points.some((point) => point.y === 6), "missing bottom extreme");
  passed += 1;
}

// 5. Degenerate ellipse boxes (under 3 pixels a side) fall back to the rectangle outline.
{
  assert.deepEqual(ellipseOutlinePoints(2, 1, 2, 5), rectOutlinePoints(2, 1, 2, 5));
  passed += 1;
}

// 6. The magic wand selects exactly the 4-connected region of the start value.
{
  const size = 8;
  const surface = makeSurface(size, 0);
  // Paint an L-shaped region of value 5 plus a detached pixel of the same value.
  const region = [[1, 1], [2, 1], [3, 1], [1, 2], [1, 3]];
  for (const [x, y] of region) surface.setPixel(0, 0, x, y, 5);
  surface.setPixel(0, 0, 6, 6, 5); // same value, not contiguous
  const selection = wandSelection((x, y) => surface.getPixel(0, 0, x, y), size, 1, 1);
  assert.equal(selection.size, region.length);
  for (const [x, y] of region) assert.ok(selection.has(pixelKey(x, y, size)));
  assert.ok(!selection.has(pixelKey(6, 6, size)), "wand crossed a gap");
  passed += 1;
}

// 7. Wand on the background selects the background region but not the island.
{
  const size = 6;
  const surface = makeSurface(size, 0);
  surface.setPixel(0, 0, 2, 2, 9);
  const selection = wandSelection((x, y) => surface.getPixel(0, 0, x, y), size, 0, 0);
  assert.equal(selection.size, size * size - 1);
  assert.ok(!selection.has(pixelKey(2, 2, size)));
  passed += 1;
}

// 8. Unmasked flood fill matches the wand region; pixels outside stay put.
{
  const size = 8;
  const surface = makeSurface(size, 0);
  for (const [x, y] of [[1, 1], [2, 1], [1, 2]]) surface.setPixel(0, 0, x, y, 3);
  maskedFloodFill(surface, 0, 0, 1, 1, 7, null);
  for (const [x, y] of [[1, 1], [2, 1], [1, 2]]) assert.equal(surface.getPixel(0, 0, x, y), 7);
  assert.equal(surface.getPixel(0, 0, 4, 4), 0, "fill escaped the region");
  passed += 1;
}

// 9. A masked flood fill never escapes the mask, even across same-value pixels.
{
  const size = 8;
  const surface = makeSurface(size, 0); // uniform background: unmasked fill would take everything
  const mask = new Set([pixelKey(0, 0, size), pixelKey(1, 0, size), pixelKey(0, 1, size)]);
  maskedFloodFill(surface, 0, 0, 0, 0, 4, mask);
  let painted = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (surface.getPixel(0, 0, x, y) === 4) {
        painted += 1;
        assert.ok(mask.has(pixelKey(x, y, size)), `fill escaped mask at ${x},${y}`);
      }
    }
  }
  assert.equal(painted, mask.size);
  passed += 1;
}

// 10. A fill started outside its mask is a no-op.
{
  const size = 4;
  const surface = makeSurface(size, 0);
  const mask = new Set([pixelKey(3, 3, size)]);
  maskedFloodFill(surface, 0, 0, 0, 0, 9, mask);
  for (let index = 0; index < size * size; index += 1) assert.equal(surface.pixels[index], 0);
  passed += 1;
}

console.log(`shapeTools: ${passed} checks passed`);
