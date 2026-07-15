/**
 * Unit tests for mapping a handheld skin onto the console shell's CSS variables
 * (apps/web/src/app/console/handheldConsoleSkin.ts). Verifies each region drives
 * the right variable, gradient stops are derived (darker) from the base, and
 * malformed colours are skipped rather than emitted.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/handheldConsoleSkin.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);
const { handheldConsoleVariables } = await load("../apps/web/src/app/console/handheldConsoleSkin.ts");
const { darkenHexColor } = await load("../apps/web/src/app/console/consoleSettings.ts");

let passed = 0;

const scheme = {
  face: "#195ba6",
  dpadPanel: "#3a3d42",
  buttonPanel: "#e84d8a",
  decal: "#ffffff",
  text: "#ffffff",
  dpad: "#57d18d",
  dpadArrow: "#fad937",
  buttonLetter: "#fad937",
};

// 1. Each region drives the right shell variable, with derived darker stops.
{
  const vars = handheldConsoleVariables(scheme);
  assert.equal(vars["--hh-shell-a"], "#195ba6", "chassis -> shell body");
  assert.equal(vars["--hh-shell-b"], darkenHexColor("#195ba6", 0.22), "shell mid stop derived");
  assert.equal(vars["--hh-dpad-a"], "#57d18d", "d-pad -> dpad base");
  assert.equal(vars["--hh-joy-a"], "#57d18d", "d-pad -> joystick base");
  assert.equal(vars["--hh-control-a"], "#3a3d42", "d-pad panel -> control base");
  assert.equal(vars["--hh-face-ink"], "#fad937", "button letters -> face ink");
  // All four face buttons take the button panel colour.
  for (const key of ["x", "y", "a", "b"]) {
    assert.equal(vars[`--hh-face-${key}-hi`], "#e84d8a", `face ${key} hi`);
    assert.equal(vars[`--hh-face-${key}-lo`], darkenHexColor("#e84d8a", 0.35), `face ${key} lo derived`);
  }
  passed += 1;
}

// 2. The darker stops are actually darker than their base (numeric check).
{
  const vars = handheldConsoleVariables(scheme);
  const redOf = (hex) => parseInt(hex.slice(1, 3), 16);
  assert.ok(redOf(vars["--hh-shell-c"]) < redOf(vars["--hh-shell-a"]), "shell-c darker than shell-a");
  passed += 1;
}

// 3. Malformed colours are skipped, not emitted as invalid CSS.
{
  const vars = handheldConsoleVariables({ ...scheme, face: "not-a-color", dpad: "#GGG" });
  assert.ok(!("--hh-shell-a" in vars), "invalid chassis omitted");
  assert.ok(!("--hh-dpad-a" in vars), "invalid d-pad omitted");
  // Valid regions still come through.
  assert.equal(vars["--hh-face-ink"], "#fad937");
  passed += 1;
}

console.log(`PASS — handheldConsoleSkin: ${passed} checks green.`);
