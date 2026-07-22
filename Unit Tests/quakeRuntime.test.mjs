/**
 * Unit tests for the `quake` catalog runtime — the control map
 * (apps/web/src/lib/quakeRuntime.ts), its catalog row (demoTitles.ts) and its
 * registration (titleRuntime.ts).
 *
 * Quake runs on WebQuake, which reads the legacy numeric `keyCode` (its
 * Sys.scantokey table). These tests assert the contract from the real
 * components: every forwarded button must deliver a keyCode WebQuake's *own*
 * scantokey recognises (parsed from the vendored engine, not a hard-coded list),
 * the shell-owned buttons must not reach the game, and the four face buttons must
 * between them reach both the menu and a confirm — or Quake's boot demo loop is
 * inescapable. The catalog row is checked for the Tier-B / non-priceable
 * invariants the licensing gate depends on.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/quakeRuntime.test.mjs"
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);

const { quakeKeyForControl, QUAKE_DEFAULT_TARGET } = await load("../apps/web/src/lib/quakeRuntime.ts");
const { CONTROL_KEY_CODES } = await load("../apps/web/src/app/console/consoleInput.ts");
const { DEMO_TITLES, findDemoTitle } = await load("../apps/web/src/lib/demoTitles.ts");
const { RUNTIME_IDS, resolveRuntime } = await load("../apps/web/src/lib/titleRuntime.ts");
const { licensePermitsCommercial } = await load("../apps/web/src/lib/licensing.ts");

const controls = Object.keys(CONTROL_KEY_CODES);

// Oracle: the exact keyCodes WebQuake's Sys.scantokey table maps, read straight
// from the vendored engine. If the map ever delivers a keyCode WebQuake ignores,
// this set won't contain it.
const sysSource = fs.readFileSync(
  path.resolve(here, "../games/webquake/WebQuake/Sys.js"),
  "utf8",
);
const recognisedKeyCodes = new Set(
  [...sysSource.matchAll(/Sys\.scantokey\[(\d+)\]/g)].map((match) => Number(match[1])),
);

// The map is total over the console's control set: a QuakeKey or null, never
// undefined, for every control the shell knows about.
for (const control of controls) {
  const key = quakeKeyForControl(control);
  assert.ok(
    key === null || (typeof key === "object" && key !== null),
    `quake map must cover the ${control} control`,
  );
}

// Every button the shell actually forwards (non-null in CONTROL_KEY_CODES) must
// resolve to a key WebQuake recognises, or it silently does nothing in-game.
const forwarded = controls.filter((control) => CONTROL_KEY_CODES[control] !== null);
for (const control of forwarded) {
  const key = quakeKeyForControl(control);
  assert.ok(key, `${control} is forwarded by the shell, so Quake must map it`);
  assert.ok(
    Number.isInteger(key.keyCode) && key.keyCode > 0,
    `${control} must have a non-zero keyCode (WebQuake reads keyCode)`,
  );
  assert.ok(
    recognisedKeyCodes.has(key.keyCode),
    `${control} keyCode ${key.keyCode} must be one WebQuake's scantokey recognises`,
  );
  assert.ok(
    typeof key.code === "string" && key.code.length > 0,
    `${control} must carry a modern code for the synthetic event`,
  );
}

// Shell-owned controls (shoulders, Start, Select) are never forwarded to a game.
for (const reserved of ["l1", "l2", "r1", "r2", "start", "select"]) {
  assert.equal(quakeKeyForControl(reserved), null, `${reserved} must not reach Quake`);
}

// Design invariant, asserted from the map: within the forwarded buttons a player
// can drive the d-pad (four arrows), fire (Ctrl), open the menu (Escape) and
// confirm (Enter) — the last two being what makes Quake's boot menu reachable at
// all on a four-button handheld.
const forwardedKeyCodes = new Set(forwarded.map((control) => quakeKeyForControl(control).keyCode));
for (const arrow of [37, 38, 39, 40]) {
  assert.ok(forwardedKeyCodes.has(arrow), `the d-pad must drive arrow keyCode ${arrow}`);
}
assert.ok(forwardedKeyCodes.has(17), "a forwarded button must fire (Ctrl / keyCode 17)");
assert.ok(forwardedKeyCodes.has(27), "a forwarded button must open the menu (Escape / keyCode 27)");
assert.ok(forwardedKeyCodes.has(13), "a forwarded button must confirm (Enter / keyCode 13)");

// WebQuake boots to its own attract/menu, so there is no launch target.
assert.equal(QUAKE_DEFAULT_TARGET, "");

// An unknown control resolves to null rather than undefined.
assert.equal(quakeKeyForControl("nonexistent"), null);

// --- Catalog row ---
const quake = DEMO_TITLES.find((title) => title.slug === "quake");
assert.ok(quake, "the Quake catalog row must exist");
assert.equal(findDemoTitle(quake.id), quake, "findDemoTitle must resolve the row by id");
assert.equal(quake.runtime, "quake", "the row must select the quake runtime");
assert.equal(quake.bundleName, "quake", "Browse lists a title only when bundleName is set");
assert.equal(quake.assetSource, "bundled", "the shareware data ships with the console");
assert.equal(quake.tier, "B", "publisher freeware is Tier B");
assert.equal(
  licensePermitsCommercial(quake.license),
  false,
  "a Tier-B shareware licence must gate the title out of pricing",
);
assert.ok(quake.sourceUrl.length > 0, "a redistribution source must be recorded on the row");

// --- Runtime registration ---
assert.ok(RUNTIME_IDS.includes("quake"), "quake must be a registered runtime id");
const descriptor = resolveRuntime("quake");
assert.ok(descriptor, "the quake runtime must resolve to a descriptor");
assert.equal(descriptor.implemented, true, "the quake runtime must be marked implemented");

console.log("quakeRuntime.test: all assertions passed");
