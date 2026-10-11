/**
 * Look speed the game honours (CONTROLLER_SETTINGS_ROADMAP.md C2): the gain word
 * the host writes into pmem 69 for a cart that reads cartbox.lookgain, the
 * unscaled look stick it gets instead, look acceleration, and the new settings.
 */
import { describe, expect, it } from "vitest";

import {
  LOOK_ACCEL_DELAY_TICKS,
  LOOK_ACCEL_RAMP_TICKS,
  applyLookSettings,
  lookAccelerationBoost,
  lookGains,
  parseControlSettings,
  stepLookAcceleration,
} from "../packages/player/src/controls";
import { LOOK_GAIN_OPTIN_MAGIC, STICK_OPTIN_MAGIC, packLookGain, stickChannel, unpackLookGain } from "../packages/player/src/sticks";

describe("the gain word", () => {
  it("round-trips gains in 1/64 steps, marked as the host's", () => {
    const word = packLookGain({ x: 2.5, y: 0.75, zoom: 0.5 });
    expect(word >>> 24).toBe(0x4c);
    expect(unpackLookGain(word)).toEqual({ x: 2.5, y: 0.75, zoom: 0.5 });
  });

  it("clamps gains to what a byte holds, and never to zero", () => {
    const g = unpackLookGain(packLookGain({ x: 9, y: 0, zoom: Number.NaN }))!;
    expect(g.x).toBeCloseTo(255 / 64, 5);
    expect(g.y).toBe(1 / 64);
    expect(g.zoom).toBe(1);
  });

  it("tells the cart's opt-ins apart", () => {
    expect(stickChannel(0)).toBe("off");
    expect(stickChannel(1234)).toBe("off");
    expect(stickChannel(STICK_OPTIN_MAGIC)).toBe("sticks");
    expect(stickChannel(LOOK_GAIN_OPTIN_MAGIC)).toBe("gain");
    expect(stickChannel(packLookGain({ x: 1, y: 1, zoom: 1 }))).toBe("gain");
    expect(unpackLookGain(STICK_OPTIN_MAGIC)).toBeNull();
  });
});

describe("a cart that reads its look gain", () => {
  const settings = { invertY: true, lookSensitivity: 2.5, lookSensitivityY: 0.5, zoomSensitivity: 0.6 };

  it("gets the look stick curved and inverted but not scaled, so full lean stays full lean", () => {
    expect(applyLookSettings([0.1, 0.2, 0.4, 0.4], settings, false)).toEqual([0.1, 0.2, 0.4, -0.4]);
    // A cart that only reads sticks still gets it scaled (and capped at full lean).
    expect(applyLookSettings([0, 0, 0.6, 0.4], settings)).toEqual([0, 0, 1, -0.2]);
  });

  it("gets each axis's sensitivity as its gain, and the zoom multiplier", () => {
    expect(lookGains(settings)).toEqual({ x: 2.5, y: 0.5, zoom: 0.6 });
    expect(lookGains({ lookSensitivity: 1.5 }, 2)).toEqual({ x: 3, y: 3, zoom: 1 });
  });
});

describe("look acceleration", () => {
  it("counts ticks only while the look stick is at full lean", () => {
    let held = 0;
    held = stepLookAcceleration(held, 1, 0);
    held = stepLookAcceleration(held, 0.7, 0.7);
    expect(held).toBe(2);
    expect(stepLookAcceleration(held, 0.5, 0)).toBe(0);
  });

  it("ramps after a short delay up to 1 + strength, and is off at 0", () => {
    expect(lookAccelerationBoost(LOOK_ACCEL_DELAY_TICKS, 0.8)).toBe(1);
    const mid = lookAccelerationBoost(LOOK_ACCEL_DELAY_TICKS + LOOK_ACCEL_RAMP_TICKS / 2, 0.8);
    expect(mid).toBeCloseTo(1.4, 5);
    expect(lookAccelerationBoost(LOOK_ACCEL_DELAY_TICKS + LOOK_ACCEL_RAMP_TICKS * 3, 0.8)).toBeCloseTo(1.8, 5);
    expect(lookAccelerationBoost(1000, 0)).toBe(1);
    expect(lookAccelerationBoost(1000, undefined)).toBe(1);
  });
});

describe("saved settings", () => {
  it("load from before C2 with no zoom change and no acceleration", () => {
    const old = parseControlSettings({ invertY: false, lookSensitivity: 1.2 });
    expect(old.zoomSensitivity).toBe(1);
    expect(old.lookAcceleration).toBe(0);
  });

  it("clamp zoom sensitivity and acceleration", () => {
    const parsed = parseControlSettings({ lookSensitivity: 1, zoomSensitivity: 5, lookAcceleration: -1 });
    expect(parsed.zoomSensitivity).toBe(2);
    expect(parsed.lookAcceleration).toBe(0);
  });
});
