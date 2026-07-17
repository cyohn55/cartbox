/**
 * Unit tests for the rotatable voxel model + renderer
 * (packages/editor/src/render/voxelModel.ts + voxelModelRenderer.ts).
 *
 * Assertions are derived from the modules' own inputs/outputs — shell-voxel
 * counts computed from first principles, normal magnitudes, projected
 * silhouettes under rotation — never hard-coded pixel values. Both modules are
 * dep-free, so they load directly under the TS hook.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelModel.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const model = await import(
  pathToFileURL(path.resolve(here, "../packages/editor/src/render/voxelModel.ts")).href
);
const renderer = await import(
  pathToFileURL(path.resolve(here, "../packages/editor/src/render/voxelModelRenderer.ts")).href
);
const { extrudeSprite, CUBE_FACES } = model;
const { renderVoxelModel, voxelCanvasSize } = renderer;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

/** A fully opaque w×h rectangle of one colour. */
function filledRect(w, h, [r, g, b]) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    a[i * 4] = r;
    a[i * 4 + 1] = g;
    a[i * 4 + 2] = b;
    a[i * 4 + 3] = 255;
  }
  return a;
}

/** Bounding box of the drawn (alpha>0) pixels in a square RGBA render. */
function drawnBounds(data, size) {
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  let drawn = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (data[(y * size + x) * 4 + 3] > 0) {
        drawn += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { width: maxX - minX + 1, height: maxY - minY + 1, drawn };
}

const W = 6;
const H = 5;
const D = 4;
const slab = extrudeSprite(filledRect(W, H, [200, 120, 60]), W, H, { depth: D });

// 1. Dimensions mirror the input footprint and requested depth.
check("model dims match the extrusion inputs", slab.sizeX === W && slab.sizeY === H && slab.sizeZ === D);

// 2. Only the surface shell is kept: total columns minus the fully-interior core.
//    (interior = pixels off the border, extruded strictly between front and back)
const expectedShell = W * H * D - (W - 2) * (H - 2) * (D - 2);
check("kept voxel count equals the surface shell", slab.count === expectedShell);

// 3. Every retained voxel carries a unit-length outward normal.
{
  let allUnit = true;
  for (let v = 0; v < slab.count; v += 1) {
    const mag = Math.hypot(slab.nx[v], slab.ny[v], slab.nz[v]);
    if (Math.abs(mag - 1) > 1e-5) allUnit = false;
  }
  check("all surface normals are unit length", allUnit);
}

// 4. The shell is centred on the origin, so its coordinate means are ~0.
{
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let v = 0; v < slab.count; v += 1) {
    sx += slab.x[v];
    sy += slab.y[v];
    sz += slab.z[v];
  }
  const n = slab.count;
  check(
    "surface shell is centred on the origin",
    Math.abs(sx / n) < 1e-6 && Math.abs(sy / n) < 1e-6 && Math.abs(sz / n) < 1e-6,
  );
}

// 5. A front-face voxel's normal points toward the viewer (+z dominant).
{
  let frontMax = -Infinity;
  for (let v = 0; v < slab.count; v += 1) if (slab.nz[v] > frontMax) frontMax = slab.nz[v];
  check("front faces point toward the viewer", frontMax > 0.99);
}

// 5b. The exposed-face mask agrees with the stored normal: the normalized sum of
//     the set faces' normals reproduces (nx, ny, nz). Every kept voxel exposes at
//     least one face (it is surface, not interior). Derived from CUBE_FACES, not
//     hard-coded bits.
{
  let allExposed = true;
  let allAgree = true;
  for (let v = 0; v < slab.count; v += 1) {
    const mask = slab.faces[v];
    if (mask === 0) { allExposed = false; break; }
    let sx = 0, sy = 0, sz = 0;
    for (const face of CUBE_FACES) {
      if (mask & face.bit) { sx += face.normal[0]; sy += face.normal[1]; sz += face.normal[2]; }
    }
    const len = Math.hypot(sx, sy, sz) || 1;
    if (Math.abs(sx / len - slab.nx[v]) > 1e-5 || Math.abs(sy / len - slab.ny[v]) > 1e-5 || Math.abs(sz / len - slab.nz[v]) > 1e-5) {
      allAgree = false; break;
    }
  }
  check("every surface voxel exposes at least one face", allExposed);
  check("face mask reconstructs the stored normal", allAgree);
}

// 6. Emissive is carried per column: marking one pixel emissive lights exactly
//    that column's kept voxels.
{
  const emissive = new Uint8Array(W * H);
  emissive[0] = 255; // top-left pixel (a border pixel → its whole D-column is kept)
  const glow = extrudeSprite(filledRect(W, H, [80, 80, 80]), W, H, { depth: D, emissive });
  let lit = 0;
  for (let v = 0; v < glow.count; v += 1) if (glow.emissive[v] > 0) lit += 1;
  check("emissive is carried on the marked column", lit === D);
}

// 7. Renderer output is square and sized by voxelCanvasSize.
const cell = 3;
const size = voxelCanvasSize(slab, cell);
const front = renderVoxelModel(slab, { yaw: 0, cell });
check(
  "render output is square and correctly sized",
  front.width === size && front.height === size && front.data.length === size * size * 4,
);

// 8. Rotation changes the silhouette: a wide, shallow slab is wider seen head-on
//    than seen edge-on (yawed 90°).
{
  const head = drawnBounds(renderVoxelModel(slab, { yaw: 0, pitch: 0, cell }).data, size);
  const edge = drawnBounds(renderVoxelModel(slab, { yaw: Math.PI / 2, pitch: 0, cell }).data, size);
  check("yaw changes the projected silhouette width", head.width > edge.width);
}

// 9. Determinism: identical inputs render an identical buffer.
{
  const again = renderVoxelModel(slab, { yaw: 0, cell });
  check("render is deterministic", Buffer.compare(Buffer.from(front.data), Buffer.from(again.data)) === 0);
}

// 10. Emissive voxels stay bright even lit from behind with no ambient — they
//     carry their own light.
{
  const bright = extrudeSprite(filledRect(4, 4, [240, 220, 120]), 4, 4, {
    depth: 2,
    emissive: new Uint8Array(16).fill(255),
  });
  const away = renderVoxelModel(bright, {
    yaw: 0,
    pitch: 0,
    cell: 4,
    light: { direction: [0, 0, -1], color: [1, 1, 1], intensity: 1, ambient: 0 },
  });
  let maxLum = 0;
  for (let i = 0; i < away.data.length; i += 4) {
    if (away.data[i + 3] > 0) maxLum = Math.max(maxLum, away.data[i] + away.data[i + 1] + away.data[i + 2]);
  }
  check("emissive voxels survive being lit from behind", maxLum > 400);
}

console.log(`voxelModel: ${passed}/${passed} checks passed`);
