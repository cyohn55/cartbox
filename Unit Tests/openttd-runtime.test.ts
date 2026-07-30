/**
 * Tests for the `openttd` runtime input mapping.
 *
 * OpenTTD is a point-and-click tycoon with no keyboard-only play, so the console
 * drives an emulated cursor. The host contract this map defines is: what does each
 * console button *mean* — nudge the cursor, press a mouse button, zoom, or a key —
 * and which buttons the shell keeps for itself. These assert that contract so a
 * regression in the map (e.g. losing drag support by moving A off the left button)
 * is caught.
 */

import { describe, expect, it } from "vitest";

import {
  OPENTTD_CURSOR_PIXELS_PER_FRAME,
  openttdActionForControl,
  type OpenTtdAction,
} from "../apps/web/src/lib/openttdRuntime";

describe("openttdActionForControl", () => {
  it("maps the d-pad to one cursor-move axis each", () => {
    expect(openttdActionForControl("up")).toEqual<OpenTtdAction>({ kind: "move", axis: "y", dir: -1 });
    expect(openttdActionForControl("down")).toEqual<OpenTtdAction>({ kind: "move", axis: "y", dir: 1 });
    expect(openttdActionForControl("left")).toEqual<OpenTtdAction>({ kind: "move", axis: "x", dir: -1 });
    expect(openttdActionForControl("right")).toEqual<OpenTtdAction>({ kind: "move", axis: "x", dir: 1 });
  });

  it("puts the left mouse button on A so tap = click and hold = drag", () => {
    // Left button is the primary verb; the player presses on keydown and releases on
    // keyup, which is what turns a held A + d-pad move into a drag.
    expect(openttdActionForControl("a")).toEqual<OpenTtdAction>({ kind: "mouse", button: 0 });
  });

  it("puts the right mouse button on B (cancel / scroll the map)", () => {
    expect(openttdActionForControl("b")).toEqual<OpenTtdAction>({ kind: "mouse", button: 2 });
  });

  it("zooms with X/Y and, naturally, with the physical scroll wheel", () => {
    expect(openttdActionForControl("x")).toEqual<OpenTtdAction>({ kind: "wheel", dir: -1 });
    expect(openttdActionForControl("y")).toEqual<OpenTtdAction>({ kind: "wheel", dir: 1 });
    expect(openttdActionForControl("wheelUp")).toEqual<OpenTtdAction>({ kind: "wheel", dir: -1 });
    expect(openttdActionForControl("wheelDown")).toEqual<OpenTtdAction>({ kind: "wheel", dir: 1 });
  });

  it("closes the front window with Start (Escape)", () => {
    expect(openttdActionForControl("start")).toEqual<OpenTtdAction>({ kind: "key", code: "Escape", keyCode: 27 });
  });

  it("keeps Select and the shoulders for the shell (not forwarded)", () => {
    expect(openttdActionForControl("select")).toBeNull();
    expect(openttdActionForControl("l1")).toBeNull();
    expect(openttdActionForControl("l2")).toBeNull();
    expect(openttdActionForControl("r1")).toBeNull();
    expect(openttdActionForControl("r2")).toBeNull();
  });

  it("exposes a positive cursor speed the player and test share", () => {
    expect(OPENTTD_CURSOR_PIXELS_PER_FRAME).toBeGreaterThan(0);
  });
});
