/**
 * Every device its own (CONTROLLER_SETTINGS_ROADMAP.md C4): the device doing
 * the looking brings its own sensitivity and curve, the mouse's movement
 * becomes look, and saved settings from before load as they played.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTROL_SETTINGS,
  DEFAULT_MOUSE_LOOK,
  MOUSE_FULL_LEAN_PX,
  applyLookSettings,
  lookProfileFor,
  mouseLean,
  parseControlSettings,
} from "../packages/player/src/controls";
import { GamepadState } from "../packages/player/src/input";

describe("look profiles", () => {
  const settings = parseControlSettings({
    invertY: true,
    lookSensitivity: 2,
    lookCurve: "precision",
    touchLook: { sensitivity: 0.5, sensitivityY: 0.75, curve: "standard" },
    mouseLook: { sensitivity: 1.5, curve: "responsive" },
  });

  it("gives each device its own sensitivity and curve, sharing inversion", () => {
    expect(lookProfileFor(settings, "controller")).toBe(settings);
    const touch = lookProfileFor(settings, "touch");
    expect([touch.lookSensitivity, touch.lookSensitivityY, touch.lookCurve, touch.invertY]).toEqual([0.5, 0.75, "standard", true]);
    const mouse = lookProfileFor(settings, "mouse");
    expect([mouse.lookSensitivity, mouse.lookSensitivityY, mouse.lookCurve]).toEqual([1.5, 1.5, "responsive"]);
    // The same lean looks differently by device.
    expect(applyLookSettings([0, 0, 0.4, 0], lookProfileFor(settings, "touch"))[2]).toBeCloseTo(0.2, 5);
    expect(applyLookSettings([0, 0, 0.4, 0], lookProfileFor(settings, "controller"))[2]).toBeCloseTo(0.32, 5); // 0.4² × 2
  });

  it("load from before, touch looking as the controller did, the mouse on Responsive", () => {
    const old = parseControlSettings({ invertY: false, lookSensitivity: 1.6, lookCurve: "dynamic" });
    expect(old.touchLook).toEqual({ sensitivity: 1.6, sensitivityY: 1.6, curve: "dynamic" });
    expect(old.mouseLook).toEqual(DEFAULT_MOUSE_LOOK);
    expect(old.mouseCapture).toBe(false);
    expect(parseControlSettings(JSON.parse(JSON.stringify(DEFAULT_CONTROL_SETTINGS)))).toEqual(DEFAULT_CONTROL_SETTINGS);
  });

  it("keep only valid values", () => {
    const parsed = parseControlSettings({ lookSensitivity: 1, mouseLook: { sensitivity: 50, sensitivityY: "fast", curve: "wiggly" }, mouseCapture: 1 });
    expect(parsed.mouseLook).toEqual({ sensitivity: 3, sensitivityY: 3, curve: "responsive" });
    expect(parsed.mouseCapture).toBe(false);
  });
});

describe("mouse look", () => {
  it("turns a tick's movement into lean, full at the full-lean distance", () => {
    expect(mouseLean(MOUSE_FULL_LEAN_PX / 2, -MOUSE_FULL_LEAN_PX)).toEqual([0.5, -1]);
    expect(mouseLean(1000, 0)).toEqual([1, 0]);
    expect(mouseLean(0, 0)).toEqual([0, 0]);
  });

  it("looks in place of the sticks while it moves, and says so", () => {
    const state = new GamepadState();
    state.setPad(0, [0.5, 0, 0.2, 0]);
    expect(state.lookDevice).toBe("controller");
    state.setMouseLook(0.6, -0.1);
    expect(state.lookDevice).toBe("mouse");
    expect(state.axes).toEqual([0.5, 0, 0.6, -0.1]); // moving stays the controller's
    state.setMouseLook(0, 0);
    expect(state.lookDevice).toBe("controller");
    expect(state.axes[2]).toBe(0.2);
  });

  it("leaves the look to the touch pad when only it leans", () => {
    const state = new GamepadState();
    state.setStick(1, 0.3, 0);
    expect(state.lookDevice).toBe("touch");
    expect(state.axes[2]).toBe(0.3);
  });
});
