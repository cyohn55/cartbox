/**
 * Controllers and control settings: an Xbox 360 (standard-mapping) gamepad read
 * through the Gamepad API — bindings, triggers, dead-zoned sticks, Start on
 * press — the look settings (inversion, sensitivity) applied to what the game
 * reads, live keyboard rebinding, settings parsing, and moving a netplay session
 * between rooms.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CONTROL_SETTINGS,
  DEFAULT_PAD_BINDINGS,
  MemoryNetHub,
  NET_WORDS,
  NetSession,
  SwitchableTransport,
  applyLookSettings,
  parseControlSettings,
  readPad,
  standardizePad,
  type ControlSettings,
  type PadSnapshot,
} from "@cartbox/player";
import { GamepadInput, GamepadState, KeyboardInput } from "../packages/player/src/input";
import { ConsoleButton } from "../packages/player/src/types";

/** A standard-mapping pad with the named buttons held (index order per the Gamepad API). */
function pad(held: number[] = [], axes: number[] = [0, 0, 0, 0], triggers: Record<number, number> = {}): PadSnapshot {
  return {
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: held.includes(i), value: triggers[i] ?? (held.includes(i) ? 1 : 0) })),
  };
}

describe("readPad (Xbox 360 layout)", () => {
  it("maps face buttons, the D-pad and the triggers through the bindings", () => {
    const a = readPad(pad([0, 13]), DEFAULT_PAD_BINDINGS); // A + D-pad down
    expect(a.mask).toBe((1 << ConsoleButton.A) | (1 << ConsoleButton.Down));
    const rt = readPad(pad([], undefined, { 7: 0.8 }), DEFAULT_PAD_BINDINGS); // right trigger past half
    expect(rt.mask).toBe(1 << ConsoleButton.A);
    const light = readPad(pad([], undefined, { 7: 0.3 }), DEFAULT_PAD_BINDINGS);
    expect(light.mask).toBe(0);
    expect(readPad(pad([9]), DEFAULT_PAD_BINDINGS).start).toBe(true); // Start
  });

  it("dead-zones the sticks and still reaches full lean", () => {
    const rest = readPad(pad([], [0.1, -0.08, 0.05, 0.1]), DEFAULT_PAD_BINDINGS);
    expect(rest.axes).toEqual([0, 0, 0, 0]);
    const full = readPad(pad([], [1, 0, 0, -1]), DEFAULT_PAD_BINDINGS);
    expect(full.axes[0]).toBeCloseTo(1, 5);
    expect(full.axes[3]).toBeCloseTo(-1, 5);
  });
});

describe("GamepadInput", () => {
  it("feeds the controller into the shared state and opens Start on press, not hold", () => {
    const state = new GamepadState();
    let current: PadSnapshot & { connected: boolean } = { ...pad([0], [0, -1, 0.5, 0]), connected: true };
    const onStart = vi.fn();
    const input = new GamepadInput({ getGamepads: () => [current] }, state, () => DEFAULT_CONTROL_SETTINGS, onStart);
    input.poll();
    expect(state.value & (1 << ConsoleButton.A)).toBeTruthy();
    expect(state.value & (1 << ConsoleButton.Up)).toBeTruthy(); // left stick up presses D-pad up
    expect(state.axes[1]).toBeCloseTo(-1, 5);
    current = { ...pad([9]), connected: true };
    input.poll();
    input.poll(); // still held
    expect(onStart).toHaveBeenCalledTimes(1);
    current = { ...pad([]), connected: true };
    input.poll();
    expect(state.value).toBe(0);
    expect(input.connected).toBe(true);
  });

  it("uses the settings' bindings live", () => {
    const state = new GamepadState();
    let settings: ControlSettings = DEFAULT_CONTROL_SETTINGS;
    const input = new GamepadInput({ getGamepads: () => [{ ...pad([0]), connected: true }] }, state, () => settings);
    input.poll();
    expect(state.value).toBe(1 << ConsoleButton.A);
    settings = { ...settings, padBindings: { ...settings.padBindings, A: ConsoleButton.B } }; // Halo: A jumps
    input.poll();
    expect(state.value).toBe(1 << ConsoleButton.B);
  });

  it("lets the stronger of touch and controller drive each stick", () => {
    const state = new GamepadState();
    state.setStick(1, 0.2, 0);
    state.setPad(0, [0, 0, -0.9, 0]);
    expect(state.axes[2]).toBeCloseTo(-0.9, 5);
    state.setPad(0, [0, 0, 0, 0]);
    expect(state.axes[2]).toBeCloseTo(0.2, 5);
  });

  it("reads nothing with no controller", () => {
    const state = new GamepadState();
    const input = new GamepadInput({ getGamepads: () => [null, null] }, state, () => DEFAULT_CONTROL_SETTINGS);
    input.poll();
    expect(state.value).toBe(0);
    expect(input.connected).toBe(false);
  });
});

