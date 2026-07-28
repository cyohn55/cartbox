/**
 * Tests for the `supertux` runtime input mapping.
 *
 * SuperTux is keyboard-driven, so the whole host contract is: which SuperTux key
 * does each console button press, and which buttons the shell keeps for itself.
 * These assert that map against SuperTux's real default bindings (arrows, Space
 * = jump, Left Ctrl = action, Left Shift = item, Enter = menu-select, Escape =
 * pause) so a regression in either the map or SuperTux's expectations is caught.
 */

import { describe, expect, it } from "vitest";

import {
  SUPERTUX_DEFAULT_TARGET,
  supertuxKeyForControl,
} from "../apps/web/src/lib/supertuxRuntime";

// Kept local so the test states SuperTux's contract explicitly rather than
// importing the same table it is meant to verify.
const EXPECTED: Record<string, string | null> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  a: "Space", // jump — also confirms menus (menu_manager accepts JUMP)
  b: "ControlLeft", // action: run + shoot
  x: "ShiftLeft", // use/peek held item
  y: "Enter", // menu select
  start: "Escape", // pause / open menu / back
  select: null, // OS ejects; never forwarded
  l1: null,
  l2: null,
  r1: null,
  r2: null,
};

describe("supertuxKeyForControl", () => {
  it("maps every console control to SuperTux's expected key or null", () => {
    for (const [control, key] of Object.entries(EXPECTED)) {
      expect(supertuxKeyForControl(control as never)).toBe(key);
    }
  });

  it("keeps Select and the shoulders for the shell (not forwarded)", () => {
    expect(supertuxKeyForControl("select")).toBeNull();
    expect(supertuxKeyForControl("l1")).toBeNull();
    expect(supertuxKeyForControl("l2")).toBeNull();
    expect(supertuxKeyForControl("r1")).toBeNull();
    expect(supertuxKeyForControl("r2")).toBeNull();
  });

  it("puts jump on A so the primary button both jumps and confirms menus", () => {
    // menu_manager.cpp accepts Control::JUMP to confirm, and Space is JUMP.
    expect(supertuxKeyForControl("a")).toBe("Space");
  });

  it("routes the four directions to the arrow keys SuperTux navigates with", () => {
    expect(supertuxKeyForControl("up")).toBe("ArrowUp");
    expect(supertuxKeyForControl("down")).toBe("ArrowDown");
    expect(supertuxKeyForControl("left")).toBe("ArrowLeft");
    expect(supertuxKeyForControl("right")).toBe("ArrowRight");
  });

  it("boots to SuperTux's own title screen (no launch target)", () => {
    expect(SUPERTUX_DEFAULT_TARGET).toBe("");
  });
});
