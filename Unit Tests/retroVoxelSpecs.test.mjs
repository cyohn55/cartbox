/**
 * Unit tests for the backdrop prop specifications
 * (apps/web/src/lib/retroVoxelSpecs.ts).
 *
 * Guards the motion invariants the renderer and the spin ease rely on, checked
 * relationally against each spec (never against hard-coded timings): a spin must
 * finish inside its cycle so idle bobbing resumes, and every timing/amplitude is
 * positive. Also confirms every placed prop stays on-buffer (0..1 anchors).
 * Dep-free (retroVoxelSpecs pulls only sprite data), so it loads under the TS
 * hook without the WASM editor barrel.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/retroVoxelSpecs.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { PROP_SPECS } = await import(
  pathToFileURL(path.resolve(here, "../apps/web/src/lib/retroVoxelSpecs.ts")).href
);

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

check("there are props to place", PROP_SPECS.length > 0);

for (const spec of PROP_SPECS) {
  const { name, motion, fx, fy, cell, depth } = spec;

  // A full turn must complete strictly within the cycle, or the prop would spin
  // continuously with no idle bob between turns.
  check(`${name}: spin finishes inside its cycle`, motion.spinDuration < motion.spinCycle);

  check(`${name}: bob amplitude positive`, motion.bobAmplitude > 0);
  check(`${name}: bob period positive`, motion.bobPeriod > 0);
  check(`${name}: spin duration positive`, motion.spinDuration > 0);

  // Phases are fractions of a cycle, in [0, 1).
  check(`${name}: bob phase in [0,1)`, motion.bobPhase >= 0 && motion.bobPhase < 1);
  check(`${name}: spin phase in [0,1)`, motion.spinPhase >= 0 && motion.spinPhase < 1);

  // Anchors are buffer fractions; sizes are positive.
  check(`${name}: on-buffer anchor`, fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1);
  check(`${name}: positive cell`, cell > 0);
  check(`${name}: positive depth`, depth > 0);
}

console.log(`retroVoxelSpecs: ${passed}/${passed} checks passed`);
