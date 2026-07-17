/**
 * Unit tests for the renderer's picking buffers (renderVoxelModel's optional
 * pickVoxel/pickFace), which turn a screen pixel into the voxel + cube face under
 * it — the basis for click-to-sculpt in the 3D voxel editor.
 *
 * Assertions are geometric: viewed head-on (yaw 0, pitch 0), the centre pixel
 * must resolve to the front voxel's +Z face, and empty pixels stay -1. Face
 * identity is looked up from CUBE_FACES, not hard-coded.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelPick.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modelMod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/render/voxelModel.ts")).href);
const gridMod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/model/VoxelGrid.ts")).href);
const rendererMod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/render/voxelModelRenderer.ts")).href);
const { CUBE_FACES } = modelMod;
const { VoxelGrid, voxelGridToModel } = gridMod;
const { renderVoxelModel, voxelCanvasSize } = rendererMod;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

const PLUS_Z_FACE = CUBE_FACES.findIndex((f) => f.normal[0] === 0 && f.normal[1] === 0 && f.normal[2] === 1);

// A single centred voxel, viewed head-on.
const grid = new VoxelGrid(3, 3, 3);
grid.set(1, 1, 1, 180, 90, 60, 0);
const model = voxelGridToModel(grid);

const cell = 8;
const size = voxelCanvasSize(model, cell);
const pickVoxel = new Int32Array(size * size);
const pickFace = new Int8Array(size * size);
const render = renderVoxelModel(model, { yaw: 0, pitch: 0, cell, pickVoxel, pickFace });

// 1. The buffers are returned and initialised to -1 where nothing is drawn.
{
  check("pick buffers returned", render.pickVoxel === pickVoxel && render.pickFace === pickFace);
  check("a corner pixel is empty", pickVoxel[0] === -1 && pickFace[0] === -1);
}

// 2. The centre pixel resolves to the only voxel, on its +Z (front) face.
{
  const cx = Math.floor(size / 2);
  const centre = cx * size + cx;
  check("centre pixel hit a voxel", pickVoxel[centre] === 0);
  check("centre pixel's grid cell is the placed one", model.gridIndex[pickVoxel[centre]] === grid.index(1, 1, 1));
  check("centre pixel is the +Z face", pickFace[centre] === PLUS_Z_FACE);
}

// 3. Picks are consistent with the drawn image: every opaque pixel has a pick,
//    every transparent pixel does not.
{
  let consistent = true;
  for (let i = 0; i < size * size; i += 1) {
    const drawn = render.data[i * 4 + 3] > 0;
    const picked = pickVoxel[i] >= 0;
    if (drawn !== picked) { consistent = false; break; }
  }
  check("pick coverage matches drawn pixels", consistent);
}

// 4. Not requesting pick buffers leaves them undefined (backward compatible).
{
  const plain = renderVoxelModel(model, { yaw: 0, pitch: 0, cell });
  check("no pick buffers by default", plain.pickVoxel === undefined && plain.pickFace === undefined);
}

console.log(`voxelPick: ${passed}/${passed} checks passed`);
