/**
 * Unit tests for the `dos` runtime input map (js-dos / DOSBox).
 *
 * The map is the contract between the console's buttons and the DOS key events
 * DOSBox reads, so these tests assert it against two real sources of truth: the
 * set of console controls (enumerated from the shell's own CONTROL_KEY_CODES,
 * never re-listed here) and C-Dogs' documented Player 1 default bindings. A
 * DOSBox-specific invariant is also checked — every forwarded key must carry the
 * legacy numeric keyCode, because DOSBox's SDL 1.2 backend ignores code-only
 * events.
 */

import { describe, expect, it } from "vitest";

import { dosKeyForControl, type DosKey } from "../apps/web/src/lib/dosRuntime";
import {
  CONTROL_KEY_CODES,
  type ConsoleControl,
} from "../apps/web/src/app/console/consoleInput";

/** Every console control, taken from the shell's own map so the two cannot drift. */
const ALL_CONTROLS = Object.keys(CONTROL_KEY_CODES) as ConsoleControl[];

/** Controls the OS shell reserves and never forwards to a game. */
const OS_RESERVED: ConsoleControl[] = ["select", "l1", "l2", "r1", "r2"];

describe("dosKeyForControl — C-Dogs bindings (WASD via OPTIONS.CNF)", () => {
  it("maps the d-pad to WASD, the non-extended keys DOSBox delivers cleanly", () => {
    expect(dosKeyForControl("up")).toEqual<DosKey>({ code: "KeyW", keyCode: 87 });
    expect(dosKeyForControl("down")).toEqual<DosKey>({ code: "KeyS", keyCode: 83 });
    expect(dosKeyForControl("left")).toEqual<DosKey>({ code: "KeyA", keyCode: 65 });
    expect(dosKeyForControl("right")).toEqual<DosKey>({ code: "KeyD", keyCode: 68 });
  });

  it("puts C-Dogs Button 1 (fire / menu-select) on A as Space", () => {
    expect(dosKeyForControl("a")).toEqual<DosKey>({ code: "Space", keyCode: 32 });
  });

  it("puts C-Dogs Button 2 (weapon / slide / cancel) on B as Enter", () => {
    expect(dosKeyForControl("b")).toEqual<DosKey>({ code: "Enter", keyCode: 13 });
  });

  it("surfaces pause on Y (Esc) and leaves X unbound (automap's Tab is browser-reserved)", () => {
    expect(dosKeyForControl("y")).toEqual<DosKey>({ code: "Escape", keyCode: 27 });
    expect(dosKeyForControl("x")).toBeNull();
  });
});

describe("dosKeyForControl — invariants", () => {
  it("is total over every console control", () => {
    for (const control of ALL_CONTROLS) {
      // Must not throw and must return either a key or an explicit null.
      const key = dosKeyForControl(control);
      expect(key === null || typeof key === "object").toBe(true);
    }
  });

  it("forwards nothing for OS-reserved controls", () => {
    for (const control of OS_RESERVED) {
      expect(dosKeyForControl(control)).toBeNull();
    }
  });

  it("gives every forwarded key a non-empty code and a positive legacy keyCode", () => {
    // DOSBox's SDL 1.2 backend reads keyCode/which, so a zero or missing keyCode
    // would be a silently dead button.
    for (const control of ALL_CONTROLS) {
      const key = dosKeyForControl(control);
      if (key === null) continue;
      expect(key.code.length).toBeGreaterThan(0);
      expect(Number.isInteger(key.keyCode)).toBe(true);
      expect(key.keyCode).toBeGreaterThan(0);
    }
  });

  it("drives the game with the four directions plus A/B/Y, end to end", () => {
    // A control only reaches the game when the shell forwards it (a non-null
    // CONTROL_KEY_CODES entry) AND the map resolves it to a DOS key. Start is
    // mapped to Esc for completeness but the shell reserves it, and X is unbound
    // (automap's Tab is browser-reserved), so neither is in this effective set —
    // this asserts the real end-to-end forwarding.
    const drivesGame = ALL_CONTROLS.filter(
      (control) => CONTROL_KEY_CODES[control] !== null && dosKeyForControl(control) !== null,
    );
    expect(drivesGame.sort()).toEqual(["a", "b", "down", "left", "right", "up", "y"].sort());
  });
});
