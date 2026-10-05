/**
 * Input actions (ENGINE_PARITY_ROADMAP.md EP15): named actions bound per
 * device — keys, controller buttons, console buttons — that a cart reads with
 * cartbox.action. Covers the model (defensive reads, the held mask, player
 * rebinding, prompt labels), the input layer (held keys and buttons, a bound
 * key or button belonging to its action), the Lua through the input block in
 * real engines (Classic's few free bytes and the Xbox 360's), replays carrying
 * the actions, the editor sidecar, and Lockout's actions.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  LOCKOUT_CODE,
  LOCKOUT_INPUT_ACTIONS,
  actionLabel,
  actionMask,
  keyLabel,
  lockoutCartridge,
  lockoutMeshSidecar,
  newInputAction,
  parseActionRebinds,
  parseInputActions,
  reboundActions,
  type InputAction,
} from "@cartbox/editor";
import {
  DEFAULT_CONTROL_SETTINGS,
  INPUT_BLOCK_BYTES,
  RAM_LAYOUTS,
  actionsSdkLua,
  codeChunks,
  createConsole,
  decodeMeshPoses,
  getModel,
  injectSdk,
  inputBlockAddress,
  parseControlSettings,
  readSidecarActions,
  readSidecarUi,
  runReplayEvents,
  uiSdkLua,
  writeInputBlock,
  type ModelId,
  type PadSnapshot,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { readPad, DEFAULT_PAD_BINDINGS } from "../packages/player/src/controls";
import { GamepadInput, GamepadState, KeyboardInput } from "../packages/player/src/input";
import { ConsoleButton } from "../packages/player/src/types";
import { debugBlockAddress } from "../packages/player/src/debug/debugBlock";
import { decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, setMeshActions } from "../apps/web/src/lib/meshSidecar";
import { SDK_REFERENCE } from "../apps/web/src/app/edit/[cartId]/sdkReference";
import { ACTION_PAD_BUTTONS } from "@cartbox/editor";
import { PAD_BUTTONS } from "@cartbox/player";

const DIST = path.resolve(__dirname, "../packages/engine/dist");

const ACTIONS: InputAction[] = [
  { name: "jump", keys: ["Space"], pad: ["A"], buttons: [5] },
  { name: "fire", keys: ["KeyF"], pad: ["RT"], buttons: [4] },
  { name: "reload", keys: ["KeyR"], pad: ["X"], buttons: [] },
];

describe("input actions model", () => {
  it("reads actions defensively: names unique and Lua-safe, bindings valid, unique and capped", () => {
    const read = parseInputActions([
      { name: "jump", keys: ["Space", "Space", "bad key", 7, "KeyA", "KeyB", "KeyC"], pad: ["A", "Nope", "B"], buttons: [5, 9, -1, 5] },
      { name: "jump", keys: [] },
      { name: "9lives" },
      null,
      { name: "dash" },
    ]);
    expect(read).toEqual([
      { name: "jump", keys: ["Space", "KeyA", "KeyB", "KeyC"], pad: ["A", "B"], buttons: [5] },
      { name: "dash", keys: [], pad: [], buttons: [] },
    ]);
    expect(parseInputActions(Array.from({ length: 30 }, (_, i) => ({ name: `a${i}` })))).toHaveLength(24);
  });

  it("holds an action while any of its bindings is held, on any device", () => {
    const none = { keys: new Set<string>(), pad: new Set<string>(), buttons: 0 };
    expect(actionMask(ACTIONS, none)).toBe(0);
    expect(actionMask(ACTIONS, { ...none, keys: new Set(["Space", "KeyR"]) })).toBe(0b101);
    expect(actionMask(ACTIONS, { ...none, pad: new Set(["RT"]) })).toBe(0b010);
    expect(actionMask(ACTIONS, { ...none, buttons: 1 << 5 })).toBe(0b001);
  });

  it("applies a player's rebinding per device, and reads it defensively", () => {
    const rebinds = parseActionRebinds({ jump: { keys: ["KeyW"] }, fire: { pad: ["LB", "Bogus"] }, "bad name": { keys: ["KeyX"] }, reload: 5 });
    expect(rebinds).toEqual({ jump: { keys: ["KeyW"] }, fire: { pad: ["LB"] } });
    const rebound = reboundActions(ACTIONS, rebinds);
    expect(rebound[0]).toEqual({ name: "jump", keys: ["KeyW"], pad: ["A"], buttons: [5] });
    expect(rebound[1]).toEqual({ name: "fire", keys: ["KeyF"], pad: ["LB"], buttons: [4] });
    // Kept through the control settings players save.
    const settings = parseControlSettings({ ...DEFAULT_CONTROL_SETTINGS, actionBindings: rebinds });
    expect(settings.actionBindings).toEqual(rebinds);
    expect(parseControlSettings({}).actionBindings).toBeUndefined();
  });

  it("labels bindings for on-screen prompts, falling back to console buttons", () => {
    expect(keyLabel("KeyG")).toBe("G");
    expect(keyLabel("Digit3")).toBe("3");
    expect(keyLabel("ShiftLeft")).toBe("Shift");
    expect(keyLabel("ArrowUp")).toBe("↑");
    expect(actionLabel({ name: "g", keys: ["KeyG", "KeyQ"], pad: ["LT"], buttons: [] }, "keyboard")).toBe("G / Q");
    expect(actionLabel({ name: "g", keys: ["KeyG"], pad: ["LT"], buttons: [] }, "pad")).toBe("LT");
    expect(actionLabel({ name: "f", keys: [], pad: [], buttons: [4] }, "keyboard")).toBe("A");
    expect(newInputAction(ACTIONS, "jump").name).toBe("jump2");
  });
});

describe("input layer", () => {
  function fakeWindow() {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    return {
      addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] ??= []).push(fn),
      removeEventListener: () => {},
      fire: (type: string, code = "", prevent = vi.fn()) => {
        listeners[type]?.forEach((fn) => fn({ code, repeat: false, target: null, preventDefault: prevent }));
        return prevent;
      },
    };
  }

  it("keeps every held key, gives a key an action binds to that action (no console press, no page scroll, no Start), and forgets keys on blur", () => {
    const win = fakeWindow();
    const state = new GamepadState();
    const onStart = vi.fn();
    const keyboard = new KeyboardInput(win as unknown as Window, state, () => ({ KeyZ: ConsoleButton.A, Space: ConsoleButton.B }), onStart, () => new Set(["Space", "Enter"]));
    win.fire("keydown", "KeyZ");
    const prevented = win.fire("keydown", "Space");
    expect(prevented).toHaveBeenCalled();
    expect(state.value).toBe(1 << ConsoleButton.A); // Space is the action's, not B
    win.fire("keydown", "Enter");
    expect(onStart).not.toHaveBeenCalled();
    win.fire("keydown", "KeyQ");
    expect([...keyboard.held].sort()).toEqual(["Enter", "KeyQ", "KeyZ", "Space"]);
    win.fire("keyup", "KeyQ");
    expect(keyboard.held.has("KeyQ")).toBe(false);
    win.fire("blur");
    expect(keyboard.held.size).toBe(0);
  });

  it("reports every controller button held, and a button an action binds presses no console button", () => {
    const pad = (held: number[]): PadSnapshot => ({ axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: held.includes(i), value: held.includes(i) ? 1 : 0 })) });
    expect([...readPad(pad([0, 6]), DEFAULT_PAD_BINDINGS).pressed]).toEqual(["A", "LT"]);
    const state = new GamepadState();
    const input = new GamepadInput({ getGamepads: () => [{ ...pad([0, 6]), connected: true }] }, state, () => DEFAULT_CONTROL_SETTINGS, undefined, () => new Set(["LT"]));
    input.poll();
    expect(state.value).toBe(1 << ConsoleButton.A); // LT (normally X) is the action's
    expect([...input.pressed]).toEqual(["A", "LT"]);
  });
});

/** Boot `code` with the actions SDK in a real engine; `block` writes the input block. */
async function boot(model: ModelId, file: string, code: string, actions: readonly InputAction[]) {
  const layout = RAM_LAYOUTS[model];
  const prepared = injectSdk(prependLuaCode(codeChunks(new TextEncoder().encode(code)), actionsSdkLua(actions, layout)));
  const mod = await (await import(pathToFileURL(path.join(DIST, file)).href)).default();
  const console = createConsole(mod, getModel(model), 44100);
  expect(console.loadCartridge(prepared)).toBe(true);
  const offset = inputBlockAddress(layout) - layout.pmemAddress;
  const block = (held: number, previous: number) => {
    const bytes = console.ramView(offset, INPUT_BLOCK_BYTES)!;
    writeInputBlock(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), held, previous);
  };
  return { console, block, offset, words: () => console.netWords()! };
}

