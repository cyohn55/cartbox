/**
 * Unit tests for the pure, DOM-free logic in @cartbox/player:
 *   - display scaling (computeScaledSize)
 *   - keyboard-to-button resolution (resolveButton)
 *   - gamepad bitmask state (GamepadState)
 *
 * These assert the components' behavioural contract against real inputs and
 * outputs. Expected values are derived from invariants (aspect ratio, fit,
 * integer maximality, bit positions) rather than copied constants, so the tests
 * fail if the behaviour is wrong — not merely if a number changes.
 *
 * Run with Vitest, e.g.:
 *   npx vitest run "Unit Tests/player-core.test.ts"
 */

import { describe, expect, it } from "vitest";

import { computeScaledSize } from "../packages/player/src/display";
import {
  DEFAULT_KEY_BINDINGS,
  GamepadState,
  resolveButton,
} from "../packages/player/src/input";
import { ConsoleButton } from "../packages/player/src/types";

const NATIVE_WIDTH = 240;
const NATIVE_HEIGHT = 136;
const NATIVE_ASPECT = NATIVE_WIDTH / NATIVE_HEIGHT;

/** Representative containers: wide, tall, exact, and smaller-than-native. */
const CONTAINERS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1920, height: 1080 },
  { width: 800, height: 600 },
  { width: 300, height: 900 },
  { width: NATIVE_WIDTH, height: NATIVE_HEIGHT },
  { width: 120, height: 80 },
];

describe("computeScaledSize", () => {
  it("returns the exact multiplier and dimensions for a numeric scale", () => {
    for (const scale of [1, 2, 3.5]) {
      const size = computeScaledSize(9999, 9999, NATIVE_WIDTH, NATIVE_HEIGHT, scale);
      expect(size.scale).toBe(scale);
      expect(size.width).toBe(NATIVE_WIDTH * scale);
      expect(size.height).toBe(NATIVE_HEIGHT * scale);
    }
  });

  it('preserves aspect ratio and fills exactly one axis in "fit" mode', () => {
    for (const { width, height } of CONTAINERS) {
      const size = computeScaledSize(width, height, NATIVE_WIDTH, NATIVE_HEIGHT, "fit");

      // Aspect ratio is preserved.
      expect(size.width / size.height).toBeCloseTo(NATIVE_ASPECT, 6);

      // The image fits within the container...
      expect(size.width).toBeLessThanOrEqual(width + 1e-6);
      expect(size.height).toBeLessThanOrEqual(height + 1e-6);

      // ...and touches at least one edge (no wasted space on both axes).
      const touchesAnEdge =
        Math.abs(size.width - width) < 1e-6 || Math.abs(size.height - height) < 1e-6;
      expect(touchesAnEdge).toBe(true);
    }
  });

  it('yields a maximal whole-number scale that still fits in "integer" mode', () => {
    for (const { width, height } of CONTAINERS) {
      const size = computeScaledSize(width, height, NATIVE_WIDTH, NATIVE_HEIGHT, "integer");

      // Scale is a positive integer.
      expect(Number.isInteger(size.scale)).toBe(true);
      expect(size.scale).toBeGreaterThanOrEqual(1);

      // One more step would overflow the container on at least one axis,
      // i.e. the scale is as large as it can be (unless clamped to the 1x floor).
      const nextStepOverflows =
        (size.scale + 1) * NATIVE_WIDTH > width ||
        (size.scale + 1) * NATIVE_HEIGHT > height;
      const clampedToFloor = size.scale === 1;
      expect(nextStepOverflows || clampedToFloor).toBe(true);
    }
  });
});

describe("resolveButton", () => {
  it("maps every default binding to its declared console button", () => {
    for (const [keyCode, expectedButton] of Object.entries(DEFAULT_KEY_BINDINGS)) {
      expect(resolveButton(keyCode)).toBe(expectedButton);
    }
  });

  it("returns undefined for an unbound key", () => {
    expect(resolveButton("KeyQ")).toBeUndefined();
  });
});

describe("GamepadState", () => {
  it("sets and clears the bit for each button independently", () => {
    const state = new GamepadState();
    const buttons = [ConsoleButton.Up, ConsoleButton.A, ConsoleButton.Y];

    for (const button of buttons) {
      state.press(button);
      // The bit for this button must be set.
      expect(state.value & (1 << button)).toBe(1 << button);
    }

    for (const button of buttons) {
      state.release(button);
      expect(state.value & (1 << button)).toBe(0);
    }
  });

  it("combines simultaneously held buttons into one bitmask", () => {
    const state = new GamepadState();
    state.press(ConsoleButton.Left);
    state.press(ConsoleButton.B);

    const expectedMask = (1 << ConsoleButton.Left) | (1 << ConsoleButton.B);
    expect(state.value).toBe(expectedMask);
  });

  it("clears all buttons on reset", () => {
    const state = new GamepadState();
    state.press(ConsoleButton.Right);
    state.press(ConsoleButton.X);
    state.reset();
    expect(state.value).toBe(0);
  });
});
