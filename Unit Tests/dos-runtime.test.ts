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

/**
 * Bundle ids the map is resolved against. C-Dogs is the one title with bespoke
 * bindings; the second name stands for every stock-layout title (Wolfenstein 3D
 * and the rest), which falls through to the arrow-key default.
 */
const CDOGS_BUNDLE = "cdogs";
const STOCK_BUNDLE = "wolf3d";

describe("dosKeyForControl — C-Dogs bindings (WASD via OPTIONS.CNF)", () => {
  it("maps the d-pad to WASD, the non-extended keys DOSBox delivers cleanly", () => {
    expect(dosKeyForControl(CDOGS_BUNDLE, "up")).toEqual<DosKey>({ code: "KeyW", keyCode: 87 });
    expect(dosKeyForControl(CDOGS_BUNDLE, "down")).toEqual<DosKey>({ code: "KeyS", keyCode: 83 });
    expect(dosKeyForControl(CDOGS_BUNDLE, "left")).toEqual<DosKey>({ code: "KeyA", keyCode: 65 });
    expect(dosKeyForControl(CDOGS_BUNDLE, "right")).toEqual<DosKey>({ code: "KeyD", keyCode: 68 });
  });

  it("puts C-Dogs Button 1 (fire / menu-select) on A as Space", () => {
    expect(dosKeyForControl(CDOGS_BUNDLE, "a")).toEqual<DosKey>({ code: "Space", keyCode: 32 });
  });

  it("puts C-Dogs Button 2 (weapon / slide / cancel) on B as Enter", () => {
    expect(dosKeyForControl(CDOGS_BUNDLE, "b")).toEqual<DosKey>({ code: "Enter", keyCode: 13 });
  });

  it("surfaces pause on Y (Esc) and leaves X unbound (automap's Tab is browser-reserved)", () => {
    expect(dosKeyForControl(CDOGS_BUNDLE, "y")).toEqual<DosKey>({ code: "Escape", keyCode: 27 });
    expect(dosKeyForControl(CDOGS_BUNDLE, "x")).toBeNull();
  });
});

describe("dosKeyForControl — the stock arrow-key default", () => {
  it("drives a stock-layout title with the arrow keys, not C-Dogs' WASD", () => {
    expect(dosKeyForControl(STOCK_BUNDLE, "up")).toEqual<DosKey>({ code: "ArrowUp", keyCode: 38 });
    expect(dosKeyForControl(STOCK_BUNDLE, "left")).toEqual<DosKey>({ code: "ArrowLeft", keyCode: 37 });
  });

  it("covers the common shooter verbs so one map plays the menu and the game", () => {
    expect(dosKeyForControl(STOCK_BUNDLE, "a")?.code).toBe("ControlLeft");
    expect(dosKeyForControl(STOCK_BUNDLE, "b")?.code).toBe("Space");
    expect(dosKeyForControl(STOCK_BUNDLE, "x")?.code).toBe("Enter");
    expect(dosKeyForControl(STOCK_BUNDLE, "y")?.code).toBe("Escape");
  });

  it("falls back to the default for a bundle with no bespoke entry", () => {
    // An unknown bundle must still be playable rather than silently unbound.
    const unknown = dosKeyForControl("a-bundle-that-has-no-entry", "up");
    expect(unknown).toEqual(dosKeyForControl(STOCK_BUNDLE, "up"));
  });
});

describe("dosKeyForControl — invariants", () => {
  // Every invariant below must hold for every bundle, bespoke or default.
  const BUNDLES = [CDOGS_BUNDLE, STOCK_BUNDLE];

  it("is total over every console control", () => {
    for (const bundle of BUNDLES) {
      for (const control of ALL_CONTROLS) {
        // Must not throw and must return either a key or an explicit null.
        const key = dosKeyForControl(bundle, control);
        expect(key === null || typeof key === "object").toBe(true);
      }
    }
  });

  it("forwards nothing for OS-reserved controls", () => {
    for (const bundle of BUNDLES) {
      for (const control of OS_RESERVED) {
        expect(dosKeyForControl(bundle, control)).toBeNull();
      }
    }
  });

  it("gives every forwarded key a non-empty code and a positive legacy keyCode", () => {
    // DOSBox's SDL 1.2 backend reads keyCode/which, so a zero or missing keyCode
    // would be a silently dead button.
    for (const bundle of BUNDLES) {
      for (const control of ALL_CONTROLS) {
        const key = dosKeyForControl(bundle, control);
        if (key === null) continue;
        expect(key.code.length).toBeGreaterThan(0);
        expect(Number.isInteger(key.keyCode)).toBe(true);
        expect(key.keyCode).toBeGreaterThan(0);
      }
    }
  });

  it("drives C-Dogs with the four directions plus A/B/Y, end to end", () => {
    // A control only reaches the game when the shell forwards it (a non-null
    // CONTROL_KEY_CODES entry) AND the map resolves it to a DOS key. Start is
    // mapped to Esc for completeness but the shell reserves it, and X is unbound
    // (automap's Tab is browser-reserved), so neither is in this effective set —
    // this asserts the real end-to-end forwarding.
    const drivesGame = ALL_CONTROLS.filter(
      (control) =>
        CONTROL_KEY_CODES[control] !== null && dosKeyForControl(CDOGS_BUNDLE, control) !== null,
    );
    expect(drivesGame.sort()).toEqual(["a", "b", "down", "left", "right", "up", "y"].sort());
  });

  it("drives a stock-layout title with X bound as well, since its Enter is free", () => {
    const drivesGame = ALL_CONTROLS.filter(
      (control) =>
        CONTROL_KEY_CODES[control] !== null && dosKeyForControl(STOCK_BUNDLE, control) !== null,
    );
    expect(drivesGame.sort()).toEqual(["a", "b", "down", "left", "right", "up", "x", "y"].sort());
  });
});
