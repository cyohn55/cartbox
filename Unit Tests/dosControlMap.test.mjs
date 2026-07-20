/**
 * Unit tests for the per-bundle DOS control mapping
 * (apps/web/src/lib/dosRuntime.ts).
 *
 * A DOS title runs in DOSBox and reads the legacy numeric `keyCode`, so each
 * console button must resolve to a real DOS key with a non-zero keyCode. Most
 * games keep their arrow-key layout (the shared default); C-Dogs is the
 * exception and is remapped to WASD. These tests assert those contracts from the
 * maps themselves — the control set, the delivered keys, and the keyCode/code
 * pairing invariant DOSBox depends on — rather than from a hard-coded key list.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/dosControlMap.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  pathToFileURL(path.resolve(here, "../apps/web/src/lib/dosRuntime.ts")).href
);
const { dosControlMap, dosKeyForControl } = mod;

const DEFAULT = dosControlMap("wolf3d");
const CDOGS = dosControlMap("cdogs");
const controls = Object.keys(DEFAULT);

// Every forwarded key DOSBox receives must carry a non-zero legacy keyCode and a
// matching modern code, or the SDL 1.2 backend silently drops it.
function assertDeliverable(map, label) {
  for (const control of controls) {
    const key = map[control];
    if (key === null) continue;
    assert.ok(
      typeof key.code === "string" && key.code.length > 0,
      `${label}.${control} must have a non-empty code`,
    );
    assert.ok(
      Number.isInteger(key.keyCode) && key.keyCode > 0,
      `${label}.${control} must have a non-zero keyCode (DOSBox reads it)`,
    );
  }
}

// An unknown bundle falls back to the shared default rather than throwing.
assert.deepEqual(
  dosControlMap("some-unshipped-game"),
  DEFAULT,
  "unknown bundles must use the arrow-key default",
);

// Both maps are total over the same control set, so no button is left undefined.
assert.deepEqual(
  Object.keys(CDOGS).sort(),
  controls.slice().sort(),
  "every map must cover the same console controls",
);

assertDeliverable(DEFAULT, "default");
assertDeliverable(CDOGS, "cdogs");

// The default drives the d-pad through the arrow keys DOS games use for menus
// and movement; C-Dogs drives it through WASD, the layout its OPTIONS.CNF binds.
for (const dir of ["up", "down", "left", "right"]) {
  assert.match(DEFAULT[dir].code, /^Arrow/, `default ${dir} must be an arrow key`);
  assert.match(CDOGS[dir].code, /^Key[WASD]$/, `cdogs ${dir} must be a WASD key`);
}

// The two maps genuinely differ on movement — the whole reason the map is
// per-bundle — while both keep the OS-reserved controls unforwarded.
assert.notDeepEqual(DEFAULT.up, CDOGS.up, "default and cdogs movement must differ");
for (const reserved of ["select", "l1", "l2", "r1", "r2"]) {
  assert.equal(DEFAULT[reserved], null, `${reserved} must not be forwarded (default)`);
  assert.equal(CDOGS[reserved], null, `${reserved} must not be forwarded (cdogs)`);
}

// dosKeyForControl is the map lookup: it must agree with the resolved map for
// every control and every bundle, including the fallback.
for (const bundle of ["wolf3d", "cdogs", "unknown"]) {
  const map = dosControlMap(bundle);
  for (const control of controls) {
    assert.deepEqual(
      dosKeyForControl(bundle, control),
      map[control],
      `dosKeyForControl(${bundle}, ${control}) must match the bundle's map`,
    );
  }
}

// A control outside the known set resolves to null rather than undefined.
assert.equal(dosKeyForControl("wolf3d", "nonexistent"), null);

console.log("dosControlMap.test: all assertions passed");
