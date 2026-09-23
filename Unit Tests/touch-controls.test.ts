/**
 * On-screen gamepad: every console button must be reachable by touch (Lockout
 * strafes on X and swaps on Y), and a touchscreen in a keyboard/trackpad case —
 * which reports a *fine* primary pointer — must still get the pad.
 */

import { describe, expect, it } from "vitest";

import { TOUCH_LAYOUT, hasTouchSupport, DEFAULT_KEY_BINDINGS } from "../packages/player/src/input";
import { ConsoleButton } from "../packages/player/src/types";

describe("TOUCH_LAYOUT", () => {
  it("exposes all eight console buttons exactly once", () => {
    const buttons = TOUCH_LAYOUT.map((c) => c.button).sort((a, b) => a - b);
    expect(buttons).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("labels each face button with its keyboard equivalent", () => {
    const keyFor = (button: ConsoleButton) =>
      Object.entries(DEFAULT_KEY_BINDINGS).find(([, b]) => b === button)![0].replace("Key", "");
    for (const control of TOUCH_LAYOUT.filter((c) => c.cluster === "face")) {
      expect(control.hint).toBe(keyFor(control.button));
    }
  });

  it("places no two controls in the same grid cell of a cluster", () => {
    const cells = TOUCH_LAYOUT.map((c) => `${c.cluster}:${c.col},${c.row}`);
    expect(new Set(cells).size).toBe(cells.length);
  });
});

describe("hasTouchSupport", () => {
  it("is true for a touchscreen even when the primary pointer is fine (iPad + keyboard case)", () => {
    expect(hasTouchSupport(5, false)).toBe(true);
  });
  it("is true for a coarse pointer", () => {
    expect(hasTouchSupport(0, true)).toBe(true);
  });
  it("is false for a plain desktop", () => {
    expect(hasTouchSupport(0, false)).toBe(false);
  });
});
