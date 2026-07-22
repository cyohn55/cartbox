/**
 * Unit tests for the console input layer (apps/web/src/app/console/consoleInput.ts)
 * as it pertains to the shoulder buttons and the scroll wheel added with the
 * redesigned handheld.
 *
 * The contract these assert, straight from the real ConsoleInputBus + the
 * CONTROL_KEY_CODES table:
 *   - Every ConsoleControl has a key-code entry (so a missing mapping is a
 *     compile-and-test failure, not a silent undefined at runtime).
 *   - The scroll wheel (wheelUp/wheelDown) and the four shoulders are *system*
 *     controls: while the bus forwards to a cartridge they emit NO synthetic key
 *     events (the TIC-80 gamepad has no bits for them), yet UI listeners still
 *     receive every event so the OS can drive tab/page navigation.
 *   - The gamepad controls (D-pad + face buttons) DO forward as key events, so
 *     the split is real and not blanket-suppression.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/consoleInput.test.mjs"
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.resolve(here, rel)).href);

const { ConsoleInputBus, CONTROL_KEY_CODES } = await load("../apps/web/src/app/console/consoleInput.ts");

/** A bus wired to a dispatcher that records every synthetic key event it emits. */
function busWithKeySpy() {
  const keyEvents = [];
  const bus = new ConsoleInputBus((type, code) => keyEvents.push({ type, code }));
  return { bus, keyEvents };
}

const SYSTEM_CONTROLS = ["wheelUp", "wheelDown", "l1", "l2", "r1", "r2", "start", "select"];
const GAMEPAD_CONTROLS = ["up", "down", "left", "right", "a", "b", "x", "y"];

test("the wheel controls exist and never map to a key code", () => {
  for (const control of ["wheelUp", "wheelDown"]) {
    assert.ok(control in CONTROL_KEY_CODES, `${control} is a known control`);
    assert.equal(CONTROL_KEY_CODES[control], null, `${control} does not forward to a game`);
  }
});

test("every control the bus can emit has a key-code table entry", () => {
  for (const control of [...SYSTEM_CONTROLS, ...GAMEPAD_CONTROLS]) {
    assert.ok(control in CONTROL_KEY_CODES, `${control} present in CONTROL_KEY_CODES`);
  }
});

test("UI listeners receive wheel + shoulder events regardless of forwarding", () => {
  const { bus } = busWithKeySpy();
  const seen = [];
  bus.subscribe((event) => seen.push(event));

  bus.setGameForwarding(true); // a cartridge owns the controls
  for (const control of SYSTEM_CONTROLS) {
    bus.press(control);
    bus.release(control);
  }

  // The OS still hears each control (press + release) so it can navigate tabs/pages.
  for (const control of SYSTEM_CONTROLS) {
    assert.ok(
      seen.some((e) => e.control === control && e.phase === "press"),
      `listener saw ${control} press`,
    );
  }
});

test("system controls emit no key events while forwarding to a game", () => {
  const { bus, keyEvents } = busWithKeySpy();
  bus.setGameForwarding(true);
  for (const control of SYSTEM_CONTROLS) {
    bus.press(control);
    bus.release(control);
  }
  assert.equal(keyEvents.length, 0, "no synthetic keys from wheel/shoulders/start/select");
});

test("gamepad controls DO forward as key events while a game owns the bus", () => {
  const { bus, keyEvents } = busWithKeySpy();
  bus.setGameForwarding(true);
  for (const control of GAMEPAD_CONTROLS) {
    bus.press(control);
    bus.release(control);
  }
  // One keydown + one keyup per gamepad control.
  assert.equal(keyEvents.length, GAMEPAD_CONTROLS.length * 2, "each gamepad control forwards down+up");
  for (const control of GAMEPAD_CONTROLS) {
    const code = CONTROL_KEY_CODES[control];
    assert.ok(
      keyEvents.some((e) => e.type === "keydown" && e.code === code),
      `${control} forwarded keydown ${code}`,
    );
  }
});

test("nothing forwards to a game while the UI owns the bus", () => {
  const { bus, keyEvents } = busWithKeySpy();
  // Default owner is "ui" — no forwarding.
  for (const control of GAMEPAD_CONTROLS) {
    bus.press(control);
    bus.release(control);
  }
  assert.equal(keyEvents.length, 0, "UI-owned bus stays silent to the game");
});
