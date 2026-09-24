/**
 * On-screen gamepad: two thumbsticks and an A/B/X/Y diamond. Every console
 * button stays reachable by touch — the left stick presses the D-pad directions
 * it leans toward, so button-only carts (and every menu) still steer — and a
 * cart that reads analog sticks (cartbox.stick) gets their positions through the
 * pmem words it opts into. A touchscreen in a keyboard/trackpad case — which
 * reports a *fine* primary pointer — must still get the pad.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_KEY_BINDINGS, GamepadState, TOUCH_LAYOUT, hasTouchSupport, stickVector } from "../packages/player/src/input";
import { packSticks, stickDirections, unpackSticks } from "../packages/player/src/sticks";
import { ConsoleButton } from "../packages/player/src/types";

describe("TOUCH_LAYOUT", () => {
  it("has the four face buttons, once each", () => {
    const buttons = TOUCH_LAYOUT.map((c) => c.button).sort((a, b) => a - b);
    expect(buttons).toEqual([ConsoleButton.A, ConsoleButton.B, ConsoleButton.X, ConsoleButton.Y]);
  });

  it("labels each face button with its keyboard equivalent", () => {
    const keyFor = (button: ConsoleButton) =>
      Object.entries(DEFAULT_KEY_BINDINGS).find(([, b]) => b === button)![0].replace("Key", "");
    for (const control of TOUCH_LAYOUT) expect(control.hint).toBe(keyFor(control.button));
  });

  it("places no two buttons in the same grid cell", () => {
    const cells = TOUCH_LAYOUT.map((c) => `${c.col},${c.row}`);
    expect(new Set(cells).size).toBe(cells.length);
  });
});

describe("thumbsticks", () => {
  it("map a thumb's offset to −1..1, clamped to the ring, with a dead zone", () => {
    expect(stickVector(2, -3, 50)).toEqual({ x: 0, y: 0 }); // resting thumb
    const full = stickVector(0, -200, 50); // dragged far past the ring
    expect(full.x).toBeCloseTo(0, 5);
    expect(full.y).toBeCloseTo(-1, 5);
    const half = stickVector(25, 0, 50);
    expect(half.x).toBeGreaterThan(0.3);
    expect(half.x).toBeLessThan(0.5);
  });

  it("press the D-pad with the left stick, eight-way, so button carts still steer", () => {
    expect(stickDirections(0, -1)).toBe(1 << ConsoleButton.Up);
    expect(stickDirections(0.9, 0.9)).toBe((1 << ConsoleButton.Down) | (1 << ConsoleButton.Right));
    expect(stickDirections(0.2, -0.2)).toBe(0); // a light lean is analog only

    const pad = new GamepadState();
    pad.setStick(0, -1, 0);
    expect(pad.value).toBe(1 << ConsoleButton.Left);
    pad.press(ConsoleButton.A);
    pad.setStick(0, 0, 0); // releasing the stick keeps a held button
    expect(pad.value).toBe(1 << ConsoleButton.A);
    pad.setStick(1, 1, 0); // the right stick is analog only
    expect(pad.value).toBe(1 << ConsoleButton.A);
    expect(pad.axes).toEqual([0, 0, 1, 0]);
  });

  it("pack into one pmem word as signed bytes, and back", () => {
    const word = packSticks([1, -1, 0.5, -0.25]);
    const [lx, ly, rx, ry] = unpackSticks(word);
    expect(lx).toBe(1);
    expect(ly).toBe(-1);
    expect(rx).toBeCloseTo(0.5, 1);
    expect(ry).toBeCloseTo(-0.25, 1);
    expect(packSticks([0, 0, 0, 0])).toBe(0);
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
