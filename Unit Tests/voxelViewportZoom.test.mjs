/**
 * Unit tests for the fixed-viewport rendering path that makes the Voxel editor's
 * zoom and centring behave correctly (VoxelEditor.tsx):
 *
 *   - renderVoxelModel({ size }) draws into a caller-fixed square viewport rather
 *     than one that grows with the model, so a larger `cell` scales the model
 *     *within* the frame — i.e. zoom actually changes the on-screen model size.
 *   - voxelGridToModel exposes the grid coordinate that maps to the model origin
 *     (originX/Y/Z), so content centring can be reproduced by overlays (the
 *     editor's hover highlight) and asserted here.
 *
 * Assertions are derived from geometry and pixel counts, never hard-coded frames.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelViewportZoom.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const gridMod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/model/VoxelGrid.ts")).href);
const rendererMod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/render/voxelModelRenderer.ts")).href);
const { VoxelGrid, voxelGridToModel } = gridMod;
const { renderVoxelModel, voxelCanvasSize } = rendererMod;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

/** Count opaque pixels (alpha 255) in an RGBA buffer. */
const opaquePixels = (data) => {
  let count = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] === 255) count += 1;
  return count;
};

/** The axis-aligned bounding box of opaque pixels, in a square of the given edge. */
const opaqueBounds = (data, size) => {
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (data[(y * size + x) * 4 + 3] !== 255) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
};

const VIEWPORT = 240;

// A small 3x3x1 sculpt sitting on the floor of a large grid — the shape that used
// to render low and off-centre, and whose zoom used to be visually inert.
const grid = new VoxelGrid(16, 16, 16);
for (let dz = -1; dz <= 1; dz += 1) {
  for (let dx = -1; dx <= 1; dx += 1) {
    grid.set(8 + dx, 0, 8 + dz, 200, 200, 210, 0);
  }
}
const model = voxelGridToModel(grid, { center: "content" });

// 1. Content centring reports its origin: the grid cell that maps to (0,0,0).
//    For this content the box centres on x=8, y=0, z=8.
{
  check("origin x is the content centre", model.originX === 8);
  check("origin y is the content floor", model.originY === 0);
  check("origin z is the content centre", model.originZ === 8);
  check("model is sized to content, not the grid", model.sizeX === 3 && model.sizeY === 1 && model.sizeZ === 3);
}

// 2. A fixed `size` overrides the model-driven canvas size.
{
  const render = renderVoxelModel(model, { yaw: 0, pitch: 0.6, cell: 8, size: VIEWPORT });
  check("explicit size sets the canvas width", render.width === VIEWPORT);
  check("explicit size sets the canvas height", render.height === VIEWPORT);
  check("explicit size differs from the model-driven size", VIEWPORT !== voxelCanvasSize(model, 8));
}

// 3. Zoom works: a larger cell fills more of the same fixed viewport.
{
  const small = renderVoxelModel(model, { yaw: 0.5, pitch: 0.6, cell: 6, size: VIEWPORT });
  const large = renderVoxelModel(model, { yaw: 0.5, pitch: 0.6, cell: 14, size: VIEWPORT });
  const smallPixels = opaquePixels(small.data);
  const largePixels = opaquePixels(large.data);
  check("zooming in draws more pixels in a fixed viewport", largePixels > smallPixels * 2);
}

// 4. Centring works: the drawn content is centred about the viewport middle
//    (its opaque bounding box straddles the centre roughly symmetrically),
//    unlike grid-centring which pushed a floor sculpt into the lower frame.
{
  const render = renderVoxelModel(model, { yaw: 0.6, pitch: 0.5, cell: 10, size: VIEWPORT });
  const { minX, minY, maxX, maxY } = opaqueBounds(render.data, VIEWPORT);
  const centre = VIEWPORT / 2;
  const boxCentreX = (minX + maxX) / 2;
  const boxCentreY = (minY + maxY) / 2;
  const tolerance = VIEWPORT * 0.15;
  check("content is horizontally centred in the viewport", Math.abs(boxCentreX - centre) <= tolerance);
  check("content is vertically centred in the viewport", Math.abs(boxCentreY - centre) <= tolerance);
}

// 5. Grid centring (the default) still reports the whole-grid origin, so existing
//    callers are unaffected by the new fields.
{
  const gridCentred = voxelGridToModel(grid);
  check("grid centring origin is the grid midpoint", gridCentred.originX === 7.5 && gridCentred.originY === 7.5);
  check("grid centring still sizes to the whole grid", gridCentred.sizeX === 16 && gridCentred.sizeY === 16);
}

console.log(`voxelViewportZoom: ${passed}/${passed} checks passed`);