const PROBE = `
function TIC()
  pmem(0, (cartbox.action("jump") and 1 or 0) | (cartbox.actionp("jump") and 2 or 0) | (cartbox.actionr("jump") and 4 or 0)
    | (cartbox.action("reload") and 8 or 0) | (cartbox.action(1) and 16 or 0) | (cartbox.action("nope") and 32 or 0))
  pmem(1, #cartbox.actions())
  pmem(2, cartbox.actionlabel("jump") == "Space" and cartbox.actionlabel("reload", "pad") == "X" and 1 or 0)
  -- The text stays legible: the block sits clear of the system font.
  pmem(3, print("Hello", 0, 0, 12))
end`;

describe.each([
  ["classic", "tic80.js"],
  ["xbox360", "xbox360/engine.js"],
] as [ModelId, string][])("cartbox.action in the real engine (%s)", (model, file) => {
  it.skipIf(!existsSync(path.join(DIST, file)))("reads held, pressed and released from the input block, and falls back to console buttons without it", async () => {
    const layout = RAM_LAYOUTS[model];
    // Clear of the debug block below it, and (on Classic) of TIC-80's system font and gamepad map.
    expect(inputBlockAddress(layout) + INPUT_BLOCK_BYTES).toBe(debugBlockAddress(layout));
    if (model === "classic") expect(inputBlockAddress(layout)).toBeGreaterThanOrEqual(0x14e24);
    const e = await boot(model, file, PROBE, ACTIONS);
    // No block yet: jump answers from its console button (B = bit 5) through btn/btnp.
    e.console.tick(0);
    expect(e.words()[0]).toBe(0);
    const width = e.words()[3]!;
    expect(width).toBeGreaterThan(20);
    e.console.tick(1 << 5);
    expect(e.words()[0]).toBe(1 | 2 | 0); // held and pressed
    e.console.tick(1 << 5);
    expect(e.words()[0]).toBe(1);
    // The host's block: jump and reload held, jump newly.
    e.block(0b101, 0b100);
    e.console.tick(0);
    expect(e.words()[0]).toBe(1 | 2 | 8);
    e.block(0b110, 0b101);
    e.console.tick(0);
    expect(e.words()[0]).toBe(4 | 8 | 16); // jump released; reload and fire (by index) held
    expect(e.words()[1]).toBe(3);
    expect(e.words()[2]).toBe(1);
    expect(e.words()[3]).toBe(width); // the system font is untouched by the block
  });
});

