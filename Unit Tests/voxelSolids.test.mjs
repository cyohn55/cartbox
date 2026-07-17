/**
 * Unit tests for solidOffsets (packages/editor/src/model/voxelShapes.ts): the 3D
 * cell offsets the Voxel editor's Shape tool covers for a cube or a sphere, as a
 * hollow shell (outline) or a solid volume (fill), at a given radius.
 *
 * Assertions are derived from the geometry (counts, octant symmetry, shell ⊂
 * fill, distance bounds), never from hard-coded offset lists, so they hold for
 * any radius.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelSolids.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.resolve(here, "../packages/editor/src/model/voxelShapes.ts")).href);
const { solidOffsets } = mod;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

const keyOf = ({ du, dv, dw }) => `${du},${dv},${dw}`;
const asSet = (offsets) => new Set(offsets.map(keyOf));
const unique = (offsets) => asSet(offsets).size === offsets.length;
// Full octant symmetry: negating any axis keeps the set closed (cube & sphere
// are symmetric under sign flips), a strong invariant independent of counts.
const octantSymmetric = (offsets) => {
  const set = asSet(offsets);
  return offsets.every(
    ({ du, dv, dw }) =>
      set.has(`${-du},${dv},${dw}`) && set.has(`${du},${-dv},${dw}`) && set.has(`${du},${dv},${-dw}`),
  );
};

// 1. Radius 0 is always the single centre cell, whatever the kind/style.
{
  for (const kind of ["cube", "sphere"]) {
    for (const style of ["outline", "fill"]) {
      const offsets = solidOffsets(kind, style, 0);
      check(`radius 0 ${kind}/${style} is one cell`, offsets.length === 1 && keyOf(offsets[0]) === "0,0,0");
    }
  }
  // A raw slider value is floored and clamped, so negatives collapse to the centre.
  check("negative radius clamps to the centre", solidOffsets("sphere", "fill", -4).length === 1);
}

// 2. Cube fill is the full (2r+1)³ block; outline is that minus the interior
//    (2r-1)³ core — i.e. only the outer shell.
for (const r of [1, 2, 4, 8]) {
  const span = 2 * r + 1;
  const fill = solidOffsets("cube", "fill", r);
  const outline = solidOffsets("cube", "outline", r);
  const interior = span - 2; // the hollow core edge length
  check(`cube fill r=${r} fills the block`, fill.length === span * span * span);
  check(`cube fill r=${r} unique`, unique(fill));
  check(`cube outline r=${r} is the shell`, outline.length === span * span * span - interior * interior * interior);
  check(`cube outline r=${r} unique`, unique(outline));
  check(`cube outline r=${r} is octant-symmetric`, octantSymmetric(outline));
  // Every shell cell touches the boundary on at least one axis.
  check(
    `cube outline r=${r} lies on the boundary`,
    outline.every(({ du, dv, dw }) => Math.abs(du) === r || Math.abs(dv) === r || Math.abs(dw) === r),
  );
}

// 3. Sphere fill is a solid ball inside r + 0.5; outline is its single-cell skin
//    (a strict, non-empty subset of the fill) and is octant-symmetric.
for (const r of [1, 2, 3, 6, 10]) {
  const fill = solidOffsets("sphere", "fill", r);
  const outline = solidOffsets("sphere", "outline", r);
  const limit = (r + 0.5) * (r + 0.5);
  check(`sphere fill r=${r} unique`, unique(fill));
  check(
    `sphere fill r=${r} keeps exactly the cells within r+0.5`,
    fill.every(({ du, dv, dw }) => du * du + dv * dv + dw * dw <= limit),
  );
  // The ball is bigger than a cube inscribed but smaller than its bounding box.
  const span = 2 * r + 1;
  check(`sphere fill r=${r} is smaller than its bounding cube`, fill.length < span * span * span);
  check(`sphere fill r=${r} includes the poles`, asSet(fill).has(`${r},0,0`) && asSet(fill).has(`0,0,${r}`));

  const fillSet = asSet(fill);
  check(`sphere outline r=${r} is a subset of the fill`, outline.every((o) => fillSet.has(keyOf(o))));
  check(`sphere outline r=${r} is non-empty and hollow`, outline.length > 0 && outline.length < fill.length);
  check(`sphere outline r=${r} unique`, unique(outline));
  check(`sphere outline r=${r} is octant-symmetric`, octantSymmetric(outline));
  // Every shell cell has an empty 6-neighbour (that is what makes it the skin).
  const outsideBall = (du, dv, dw) => du * du + dv * dv + dw * dw > limit;
  check(
    `sphere outline r=${r} cells all touch the outside`,
    outline.every(
      ({ du, dv, dw }) =>
        outsideBall(du + 1, dv, dw) ||
        outsideBall(du - 1, dv, dw) ||
        outsideBall(du, dv + 1, dw) ||
        outsideBall(du, dv - 1, dw) ||
        outsideBall(du, dv, dw + 1) ||
        outsideBall(du, dv, dw - 1),
    ),
  );
}

// 4. Determinism: the same request yields the same offsets in the same order.
{
  const a = solidOffsets("sphere", "outline", 5);
  const b = solidOffsets("sphere", "outline", 5);
  check(
    "sphere outline is deterministic",
    a.length === b.length && a.every((p, i) => p.du === b[i].du && p.dv === b[i].dv && p.dw === b[i].dw),
  );
}

console.log(`voxelSolids: ${passed}/${passed} checks passed`);
