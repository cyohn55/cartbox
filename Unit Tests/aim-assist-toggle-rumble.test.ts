/**
 * Aim assist, hold or toggle, and vibration (CONTROLLER_SETTINGS_ROADMAP.md C3):
 * toggled actions latching in the host, the rumble a game's request becomes
 * under the player's settings, the aim assist level beside the look gains, the
 * rumble event, and how saved settings load.
 */
import { describe, expect, it } from "vitest";

import { aimAssistLevel, applyActionToggles, parseControlSettings, rumbleEffect, toggleMask } from "../packages/player/src/controls";
import { MAILBOX_TYPE_RUMBLE, decodeMailbox } from "../packages/player/src/mailbox";
import { packLookGain, stickChannel, unpackLookGain } from "../packages/player/src/sticks";

describe("hold or toggle", () => {
  const actions = [{ name: "fire" }, { name: "jump" }, { name: "zoom" }];

  it("knows which actions toggle", () => {
    expect(toggleMask(actions, ["zoom"])).toBe(0b100);
    expect(toggleMask(actions, ["zoom", "fire", "nope"])).toBe(0b101);
    expect(toggleMask(actions, undefined)).toBe(0);
  });

  it("latches a toggled action on a press and releases it on the next, leaving held ones alone", () => {
    const zoom = 0b100;
    const fire = 0b001;
    let raw = 0;
    let latched = 0;
    const tick = (now: number) => {
      const out = applyActionToggles(now, raw, latched, zoom);
      raw = now;
      latched = out.latched;
      return out.held;
    };
    expect(tick(zoom)).toBe(zoom); // press: on
    expect(tick(0)).toBe(zoom); // released: still on
    expect(tick(zoom | fire)).toBe(fire); // pressed again: off; fire acts while held
    expect(tick(zoom)).toBe(0); // still held: no new press, stays off
    expect(tick(0)).toBe(0);
    expect(tick(zoom)).toBe(zoom);
  });
});

describe("vibration", () => {
  it("plays a game's rumble at the player's strength", () => {
    expect(rumbleEffect(0.8, 120, {})).toEqual({ duration: 120, strongMagnitude: 0.8, weakMagnitude: expect.closeTo(0.58, 5) });
    expect(rumbleEffect(0.8, 120, { vibrationStrength: 0.5 })!.strongMagnitude).toBeCloseTo(0.4, 5);
  });

  it("plays nothing with vibration off, for nothing, and never too long", () => {
    expect(rumbleEffect(1, 100, { vibration: false })).toBeNull();
    expect(rumbleEffect(0, 100, {})).toBeNull();
    expect(rumbleEffect(1, 0, {})).toBeNull();
    expect(rumbleEffect(2, 99999, {})).toMatchObject({ duration: 1500, strongMagnitude: 1, weakMagnitude: 0.7 });
  });

  it("reads a cart's rumble from the mailbox", () => {
    const words = new Uint32Array(25);
    words[0] = 1;
    words.set([MAILBOX_TYPE_RUMBLE, 204, 120], 1);
    expect(decodeMailbox(words, 0).events).toEqual([{ type: MAILBOX_TYPE_RUMBLE, kind: "rumble", id: 204, value: 120 }]);
  });
});

describe("aim assist", () => {
  it("is a level the cart reads: 0 off, 1 standard, 2 strong", () => {
    expect(aimAssistLevel("off")).toBe(0);
    expect(aimAssistLevel(undefined)).toBe(1);
    expect(aimAssistLevel("strong")).toBe(2);
  });

  it("travels in the gain word's low marker bits without disturbing the gains", () => {
    for (const assist of [0, 1, 2]) {
      const word = packLookGain({ x: 1.5, y: 1, zoom: 0.5, assist });
      expect(stickChannel(word)).toBe("gain");
      expect(unpackLookGain(word)).toEqual({ x: 1.5, y: 1, zoom: 0.5, assist });
    }
    // Standard by default: the word C2 wrote.
    expect(packLookGain({ x: 1, y: 1, zoom: 1 }) >>> 24).toBe(0x4d);
  });
});

describe("saved settings", () => {
  it("load from before C3 as Lockout always played", () => {
    const old = parseControlSettings({ invertY: false, lookSensitivity: 1 });
    expect(old.aimAssist).toBe("standard");
    expect(old.actionToggles).toEqual([]);
    expect(old.vibration).toBe(true);
    expect(old.vibrationStrength).toBe(1);
  });

  it("keep only valid values", () => {
    const parsed = parseControlSettings({ lookSensitivity: 1, aimAssist: "aimbot", actionToggles: ["zoom", 3, "", "zoom"], vibration: "yes", vibrationStrength: 0 });
    expect(parsed.aimAssist).toBe("standard");
    expect(parsed.actionToggles).toEqual(["zoom"]);
    expect(parsed.vibration).toBe(true);
    expect(parsed.vibrationStrength).toBe(0.1);
  });
});
