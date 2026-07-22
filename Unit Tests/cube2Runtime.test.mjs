/**
 * Unit tests for the `cube2` catalog runtime — the control map
 * (apps/web/src/lib/cube2Runtime.ts), its catalog row (demoTitles.ts) and its
 * registration (titleRuntime.ts).
 *
 * Cube 2 (Sauerbraten via BananaBread) is mouse-look only: it has no keyboard
 * turn, so the d-pad's left/right must be "turn" actions (synthetic mouse yaw)
 * while every other forwarded button is a keyboard key. These tests assert that
 * shape from the map itself — turn on left/right, keys elsewhere, the engine's
 * bind keys (W/S/SPACE/ESC and the F/Q that cartbox-boot.html binds), shoulders
 * unforwarded — plus the Tier-A catalog invariants.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/cube2Runtime.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);

const { cube2ActionForControl, CUBE2_TURN_PIXELS_PER_FRAME } = await load("../apps/web/src/lib/cube2Runtime.ts");
const { CONTROL_KEY_CODES } = await load("../apps/web/src/app/console/consoleInput.ts");
const { DEMO_TITLES, findDemoTitle } = await load("../apps/web/src/lib/demoTitles.ts");
const { RUNTIME_IDS, resolveRuntime } = await load("../apps/web/src/lib/titleRuntime.ts");

const controls = Object.keys(CONTROL_KEY_CODES);

// The map is total over the console control set: an action or null, never
// undefined, for every control.
for (const control of controls) {
  const action = cube2ActionForControl(control);
  assert.ok(
    action === null || (typeof action === "object" && (action.kind === "key" || action.kind === "turn")),
    `cube2 map must cover ${control} with a key/turn action or null`,
  );
}

// Every forwarded button (non-null in CONTROL_KEY_CODES) must resolve to an action.
const forwarded = controls.filter((control) => CONTROL_KEY_CODES[control] !== null);
for (const control of forwarded) {
  assert.ok(cube2ActionForControl(control), `${control} is forwarded, so cube2 must map it`);
}

// Sauerbraten has no keyboard turn: left/right must be *turn* actions in opposite
// directions, and no other control may be a turn.
const left = cube2ActionForControl("left");
const right = cube2ActionForControl("right");
assert.equal(left.kind, "turn", "d-pad left must synthesize a turn");
assert.equal(right.kind, "turn", "d-pad right must synthesize a turn");
assert.equal(left.direction, -1, "left turns one way");
assert.equal(right.direction, 1, "right turns the other");
assert.equal(left.direction, -right.direction, "left and right must turn in opposite directions");
for (const control of forwarded) {
  if (control === "left" || control === "right") continue;
  assert.equal(cube2ActionForControl(control).kind, "key", `${control} must be a key, not a turn`);
}

// Key actions carry a non-empty code and a positive legacy keyCode (BananaBread's
// SDL reads keyCode), and the movement/verb keys line up with the engine's binds.
for (const control of forwarded) {
  const action = cube2ActionForControl(control);
  if (action.kind !== "key") continue;
  assert.ok(typeof action.code === "string" && action.code.length > 0, `${control} needs a code`);
  assert.ok(Number.isInteger(action.keyCode) && action.keyCode > 0, `${control} needs a non-zero keyCode`);
}
assert.equal(cube2ActionForControl("up").code, "KeyW", "up = forward (bind W forward)");
assert.equal(cube2ActionForControl("down").code, "KeyS", "down = backward (bind S backward)");
assert.equal(cube2ActionForControl("b").code, "Space", "B = jump (bind SPACE jump)");
assert.equal(cube2ActionForControl("x").code, "Escape", "X = menu");
// F and Q are the keys cartbox-boot.html binds to attack/weapon.
assert.equal(cube2ActionForControl("a").code, "KeyF", "A = fire (bind F attack)");
assert.equal(cube2ActionForControl("y").code, "KeyQ", "Y = weapon (bind Q weapon)");

// Shell-owned controls never reach the game.
for (const reserved of ["l1", "l2", "r1", "r2", "start", "select"]) {
  assert.equal(cube2ActionForControl(reserved), null, `${reserved} must not reach Cube 2`);
}

// The turn speed constant is a positive integer the player and test share.
assert.ok(Number.isInteger(CUBE2_TURN_PIXELS_PER_FRAME) && CUBE2_TURN_PIXELS_PER_FRAME > 0);

// An unknown control resolves to null, not undefined.
assert.equal(cube2ActionForControl("nonexistent"), null);

// --- Catalog row ---
const cube2 = DEMO_TITLES.find((title) => title.slug === "cube2");
assert.ok(cube2, "the Cube 2 catalog row must exist");
assert.equal(findDemoTitle(cube2.id), cube2, "findDemoTitle must resolve the row by id");
assert.equal(cube2.runtime, "cube2", "the row must select the cube2 runtime");
assert.equal(cube2.bundleName, "cube2", "Browse lists a title only when bundleName is set");
assert.equal(cube2.assetSource, "bundled", "engine + assets ship with the console");
assert.equal(cube2.tier, "A", "free engine + free assets is Tier A");
assert.equal(cube2.license, "zlib", "Cube 2 is zlib-licensed");
assert.ok(cube2.sourceUrl.length > 0, "a source must be recorded on the row");

// --- Runtime registration ---
assert.ok(RUNTIME_IDS.includes("cube2"), "cube2 must be a registered runtime id");
const descriptor = resolveRuntime("cube2");
assert.ok(descriptor && descriptor.implemented === true, "the cube2 runtime must be marked implemented");

console.log("cube2Runtime.test: all assertions passed");