describe.skipIf(!existsSync(path.join(DIST, "tic80.js")))("replays", () => {
  it("carry the actions above the console buttons, and play them back through the input block", async () => {
    const code = `
function TIC()
  if cartbox.actionp("fire") then n = (n or 0) + 1; pmem(0, n) end
  if btn(4) then cartbox.score(1) end
end`;
    const e = await boot("classic", "tic80.js", code, ACTIONS);
    // Fire (action 1) pressed at frames 2 and 5; the A button (bit 4) at frame 3.
    const replay = {
      version: 1,
      modelId: "classic" as const,
      cartHash: "x",
      seed: 0,
      frameCount: 8,
      inputs: [
        { frame: 0, mask: 0 },
        { frame: 2, mask: (1 << 1) << 8 },
        { frame: 3, mask: 1 << 4 },
        { frame: 4, mask: 0 },
        { frame: 5, mask: (1 << 1) << 8 },
        { frame: 6, mask: 0 },
      ],
    };
    const events = runReplayEvents(e.console, replay, { inputOffset: e.offset });
    expect(e.words()[0]).toBe(2);
    // The action bits never reached the engine's buttons: only frame 3 pressed A.
    expect(events.filter((ev) => ev.kind === "score")).toHaveLength(1);
  });
});

describe("reference", () => {
  it("names controller buttons as the player does, and documents the newer cartbox calls", () => {
    expect([...ACTION_PAD_BUTTONS]).toEqual([...PAD_BUTTONS]);
    const names = new Set(SDK_REFERENCE.flatMap((g) => g.entries.map((e) => e.name)));
    for (const n of ["cartbox.action", "cartbox.actionp", "cartbox.actionlabel", "cartbox.component", "cartbox.place", "cartbox.ui.show", "cartbox.sound"]) expect(names.has(n), n).toBe(true);
  });
});