describe("look settings", () => {
  it("inverts only the right stick's vertical axis, and scales look sensitivity", () => {
    expect(applyLookSettings([0.5, 0.5, 0.2, -0.4], { invertY: true, lookSensitivity: 1 })).toEqual([0.5, 0.5, 0.2, 0.4]);
    const fast = applyLookSettings([0, 0, 0.4, 0.8], { invertY: false, lookSensitivity: 2 });
    expect(fast[2]).toBeCloseTo(0.8, 5);
    expect(fast[3]).toBe(1); // clamped to full lean
  });
});

describe("parseControlSettings", () => {
  it("keeps valid fields, clamps ranges and drops junk", () => {
    const parsed = parseControlSettings({
      invertY: true,
      lookSensitivity: 9,
      touchOpacity: -1,
      padBindings: { A: ConsoleButton.B, Bogus: 1, RT: "start", LT: 42 },
      keyBindings: { Space: ConsoleButton.B, "<x>": 1 },
    });
    expect(parsed.invertY).toBe(true);
    expect(parsed.lookSensitivity).toBe(3);
    expect(parsed.touchOpacity).toBe(0.2);
    expect(parsed.padBindings.A).toBe(ConsoleButton.B);
    expect(parsed.padBindings.RT).toBe("start");
    expect(parsed.padBindings.LT).toBe(DEFAULT_PAD_BINDINGS.LT); // 42 isn't a button
    expect(parsed.keyBindings).toEqual({ Space: ConsoleButton.B });
    expect(parseControlSettings("nope")).toBe(DEFAULT_CONTROL_SETTINGS);
  });
});

describe("KeyboardInput", () => {
  /** A window stand-in that records listeners and lets the test fire key events. */
  function fakeWindow() {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    return {
      addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] ??= []).push(fn),
      removeEventListener: () => {},
      key: (type: "keydown" | "keyup", code: string) =>
        listeners[type]?.forEach((fn) => fn({ code, repeat: false, target: null, preventDefault() {} })),
    };
  }

  it("follows a rebind at once, releases what a held key pressed, and opens Start on Enter", () => {
    const win = fakeWindow();
    const state = new GamepadState();
    let bindings: Record<string, ConsoleButton> = { KeyZ: ConsoleButton.A };
    const onStart = vi.fn();
    new KeyboardInput(win as unknown as Window, state, () => bindings, onStart);
    win.key("keydown", "KeyZ");
    expect(state.value).toBe(1 << ConsoleButton.A);
    bindings = { KeyZ: ConsoleButton.B, Space: ConsoleButton.A };
    win.key("keyup", "KeyZ"); // released the A it pressed
    expect(state.value).toBe(0);
    win.key("keydown", "Space");
    expect(state.value).toBe(1 << ConsoleButton.A);
    win.key("keydown", "Enter");
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("opens Start on Escape and P too", () => {
    const win = fakeWindow();
    const onStart = vi.fn();
    new KeyboardInput(win as unknown as Window, new GamepadState(), () => ({}), onStart);
    win.key("keydown", "Escape");
    win.key("keydown", "KeyP");
    expect(onStart).toHaveBeenCalledTimes(2);
  });
});

