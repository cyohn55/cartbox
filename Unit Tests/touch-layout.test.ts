/**
 * The player's own touch layout: where they moved the touch pad's sticks and
 * buttons and how big they made them, read defensively from storage, and each
 * control kept wholly on screen as it is dragged.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_CONTROL_SETTINGS, TOUCH_CONTROL_IDS, parseControlSettings, parseTouchLayout, placeWithin } from "../packages/player/src/controls";

describe("touch layout", () => {
  it("keeps every known control's spot and size", () => {
    const layout = parseTouchLayout({ leftStick: { x: 0.2, y: 0.7, size: 1.3 }, A: { x: 0.9, y: 0.8, size: 1 }, Start: { x: 0.5, y: 0.05, size: 0.8 } });
    expect(layout).toEqual({ leftStick: { x: 0.2, y: 0.7, size: 1.3 }, A: { x: 0.9, y: 0.8, size: 1 }, Start: { x: 0.5, y: 0.05, size: 0.8 } });
  });

  it("drops what it doesn't know and clamps what's out of range", () => {
    const layout = parseTouchLayout({
      leftStick: { x: -1, y: 4, size: 9 },
      B: { x: 0.5, y: 0.5 }, // no size: its usual size
      jetpack: { x: 0.5, y: 0.5, size: 1 },
      X: { x: "left", y: 0.5, size: 1 },
      Y: null,
    });
    expect(layout).toEqual({ leftStick: { x: 0, y: 1, size: 2 }, B: { x: 0.5, y: 0.5, size: 1 } });
    expect(parseTouchLayout("nonsense")).toEqual({});
    expect(parseTouchLayout([1, 2])).toEqual({});
  });

  it("names every control on the pad", () => {
    expect(TOUCH_CONTROL_IDS).toEqual(["leftStick", "rightStick", "A", "B", "X", "Y", "Start"]);
  });

  it("is part of the control settings: none moved by default, and saved settings from before load so", () => {
    expect(DEFAULT_CONTROL_SETTINGS.touchLayout).toEqual({});
    expect(parseControlSettings({ lookSensitivity: 1 }).touchLayout).toEqual({});
    const saved = parseControlSettings({ lookSensitivity: 1, touchLayout: { rightStick: { x: 0.7, y: 0.6, size: 1.5 } } });
    expect(saved.touchLayout).toEqual({ rightStick: { x: 0.7, y: 0.6, size: 1.5 } });
    expect(parseControlSettings(JSON.parse(JSON.stringify(saved))).touchLayout).toEqual(saved.touchLayout);
  });
});

describe("keeping a dragged control on screen", () => {
  it("leaves a control well inside alone", () => {
    expect(placeWithin(0.4, 0.6, 0.1, 0.1)).toEqual([0.4, 0.6]);
  });

  it("stops a control at the edges, by its own half-size", () => {
    expect(placeWithin(0.02, 0.99, 0.1, 0.2)).toEqual([0.1, 0.8]);
    expect(placeWithin(1.5, -0.5, 0.05, 0.05)).toEqual([0.95, 0.05]);
  });

  it("centres a control bigger than the screen", () => {
    expect(placeWithin(0.1, 0.9, 0.6, 0.7)).toEqual([0.5, 0.5]);
  });
});
