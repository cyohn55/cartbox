/**
 * Unit tests for the prop idle-motion state machine (apps/web/src/lib/bobSpin.ts).
 *
 * Assertions are derived from the function's contract — bob is bounded and
 * periodic, a spin eases through exactly one full turn per cycle then rests at 0
 * — not from hard-coded angles. Dep-free, loads under the TS hook.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/bobSpin.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { propMotion } = await import(
  pathToFileURL(path.resolve(here, "../apps/web/src/lib/bobSpin.ts")).href
);

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

const TWO_PI = Math.PI * 2;
const params = {
  bobAmplitude: 5,
  bobPeriod: 4,
  bobPhase: 0.1,
  spinCycle: 12,
  spinDuration: 3,
  spinPhase: 0,
};

// Sample a full cycle densely.
const samples = [];
for (let t = 0; t < params.spinCycle; t += 0.02) samples.push({ t, m: propMotion(t, params) });

// 1. Bob never exceeds its amplitude.
check("bob stays within amplitude", samples.every(({ m }) => Math.abs(m.bobY) <= params.bobAmplitude + 1e-9));

// 2. Bob swings both ways (it is a real oscillation, not a constant).
{
  const min = Math.min(...samples.map(({ m }) => m.bobY));
  const max = Math.max(...samples.map(({ m }) => m.bobY));
  check("bob oscillates up and down", min < -params.bobAmplitude * 0.9 && max > params.bobAmplitude * 0.9);
}

// 3. Yaw always stays within one turn.
check("yaw stays within 0..2π", samples.every(({ m }) => m.yaw >= 0 && m.yaw <= TWO_PI + 1e-9));

// 4. Exactly the spin window is active: yaw is non-zero only while position <
//    spinDuration, and zero (idle) afterwards.
{
  const spinning = samples.filter(({ m }) => m.yaw > 1e-6);
  const allWithinWindow = spinning.every(({ t }) => t < params.spinDuration + 0.02);
  const idleAfter = samples.filter(({ t }) => t > params.spinDuration + 0.1).every(({ m }) => m.yaw === 0);
  check("spin is confined to its window, idle otherwise", allWithinWindow && idleAfter);
}

// 5. The spin completes a full turn: yaw climbs from ~0 to ~2π across the window.
{
  check("spin starts near 0", propMotion(0, params).yaw < 1e-6);
  const nearEnd = propMotion(params.spinDuration - 0.02, params).yaw;
  check("spin reaches nearly a full turn", nearEnd > TWO_PI * 0.98);
}

// 6. The motion repeats every spinCycle (deterministic and periodic in spin).
{
  const a = propMotion(1.7, params);
  const b = propMotion(1.7 + params.spinCycle, params);
  check("spin repeats each cycle", Math.abs(a.yaw - b.yaw) < 1e-9);
}

// 7. Determinism.
{
  const a = propMotion(2.345, params);
  const b = propMotion(2.345, params);
  check("motion is deterministic", a.yaw === b.yaw && a.bobY === b.bobY);
}

console.log(`bobSpin: ${passed}/${passed} checks passed`);