describe("controllers that don't report the standard layout", () => {
  /** An Xbox 360 pad as Firefox on Linux reports it: evdev button order, triggers and D-pad as axes. */
  function rawXbox(held: number[] = [], axes: Partial<Record<number, number>> = {}) {
    const base = [0, 0, -1, 0, 0, -1, 0, 0]; // triggers rest at -1
    return {
      id: "045e-028e-Microsoft X-Box 360 pad",
      mapping: "",
      axes: base.map((v, i) => axes[i] ?? v),
      buttons: Array.from({ length: 11 }, (_, i) => ({ pressed: held.includes(i), value: held.includes(i) ? 1 : 0 })),
    };
  }

  it("reads Start (raw button 7) as Start, not the right trigger", () => {
    const read = readPad(rawXbox([7]), DEFAULT_PAD_BINDINGS);
    expect(read.start).toBe(true);
    expect(read.mask).toBe(0);
    expect(readPad(rawXbox([6]), DEFAULT_PAD_BINDINGS).start).toBe(true); // Back
    expect(readPad(rawXbox([8]), DEFAULT_PAD_BINDINGS).start).toBe(true); // Guide
  });

  it("maps its triggers, D-pad and right stick", () => {
    expect(readPad(rawXbox([], { 5: 1 }), DEFAULT_PAD_BINDINGS).mask).toBe(1 << ConsoleButton.A); // RT fires
    expect(readPad(rawXbox([], { 7: 1 }), DEFAULT_PAD_BINDINGS).mask).toBe(1 << ConsoleButton.Down); // D-pad down
    const read = readPad(rawXbox([], { 3: 1, 4: -1 }), DEFAULT_PAD_BINDINGS);
    expect(read.axes[2]).toBeCloseTo(0.71, 1);
    expect(read.axes[3]).toBeCloseTo(-0.71, 1);
  });

  it("leaves standard and unknown pads alone", () => {
    const standard = pad([9]);
    expect(standardizePad({ ...standard, mapping: "standard" })).toEqual({ ...standard, mapping: "standard" });
    const unknown = { id: "Some Joystick", mapping: "", axes: [0, 0], buttons: pad([7]).buttons };
    expect(standardizePad(unknown)).toBe(unknown);
  });

  it("still opens the menu on Start when the mapping bound nothing to it", () => {
    const none = { ...DEFAULT_PAD_BINDINGS, Back: null, Start: null, Guide: null };
    expect(readPad(pad([9]), none).start).toBe(true);
    // Start rebound to fire just fires.
    const fire = { ...none, Start: ConsoleButton.A };
    expect(readPad(pad([9]), fire)).toMatchObject({ mask: 1 << ConsoleButton.A, start: false });
  });
});

describe("SwitchableTransport", () => {
  it("moves a running session between rooms, offline in between", async () => {
    const hubA = new MemoryNetHub();
    const hubB = new MemoryNetHub();
    // Slots go by join time, then id: "a-them" also wins a same-millisecond tie with "me2".
    const other = new NetSession(hubB.transport("a-them"));
    await other.connect();
    const switcher = new SwitchableTransport();
    const me = new NetSession(switcher);
    await me.connect();
    const words = new Uint32Array(NET_WORDS);
    me.beforeTick(words);
    expect(words[0]! & 3).toBe(0); // offline: no room yet

    await switcher.use(hubA.transport("me"));
    expect(me.mySlot).toBe(0); // alone in room A: host
    await switcher.use(hubB.transport("me2"));
    me.resetRoom();
    expect(me.mySlot).toBe(1); // room B's first member stays host
    await switcher.use(null);
    me.beforeTick(words);
    expect(words[0]! & 3).toBe(0);
  });
});
