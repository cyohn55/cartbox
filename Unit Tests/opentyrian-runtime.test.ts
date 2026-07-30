/**
 * Tests for the `opentyrian` runtime input mapping.
 *
 * OpenTyrian2000 is keyboard-driven, so the whole host contract is: which Tyrian
 * key does each console button press, and which buttons the shell keeps for
 * itself. These assert that map against Tyrian's documented default controls
 * (arrows = move, Space = fire, Enter = rear-weapon toggle, Left Ctrl / Left Alt
 * = sidekicks, Escape = pause) so a regression in either the map or the engine's
 * expectations is caught.
 */

import { describe, expect, it } from "vitest";

import { opentyrianKeyForControl } from "../apps/web/src/lib/opentyrianRuntime";

// Kept local so the test states the engine's contract explicitly rather than
// importing the same table it is meant to verify.
const EXPECTED: Record<string, string | null> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  a: "Space", // fire main weapon — also advances the intro and confirms
  b: "Enter", // toggle rear-weapon fire mode / menu confirm
  x: "ControlLeft", // left sidekick fire
  y: "AltLeft", // right sidekick fire
  start: "Escape", // pause / open menu / back
  select: null, // OS ejects; never forwarded
  wheelUp: null,
  wheelDown: null,
  l1: null,
  l2: null,
  r1: null,
  r2: null,
};

describe("opentyrianKeyForControl", () => {
  it("maps every console control to Tyrian's expected key or null", () => {
    for (const [control, key] of Object.entries(EXPECTED)) {
      expect(opentyrianKeyForControl(control as never)).toBe(key);
    }
  });

  it("keeps Select, the shoulders and the wheel for the shell (not forwarded)", () => {
    expect(opentyrianKeyForControl("select")).toBeNull();
    expect(opentyrianKeyForControl("wheelUp")).toBeNull();
    expect(opentyrianKeyForControl("wheelDown")).toBeNull();
    expect(opentyrianKeyForControl("l1")).toBeNull();
    expect(opentyrianKeyForControl("l2")).toBeNull();
    expect(opentyrianKeyForControl("r1")).toBeNull();
    expect(opentyrianKeyForControl("r2")).toBeNull();
  });

  it("puts fire on A so the primary button both shoots and advances menus", () => {
    // Space is Tyrian's fire key and also confirms the intro/menu screens.
    expect(opentyrianKeyForControl("a")).toBe("Space");
  });

  it("routes the four directions to the arrow keys Tyrian flies and navigates with", () => {
    expect(opentyrianKeyForControl("up")).toBe("ArrowUp");
    expect(opentyrianKeyForControl("down")).toBe("ArrowDown");
    expect(opentyrianKeyForControl("left")).toBe("ArrowLeft");
    expect(opentyrianKeyForControl("right")).toBe("ArrowRight");
  });

  it("assigns the two sidekicks to distinct modifier keys (Ctrl / Alt)", () => {
    expect(opentyrianKeyForControl("x")).toBe("ControlLeft");
    expect(opentyrianKeyForControl("y")).toBe("AltLeft");
    expect(opentyrianKeyForControl("x")).not.toBe(opentyrianKeyForControl("y"));
  });
});
