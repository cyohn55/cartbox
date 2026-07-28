/**
 * Unit tests for button-driven UI navigation: the spatial focus picker the
 * D-pad cursor runs on, and the Konami detector that hands the controls to
 * the background mini-game.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import {
  KONAMI_SEQUENCE,
  KonamiDetector,
  pickInitialFocus,
  pickNextFocus,
  type FocusRect,
} from "../apps/web/src/app/console/consoleNavigation";
import type { ConsoleControl } from "../apps/web/src/app/console/consoleInput";

function rect(left: number, top: number, width = 40, height = 20): FocusRect {
  return { left, top, width, height };
}

describe("pickNextFocus", () => {
  //  [0]   [1]
  //  [2]   [3]
  const grid = [rect(0, 0), rect(100, 0), rect(0, 100), rect(100, 100)];

  it("moves right along a row", () => {
    expect(pickNextFocus(grid[0]!, grid, "right")).toBe(1);
  });

  it("moves down along a column", () => {
    expect(pickNextFocus(grid[1]!, grid, "down")).toBe(3);
  });

  it("moves back up and left", () => {
    expect(pickNextFocus(grid[3]!, grid, "up")).toBe(1);
    expect(pickNextFocus(grid[3]!, grid, "left")).toBe(2);
  });

  it("returns -1 at an edge with nothing beyond it", () => {
    expect(pickNextFocus(grid[0]!, grid, "up")).toBe(-1);
    expect(pickNextFocus(grid[0]!, grid, "left")).toBe(-1);
  });

  it("prefers the aligned neighbor over a nearer diagonal one", () => {
    const current = rect(0, 0);
    const candidates = [rect(60, 55), rect(0, 100)]; // diagonal-close vs straight-below
    expect(pickNextFocus(current, candidates, "down")).toBe(1);
  });

  it("skips candidates behind the pressed direction", () => {
    const current = rect(100, 0);
    expect(pickNextFocus(current, [rect(0, 0)], "right")).toBe(-1);
  });
});

describe("pickInitialFocus", () => {
  it("starts at the top-left-most element", () => {
    const candidates = [rect(200, 300), rect(10, 10), rect(150, 10)];
    expect(pickInitialFocus(candidates)).toBe(1);
  });

  it("returns -1 for no candidates", () => {
    expect(pickInitialFocus([])).toBe(-1);
  });
});

describe("KonamiDetector", () => {
  it("completes on the exact sequence", () => {
    const detector = new KonamiDetector();
    const results = KONAMI_SEQUENCE.map((control) => detector.feed(control));
    expect(results.slice(0, -1).every((hit) => hit === false)).toBe(true);
    expect(results.at(-1)).toBe(true);
  });

  it("survives an extra leading ↑ (overlap fallback)", () => {
    const detector = new KonamiDetector();
    const presses: ConsoleControl[] = ["up", ...KONAMI_SEQUENCE];
    const results = presses.map((control) => detector.feed(control));
    expect(results.at(-1)).toBe(true);
  });

  it("does not fire on garbage or a broken sequence", () => {
    const detector = new KonamiDetector();
    const presses: ConsoleControl[] = ["up", "up", "down", "down", "left", "right", "a", "b", "a", "b"];
    expect(presses.map((control) => detector.feed(control)).some(Boolean)).toBe(false);
  });

  it("can fire twice in a row", () => {
    const detector = new KonamiDetector();
    for (const control of KONAMI_SEQUENCE) detector.feed(control);
    const second = KONAMI_SEQUENCE.map((control) => detector.feed(control));
    expect(second.at(-1)).toBe(true);
  });
});
