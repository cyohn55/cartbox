/**
 * Unit tests for the backdrop prop resolution scaler
 * (apps/web/src/lib/voxelPropScale.ts).
 *
 * Assertions come from the function's contract — cell and bob amplitude scale by
 * the buffer factor, placement and the voxel model are untouched, the input is
 * never mutated, and the on-screen size (cell ÷ buffer width) is preserved — all
 * derived from the inputs and factor, never from hard-coded outputs. Dep-free
 * (type-only import of VoxelProp), so it loads under the TS hook without the WASM
 * editor barrel.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/voxelPropScale.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { scaleVoxelProps } = await import(
  pathToFileURL(path.resolve(here, "../apps/web/src/lib/voxelPropScale.ts")).href
);

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

/** A minimal placed prop; the scaler shares the model by reference, so a stub is enough. */
const makeProp = (over = {}) => ({
  model: { count: 3 }, // opaque to the scaler
  fx: 0.31,
  fy: 0.72,
  cell: 2,
  motion: {
    bobAmplitude: 3,
    bobPeriod: 4,
    bobPhase: 0.25,
    spinCycle: 15,
    spinDuration: 3,
    spinPhase: 0.4,
  },
  ...over,
});

// The base buffer the props are authored against, used only to prove the
// on-screen-size invariant (a ratio), never as an expected literal.
const BASE_BUFFER_WIDTH = 260;

// 1. cell and bob amplitude scale by exactly the factor.
{
  const factor = 3;
  const [prop] = [makeProp()];
  const [scaled] = scaleVoxelProps([prop], factor);
  check("cell scales by the factor", scaled.cell === prop.cell * factor);
  check("bob amplitude scales by the factor", scaled.motion.bobAmplitude === prop.motion.bobAmplitude * factor);
}

// 2. Placement fractions and every non-amplitude motion field are unchanged.
{
  const prop = makeProp();
  const [scaled] = scaleVoxelProps([prop], 4);
  check("fx unchanged", scaled.fx === prop.fx);
  check("fy unchanged", scaled.fy === prop.fy);
  check("bobPeriod unchanged", scaled.motion.bobPeriod === prop.motion.bobPeriod);
  check("bobPhase unchanged", scaled.motion.bobPhase === prop.motion.bobPhase);
  check("spinCycle unchanged", scaled.motion.spinCycle === prop.motion.spinCycle);
  check("spinDuration unchanged", scaled.motion.spinDuration === prop.motion.spinDuration);
  check("spinPhase unchanged", scaled.motion.spinPhase === prop.motion.spinPhase);
}

// 3. The voxel model is carried through by reference (never rebuilt or copied).
{
  const prop = makeProp();
  const [scaled] = scaleVoxelProps([prop], 2);
  check("model shared by reference", scaled.model === prop.model);
}

// 4. On-screen size is invariant: cell ÷ buffer width is preserved, because both
//    scale by the same factor. This is the property that keeps props the same
//    size after the buffer grows.
{
  const factor = 5;
  const prop = makeProp();
  const [scaled] = scaleVoxelProps([prop], factor);
  const before = prop.cell / BASE_BUFFER_WIDTH;
  const after = scaled.cell / (BASE_BUFFER_WIDTH * factor);
  check("on-screen size preserved", Math.abs(before - after) < 1e-12);
}

// 5. The input props and their motion are never mutated (purity).
{
  const prop = makeProp();
  const originalCell = prop.cell;
  const originalAmplitude = prop.motion.bobAmplitude;
  scaleVoxelProps([prop], 3);
  check("input cell untouched", prop.cell === originalCell);
  check("input amplitude untouched", prop.motion.bobAmplitude === originalAmplitude);
}

// 6. scale === 1 is the identity in value, but returns fresh objects.
{
  const prop = makeProp();
  const [scaled] = scaleVoxelProps([prop], 1);
  check("identity keeps cell", scaled.cell === prop.cell);
  check("identity keeps amplitude", scaled.motion.bobAmplitude === prop.motion.bobAmplitude);
  check("identity returns a fresh prop", scaled !== prop);
  check("identity returns a fresh motion", scaled.motion !== prop.motion);
}

// 7. Cell stays an integer for integer inputs, so tile canvases stay integer-sized.
{
  const [scaled] = scaleVoxelProps([makeProp({ cell: 3 })], 2);
  check("scaled cell is an integer", Number.isInteger(scaled.cell));
}

// 8. Every prop in a set is scaled independently.
{
  const props = [makeProp({ cell: 2 }), makeProp({ cell: 3, motion: makeProp().motion })];
  const scaled = scaleVoxelProps(props, 2);
  check("set length preserved", scaled.length === props.length);
  check("first prop scaled", scaled[0].cell === props[0].cell * 2);
  check("second prop scaled", scaled[1].cell === props[1].cell * 2);
}

// 9. A non-integer or non-positive scale is rejected (guards the integer-cell invariant).
{
  assert.throws(() => scaleVoxelProps([makeProp()], 1.5), RangeError);
  passed += 1;
  assert.throws(() => scaleVoxelProps([makeProp()], 0), RangeError);
  passed += 1;
  assert.throws(() => scaleVoxelProps([makeProp()], -2), RangeError);
  passed += 1;
}

console.log(`voxelPropScale: ${passed}/${passed} checks passed`);
