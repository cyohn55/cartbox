/**
 * Tests for the `cavestory` runtime input mapping.
 *
 * Cave Story runs on NXEngine, which is keyboard-driven, so the host contract is:
 * which NXEngine key does each console button press, and which buttons the shell
 * keeps for itself. These assert the map against NXEngine's documented defaults
 * (src/input.cpp: arrows move, Z jump, X fire, A/S weapons, Q inventory) — with
 * the deliberate handheld choice to put inventory (not prev-weapon) on X, since a
 * player can still reach every weapon by cycling with Y.
 */

import { describe, expect, it } from "vitest";

import { cavestoryKeyForControl } from "../apps/web/src/lib/cavestoryRuntime";

const EXPECTED: Record<string, string | null> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  a: "KeyZ", // jump (NXEngine JUMPKEY = SDLK_z)
  b: "KeyX", // fire (FIREKEY = SDLK_x)
  x: "KeyQ", // inventory (INVENTORYKEY = SDLK_q)
  y: "KeyS", // next weapon (NEXTWPNKEY = SDLK_s)
  start: null,
  select: null,
  wheelUp: null,
  wheelDown: null,
  l1: null,
  l2: null,
  r1: null,
  r2: null,
};

describe("cavestoryKeyForControl", () => {
  it("maps every console control to NXEngine's expected key or null", () => {
    for (const [control, key] of Object.entries(EXPECTED)) {
      expect(cavestoryKeyForControl(control as never)).toBe(key);
    }
  });

  it("puts jump on A and fire on B (NXEngine's Z and X)", () => {
    expect(cavestoryKeyForControl("a")).toBe("KeyZ");
    expect(cavestoryKeyForControl("b")).toBe("KeyX");
  });

  it("keeps inventory reachable (X) and lets Y cycle weapons", () => {
    expect(cavestoryKeyForControl("x")).toBe("KeyQ"); // inventory
    expect(cavestoryKeyForControl("y")).toBe("KeyS"); // next weapon
  });

  it("routes the four directions to the arrow keys NXEngine moves with", () => {
    expect(cavestoryKeyForControl("up")).toBe("ArrowUp");
    expect(cavestoryKeyForControl("down")).toBe("ArrowDown");
    expect(cavestoryKeyForControl("left")).toBe("ArrowLeft");
    expect(cavestoryKeyForControl("right")).toBe("ArrowRight");
  });

  it("keeps Select, Start and the shoulders for the shell (not forwarded)", () => {
    expect(cavestoryKeyForControl("select")).toBeNull();
    expect(cavestoryKeyForControl("start")).toBeNull();
    expect(cavestoryKeyForControl("l1")).toBeNull();
    expect(cavestoryKeyForControl("r2")).toBeNull();
  });
});
