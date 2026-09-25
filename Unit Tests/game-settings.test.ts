/**
 * The Start menu's settings model: stored settings parse safely, key rebinding
 * moves a key between actions, and the Halo controller preset maps what a
 * Halo player expects.
 */

import { describe, expect, it } from "vitest";

import { ConsoleButton, DEFAULT_CONTROL_SETTINGS } from "@cartbox/player";
import {
  DEFAULT_GAME_SETTINGS,
  HALO_PAD_BINDINGS,
  LOCKOUT_ACTIONS,
  keysFor,
  loadGameSettings,
  parseGameSettings,
  rebindKey,
  saveGameSettings,
} from "../apps/web/src/lib/gameSettings";

describe("game settings", () => {
  it("round-trips through storage and falls back on junk", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const custom = { ...DEFAULT_GAME_SETTINGS, volume: 0.3, muted: true, controls: { ...DEFAULT_CONTROL_SETTINGS, invertY: true } };
    saveGameSettings("lockout", custom, storage);
    expect(loadGameSettings("lockout", storage)).toEqual(custom);
    store.set("cartbox:settings:lockout", "{not json");
    expect(loadGameSettings("lockout", storage)).toEqual(DEFAULT_GAME_SETTINGS);
    expect(parseGameSettings({ volume: 5, showFps: "yes" })).toMatchObject({ volume: 1, showFps: false });
  });

  it("rebinds a key: the action's old key goes, and the key leaves its old action", () => {
    const start = { KeyZ: ConsoleButton.A, KeyX: ConsoleButton.B, Space: ConsoleButton.Y };
    const next = rebindKey(start, "Space", ConsoleButton.A);
    expect(next).toEqual({ KeyX: ConsoleButton.B, Space: ConsoleButton.A });
    expect(keysFor(next, ConsoleButton.A)).toEqual(["Space"]);
    expect(keysFor(DEFAULT_CONTROL_SETTINGS.keyBindings, ConsoleButton.Up)).toEqual(["↑"]);
  });

  it("names every console button, and the Halo preset fires on RT and jumps on A", () => {
    expect(LOCKOUT_ACTIONS.map((a) => a.button).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(HALO_PAD_BINDINGS.RT).toBe(ConsoleButton.A); // fire
    expect(HALO_PAD_BINDINGS.A).toBe(ConsoleButton.B); // jump
    expect(HALO_PAD_BINDINGS.Start).toBe("start");
  });
});
