/**
 * Unit tests for voxelShapes (packages/editor/src/model/voxelShapes.ts): the
 * in-plane cell offsets the Voxel editor's Shape tool covers for a rectangle or
 * circle, as an outline or a fill, at a given radius.
 *
 * Assertions are derived from the geometry (counts, 4-fold symmetry, the radius
 * relation), never from hard-coded offset lists, so they hold for any radius.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelShapes.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/model/voxelShapes.ts")).href);
const { shapeOffsets } = mod;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

const keyOf = ({ u, v }) => `${u},${v}`;
const asSet = (offsets) => new Set(offsets.map(keyOf));
const has = (offsets, u, v) => asSet(offsets).has(`${u},${v}`);
const unique = (offsets) => asSet(offsets).size === offsets.length;
const fourFold = (offsets) => {
  const set = asSet(offsets);
  return offsets.every(({ u, v }) => set.has(`${-u},${v}`) && set.has(`${u},${-v}`) && set.has(`${-u},${-v}`));
};

// 1. Radius 0 is always the single centre cell, whatever the kind/style.
{
  for (const kind of ["rectangle", "circle"]) {
    for (const style of ["outline", "fill"]) {
      const offsets = shapeOffsets(kind, style, 0);
      check(`radius 0 ${kind}/${style} is one cell`, offsets.length === 1 && has(offsets, 0, 0));
    }
  }
  // A raw slider value is floored and clamped, so negatives collapse to the centre.
  check("negative radius clamps to the centre", shapeOffsets("circle", "fill", -5).length === 1);
}

// 2. Rectangle fill is the full (2r+1)² block; outline is its 8r-cell border.
for (const r of [1, 2, 5, 12]) {
  const span = 2 * r + 1;
  const fill = shapeOffsets("rectangle", "fill", r);
  const outline = shapeOffsets("rectangle", "outline", r);
  check(`rect fill r=${r} fills the block`, fill.length === span * span);
  check(`rect fill r=${r} unique`, unique(fill));
  check(`rect outline r=${r} is the 8r border`, outline.length === 8 * r);
  check(`rect outline r=${r} unique`, unique(outline));
  check(`rect outline r=${r} is the fill minus the interior`, outline.length === span * span - (span - 2) * (span - 2));
  // Every outline cell sits on the bounding border; corners are present.
  check(
    `rect outline r=${r} lies on the border`,
    outline.every(({ u, v }) => Math.abs(u) === r || Math.abs(v) === r),
  );
  check(`rect outline r=${r} has its corners`, has(outline, r, r) && has(outline, -r, -r));
  check(`rect fill r=${r} is 4-fold symmetric`, fourFold(fill));
  check(`rect outline r=${r} is 4-fold symmetric`, fourFold(outline));
}

// 3. Circle fill is a disk; outline is a ring near the radius.
for (const r of [2, 4, 8, 16]) {
  const span = 2 * r + 1;
  const fill = shapeOffsets("circle", "fill", r);
  const outline = shapeOffsets("circle", "outline", r);

  check(`circle fill r=${r} unique`, unique(fill));
  check(`circle outline r=${r} unique`, unique(outline));
  check(`circle fill r=${r} contains the centre`, has(fill, 0, 0));
  check(`circle fill r=${r} contains the cardinal edges`, has(fill, r, 0) && has(fill, 0, r) && has(fill, -r, 0) && has(fill, 0, -r));
  // A disk fits inside the square but drops the far corners, so it is smaller.
  check(`circle fill r=${r} is smaller than the square`, fill.length < span * span);
  check(`circle fill r=${r} excludes the far corner`, !has(fill, r, r));
  // Every fill cell is within the disk radius; 4-fold symmetric.
  check(
    `circle fill r=${r} within radius`,
    fill.every(({ u, v }) => u * u + v * v <= (r + 0.5) * (r + 0.5)),
  );
  check(`circle fill r=${r} is 4-fold symmetric`, fourFold(fill));

  // The ring hugs the radius (each cell within one voxel of it), keeps the
  // cardinal points, excludes the centre, and is lighter than the disk.
  check(
    `circle outline r=${r} hugs the radius`,
    outline.every(({ u, v }) => Math.abs(Math.hypot(u, v) - r) < 1),
  );
  check(`circle outline r=${r} keeps the cardinals`, has(outline, r, 0) && has(outline, 0, r));
  check(`circle outline r=${r} excludes the centre`, !has(outline, 0, 0));
  check(`circle outline r=${r} is lighter than the fill`, outline.length < fill.length);
  check(`circle outline r=${r} is 4-fold symmetric`, fourFold(outline));
}

// 4. Determinism: the same request yields the same offsets in the same order.
{
  const a = shapeOffsets("circle", "outline", 7);
  const b = shapeOffsets("circle", "outline", 7);
  check("circle outline is deterministic", a.length === b.length && a.every((p, i) => p.u === b[i].u && p.v === b[i].v));
}

console.log(`voxelShapes: ${passed}/${passed} checks passed`);