describe("editor sidecar", () => {
  it("stores actions (on their own too) and removes them", () => {
    const sc = setMeshActions(emptyMeshSidecar(), ACTIONS);
    const raw = encodeMeshSidecar(sc)!;
    expect(decodeMeshSidecar(raw).actions).toEqual(ACTIONS);
    expect(readSidecarActions(raw)).toEqual(ACTIONS);
    expect("actions" in setMeshActions(sc, [])).toBe(false);
    expect(readSidecarActions("not json")).toEqual([]);
  });
});

describe("Lockout", () => {
  it("binds fire, jump, swap, grenade and zoom, keeping each one's console button, and its code reads them", () => {
    expect(readSidecarActions(lockoutMeshSidecar())).toEqual(LOCKOUT_INPUT_ACTIONS);
    expect(LOCKOUT_INPUT_ACTIONS.map((a) => a.name)).toEqual(["fire", "jump", "swap", "grenade", "zoom"]);
    expect(LOCKOUT_INPUT_ACTIONS.find((a) => a.name === "jump")!.keys).toContain("Space");
    for (const call of ['cartbox.actionp("grenade")', 'cartbox.action("jump")', 'cartbox.actionp("swap")', 'cartbox.action("zoom")', 'cartbox.action("fire")']) expect(LOCKOUT_CODE).toContain(call);
  });

  it.skipIf(!existsSync(path.join(DIST, "xbox360/engine.js")))("swaps weapons on the swap action (the held gun's pose changes)", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    let tic = prependLuaCode(lockoutCartridge(), actionsSdkLua(LOCKOUT_INPUT_ACTIONS, layout));
    tic = injectSdk(prependLuaCode(tic, uiSdkLua(readSidecarUi(lockoutMeshSidecar()), 1280, 720)));
    const mod = await (await import(pathToFileURL(path.join(DIST, "xbox360/engine.js")).href)).default();
    const console = createConsole(mod, getModel("xbox360"), 44100);
    expect(console.loadCartridge(tic)).toBe(true);
    const offset = inputBlockAddress(layout) - layout.pmemAddress;
    let last = 0;
    const tick = (buttons: number, actions = 0) => {
      const bytes = console.ramView(offset, INPUT_BLOCK_BYTES)!;
      writeInputBlock(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), actions, last);
      last = actions;
      console.tick(buttons);
    };
    const held = () => decodeMeshPoses(console.readMailbox()).find((p) => p.front)?.index;
    for (let i = 0; i < 3; i += 1) tick(0);
    tick(1 << 4); // Free for All
    for (let i = 0; i < 40; i += 1) tick(i % 2 ? 1 << 4 : 0); // past the intro
    for (let i = 0; i < 3; i += 1) tick(0);
    const before = held();
    expect(before).toBe(8); // the BR
    tick(0, 1 << 2); // swap
    tick(0);
    const after = held();
    expect(after).toBeGreaterThanOrEqual(8);
    expect(after).not.toBe(before);
  });
});
