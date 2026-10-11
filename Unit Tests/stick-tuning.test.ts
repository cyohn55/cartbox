/**
 * Stick tuning (CONTROLLER_SETTINGS_ROADMAP.md C1): dead zones, the max input
 * threshold, response curves, sensitivity per axis, stick layouts and trigger
 * pull, and how saved settings from before them load.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTROL_SETTINGS,
  DEFAULT_PAD_BINDINGS,
  DEFAULT_STICK_DEAD_ZONES,
  applyLookSettings,
  deadZoned,
  layoutSticks,
  parseControlSettings,
  readPad,
  responseCurve,
  shapeStick,
} from "../packages/player/src/controls";
import { ConsoleButton } from "../packages/player/src/types";

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 5));

/** A standard-mapping pad with these axes and analog values on these buttons. */
function pad(axes: number[], values: Record<number, number> = {}, pressed: number[] = []) {
  return {
    mapping: "standard",
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) || (values[i] ?? 0) > 0.5, value: values[i] ?? (pressed.includes(i) ? 1 : 0) })),
  };
}

describe("dead zones", () => {
  it("reads a stick exactly as before by default (a 0.18 radial dead zone)", () => {
    for (const [x, y] of [[0.1, 0.05], [0.3, -0.2], [0.7, 0.7], [-1, 0]] as const) {
      close(shapeStick(x, y, DEFAULT_STICK_DEAD_ZONES), deadZoned(x, y));
    }
  });

  it("drops a small sideways drift with an axial dead zone, so a push straight up stays straight", () => {
    const [x, y] = shapeStick(0.1, -0.9, { axial: 0.15, radial: 0, maxInput: 1 });
    expect(x).toBe(0);
    expect(y).toBeLessThan(-0.8);
    // Without it, the drift comes through.
    expect(shapeStick(0.1, -0.9, { axial: 0, radial: 0, maxInput: 1 })[0]).toBeCloseTo(0.1, 5);
  });

  it("reads full lean at the max input threshold, and scales between it and the dead zone", () => {
    const [x] = shapeStick(0.85, 0, { axial: 0, radial: 0.1, maxInput: 0.85 });
    expect(x).toBeCloseTo(1, 5);
    // Half-way between the dead zone and the threshold reads half.
    expect(shapeStick(0.475, 0, { axial: 0, radial: 0.1, maxInput: 0.85 })[0]).toBeCloseTo(0.5, 5);
    // Inside the radial dead zone: nothing.
    expect(shapeStick(0.06, 0.06, { axial: 0, radial: 0.1, maxInput: 0.85 })).toEqual([0, 0]);
  });
});

describe("look response", () => {
  it("curves lean as its name says, and every curve reaches full at full lean", () => {
    expect(responseCurve("standard", 0.5)).toBe(0.5);
    expect(responseCurve("precision", 0.5)).toBeCloseTo(0.25, 5); // slower off centre
    expect(responseCurve("responsive", 0.25)).toBeCloseTo(0.5, 5); // quicker off centre
    expect(responseCurve("dynamic", 0.2)).toBeLessThan(0.2); // fine near the centre
    expect(responseCurve("dynamic", 0.5)).toBeCloseTo(0.5, 5); // steepest mid-way
    for (const c of ["standard", "dynamic", "precision", "responsive"] as const) {
      expect(responseCurve(c, 1)).toBeCloseTo(1, 5);
      expect(responseCurve(c, 0)).toBe(0);
    }
  });

  it("curves the look stick's distance and keeps its direction; the move stick passes", () => {
    const [mx, my, x, y] = applyLookSettings([0.3, -0.4, 0.3, 0.4], { invertY: false, lookSensitivity: 1, lookCurve: "precision" });
    expect([mx, my]).toEqual([0.3, -0.4]);
    expect(Math.hypot(x, y)).toBeCloseTo(0.25, 5); // 0.5 lean → 0.25
    expect(x / y).toBeCloseTo(0.75, 5); // same direction
  });

  it("scales and inverts each look axis on its own", () => {
    close(applyLookSettings([0, 0, 0.2, 0.2], { invertY: false, lookSensitivity: 2, lookSensitivityY: 0.5 }), [0, 0, 0.4, 0.1]);
    close(applyLookSettings([0, 0, 0.2, 0.2], { invertY: true, invertX: true, lookSensitivity: 1 }), [0, 0, -0.2, -0.2]);
    // Vertical follows horizontal when only one is set (settings from before there were two).
    close(applyLookSettings([0, 0, 0.2, 0.2], { invertY: false, lookSensitivity: 2 }), [0, 0, 0.4, 0.4]);
  });
});

