/**
 * Tests for the ScummVM keyboard input scheme.
 *
 * Most ScummVM titles are point-and-click adventures driven by the pointer scheme
 * (covered by scummvm-runtime.test.ts). Action games like The Griffon Legend use
 * the keyboard scheme instead: the d-pad walks the hero and a face button attacks,
 * rather than nudging a cursor. These assert that the scheme selection and the
 * keyboard mapping are correct, and — critically — that turning on the keyboard
 * scheme does NOT change the pointer scheme the adventures rely on.
 */

import { describe, expect, it } from "vitest";

import {
  controlAction,
  controlActionFor,
  inputSchemeForTarget,
} from "../apps/web/src/lib/scummvmRuntime";

describe("inputSchemeForTarget", () => {
  it("selects the keyboard scheme for the action game (griffon)", () => {
    expect(inputSchemeForTarget("griffon")).toBe("keyboard");
  });

  it("keeps the pointer scheme for the point-and-click adventures", () => {
    for (const target of ["sky", "queen", "lure", "soltys", "drascula", "dreamweb"]) {
      expect(inputSchemeForTarget(target)).toBe("pointer");
    }
  });
});

describe("controlActionFor — keyboard scheme", () => {
  it("walks the hero with the d-pad arrow keys (not a cursor)", () => {
    expect(controlActionFor("keyboard", "up")).toEqual({ kind: "key", code: "ArrowUp" });
    expect(controlActionFor("keyboard", "down")).toEqual({ kind: "key", code: "ArrowDown" });
    expect(controlActionFor("keyboard", "left")).toEqual({ kind: "key", code: "ArrowLeft" });
    expect(controlActionFor("keyboard", "right")).toEqual({ kind: "key", code: "ArrowRight" });
  });

  it("attacks on A and opens the menu on B / Start", () => {
    expect(controlActionFor("keyboard", "a")).toEqual({ kind: "key", code: "ControlLeft" });
    expect(controlActionFor("keyboard", "b")).toEqual({ kind: "key", code: "Enter" });
    expect(controlActionFor("keyboard", "start")).toEqual({ kind: "key", code: "Escape" });
  });

  it("does not forward Select or the shoulders (shell owns eject)", () => {
    expect(controlActionFor("keyboard", "select")).toBeNull();
    expect(controlActionFor("keyboard", "l1")).toBeNull();
    expect(controlActionFor("keyboard", "r2")).toBeNull();
  });
});

describe("controlActionFor — pointer scheme is unchanged", () => {
  it("delegates to the original pointer mapping for every control", () => {
    for (const control of ["up", "down", "left", "right", "a", "b", "x", "y", "start", "select"] as const) {
      expect(controlActionFor("pointer", control)).toEqual(controlAction(control));
    }
  });

  it("still drives the d-pad as a cursor for adventures", () => {
    expect(controlActionFor("pointer", "up")).toEqual({ kind: "cursor", direction: "up" });
  });
});