describe("stick layouts", () => {
  const sticks = [0.1, 0.2, 0.3, 0.4]; // left x, left y, right x, right y
  it("maps the physical sticks to move and look", () => {
    expect(layoutSticks(sticks, "default")).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(layoutSticks(sticks, "southpaw")).toEqual([0.3, 0.4, 0.1, 0.2]);
    // Legacy: left moves forward/back (its y) and turns (its x); right strafes (its x) and looks up/down (its y).
    expect(layoutSticks(sticks, "legacy")).toEqual([0.3, 0.2, 0.1, 0.4]);
    expect(layoutSticks(sticks, "legacySouthpaw")).toEqual([0.1, 0.4, 0.3, 0.2]);
  });

  it("is applied to a controller after each physical stick's own dead zones", () => {
    // Southpaw: the right stick moves. The right stick's dead zone (0.4) swallows its 0.3 lean.
    const read = readPad(pad([0.9, 0, 0.3, 0]), DEFAULT_PAD_BINDINGS, {
      stickLayout: "southpaw",
      rightStick: { axial: 0, radial: 0.4, maxInput: 1 },
    });
    expect(read.axes[0]).toBe(0); // move x: from the right stick, inside its dead zone
    expect(read.axes[2]).toBeGreaterThan(0.8); // look x: the left stick, past the default dead zone
    // The left stick moving still drives the D-pad in the default layout only through move.
  });
});

describe("triggers", () => {
  it("press at the player's pull, each trigger its own", () => {
    const light = pad([0, 0, 0, 0], { 6: 0.3, 7: 0.3 });
    expect(readPad(light, DEFAULT_PAD_BINDINGS).mask).toBe(0); // the default pull is half-way
    const hair = readPad(light, DEFAULT_PAD_BINDINGS, { leftTrigger: 0.2, rightTrigger: 0.6 });
    expect(hair.pressed.has("LT")).toBe(true);
    expect(hair.pressed.has("RT")).toBe(false);
    expect(hair.mask).toBe(1 << ConsoleButton.X); // LT does X by default
  });

  it("count a trigger that only reports on or off as pressed when on", () => {
    const digital = pad([0, 0, 0, 0], {}, [7]);
    digital.buttons[7] = { pressed: true, value: 0 };
    expect(readPad(digital, DEFAULT_PAD_BINDINGS, { rightTrigger: 0.9 }).pressed.has("RT")).toBe(true);
  });
});

describe("saved settings", () => {
  it("load from before stick tuning as they played", () => {
    const old = parseControlSettings({ invertY: true, lookSensitivity: 2 });
    expect(old.lookSensitivityY).toBe(2);
    expect(old.lookCurve).toBe("standard");
    expect(old.leftStick).toEqual(DEFAULT_STICK_DEAD_ZONES);
    expect(old.stickLayout).toBe("default");
    expect(old.rightTrigger).toBe(0.5);
  });

  it("keep only valid values", () => {
    const parsed = parseControlSettings({
      lookSensitivity: 1,
      lookSensitivityY: 9,
      lookCurve: "wobbly",
      stickLayout: "upsideDown",
      leftStick: { axial: 2, radial: 0.45, maxInput: 0.5 },
      rightTrigger: 0,
    });
    expect(parsed.lookSensitivityY).toBe(3);
    expect(parsed.lookCurve).toBe("standard");
    expect(parsed.stickLayout).toBe("default");
    expect(parsed.leftStick!.axial).toBe(0.5);
    // Full lean always lies past the dead zone.
    expect(parsed.leftStick!.maxInput).toBeCloseTo(0.55, 5);
    expect(parsed.rightTrigger).toBe(0.05);
  });

  it("round-trip the defaults", () => {
    expect(parseControlSettings(JSON.parse(JSON.stringify(DEFAULT_CONTROL_SETTINGS)))).toEqual(DEFAULT_CONTROL_SETTINGS);
  });
});
