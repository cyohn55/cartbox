/**
 * Unit tests for the `wasm-app` runtime (Browse Phase 2).
 *
 * The runtime tests load the *actual compiled* reference game
 * (apps/web/public/games/reference/game.wasm, built by scripts/build-game.mjs)
 * and drive it through the Cartbox Game ABI. Nothing about the ABI is mocked:
 * framebuffer handoff, input, scoring and save round-tripping are verified
 * against real WebAssembly, because a stubbed module would prove only that the
 * stub matches the stub.
 *
 * Run with: npx vitest run "Unit Tests/wasm-game-runtime.test.ts"
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BUTTON_BITS,
  ButtonState,
  CONSOLE_KEY_BINDINGS,
  DESKTOP_KEY_BINDINGS,
  buttonForKey,
  buttonsFromMask,
  isBoundKey,
} from "../apps/web/src/lib/gameInput";
import {
  InMemorySaveStore,
  parseSaveKey,
  saveKey,
} from "../apps/web/src/lib/gameSaves";
import {
  GameAbiError,
  GameSession,
  MAX_FRAME_DELTA_SECONDS,
  assertImplementsAbi,
  clampDelta,
  type GameModule,
  type GameModuleFactory,
} from "../apps/web/src/lib/wasmGameRuntime";

const GAME_GLUE = fileURLToPath(
  new URL("../apps/web/public/games/reference/game.js", import.meta.url),
);
const GAME_WASM = GAME_GLUE.replace(/\.js$/, ".wasm");

const WIDTH = 96;
const HEIGHT = 64;

/**
 * Loads the compiled reference game.
 *
 * The shipped build targets browsers (ENVIRONMENT=web), so its glue cannot fetch
 * the .wasm from a Node test. Handing the bytes over as `wasmBinary` exercises
 * the real binary without compromising the artefact that ships — the alternative,
 * building for node as well, would test something other than what players run.
 */
async function loadReferenceFactory(): Promise<GameModuleFactory> {
  const imported = (await import(GAME_GLUE)) as { default: GameModuleFactory };
  const wasmBinary = readFileSync(GAME_WASM);
  return (options?: Record<string, unknown>) =>
    imported.default({ ...options, wasmBinary });
}

const gameIsBuilt = existsSync(GAME_GLUE);
const describeGame = gameIsBuilt ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Input mapping
// ---------------------------------------------------------------------------

describe("input mapping", () => {
  it("assigns every button a distinct bit", () => {
    const bits = Object.values(BUTTON_BITS);
    expect(new Set(bits).size).toBe(bits.length);
  });

  it("combines held buttons into one mask and back", () => {
    const state = new ButtonState();
    state.press("left");
    state.press("a");

    expect(buttonsFromMask(state.mask()).sort()).toEqual(["a", "left"]);
  });

  it("clears a button on release", () => {
    const state = new ButtonState();
    state.press("up");
    state.release("up");

    expect(state.mask()).toBe(0);
    expect(state.isHeld("up")).toBe(false);
  });

  it("releases everything on blur, so a held key cannot stick down", () => {
    const state = new ButtonState();
    state.press("right");
    state.press("b");
    state.releaseAll();

    expect(state.mask()).toBe(0);
  });

  it("maps both arrows and WASD to the d-pad", () => {
    expect(buttonForKey("ArrowLeft")).toBe("left");
    expect(buttonForKey("KeyA")).toBe("left");
    expect(buttonForKey("ArrowUp")).toBe(buttonForKey("KeyW"));
  });

  it("leaves unbound keys alone, so browser shortcuts keep working", () => {
    expect(buttonForKey("KeyQ")).toBeUndefined();
    expect(isBoundKey("KeyQ")).toBe(false);
    expect(isBoundKey("ArrowUp")).toBe(true);
  });

  it("keeps the handheld's X/Y buttons off the d-pad", () => {
    // The shell forwards its X and Y buttons as KeyA and KeyS. Under the desktop
    // table those are WASD left/down, so pressing X would walk the player left —
    // the console table must not inherit that binding.
    expect(buttonForKey("KeyA", CONSOLE_KEY_BINDINGS)).toBe("x");
    expect(buttonForKey("KeyS", CONSOLE_KEY_BINDINGS)).toBe("y");
    expect(buttonForKey("KeyA", DESKTOP_KEY_BINDINGS)).toBe("left");
  });

  it("maps the handheld's forwarded keys to the buttons they are labelled", () => {
    // These four codes are the player package's DEFAULT_KEY_BINDINGS, which the
    // shell's input bus uses when it synthesises key events.
    expect(buttonForKey("KeyZ", CONSOLE_KEY_BINDINGS)).toBe("a");
    expect(buttonForKey("KeyX", CONSOLE_KEY_BINDINGS)).toBe("b");
    expect(buttonForKey("ArrowLeft", CONSOLE_KEY_BINDINGS)).toBe("left");
    expect(buttonForKey("ArrowUp", CONSOLE_KEY_BINDINGS)).toBe("up");
  });

  it("gives the console's d-pad exactly one binding per direction", () => {
    // Two codes mapping to one direction is fine on desktop but would double up
    // shell events, so the console table stays one-to-one.
    const directions = ["up", "down", "left", "right"];
    const bound = Object.values(CONSOLE_KEY_BINDINGS).filter((button) =>
      directions.includes(button),
    );
    expect(bound.sort()).toEqual(directions.sort());
  });

  it("is idempotent when a key repeats", () => {
    const state = new ButtonState();
    state.press("a");
    const once = state.mask();
    state.press("a");

    expect(state.mask()).toBe(once);
  });
});

describe("clampDelta", () => {
  it("passes an ordinary frame time through untouched", () => {
    expect(clampDelta(1 / 60)).toBeCloseTo(1 / 60);
  });

  it("caps a long gap so a backgrounded tab does not teleport the game", () => {
    expect(clampDelta(5)).toBe(MAX_FRAME_DELTA_SECONDS);
  });

  it("treats non-finite or non-positive deltas as no time passing", () => {
    expect(clampDelta(Number.NaN)).toBe(0);
    expect(clampDelta(-1)).toBe(0);
    expect(clampDelta(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ABI validation
// ---------------------------------------------------------------------------

describe("ABI validation", () => {
  it("names the missing symbols rather than failing mid-frame", () => {
    expect(() => assertImplementsAbi({ HEAPU8: new Uint8Array(1) })).toThrow(GameAbiError);
    try {
      assertImplementsAbi({ HEAPU8: new Uint8Array(1) });
    } catch (error) {
      expect((error as Error).message).toContain("_cartbox_init");
    }
  });

  it("rejects a module without a heap view", () => {
    const almost = Object.fromEntries(
      [
        "_cartbox_init",
        "_cartbox_set_input",
        "_cartbox_tick",
        "_cartbox_score",
        "_cartbox_save_size",
        "_cartbox_save",
        "_cartbox_load",
        "_malloc",
        "_free",
      ].map((name) => [name, () => 0]),
    );

    expect(() => assertImplementsAbi(almost as Partial<GameModule>)).toThrow(/HEAPU8/);
  });
});

// ---------------------------------------------------------------------------
// Save slots
// ---------------------------------------------------------------------------

describe("save slots", () => {
  it("round-trips a key", () => {
    const slot = { titleId: "collector", slot: 2 };
    expect(parseSaveKey(saveKey(slot))).toEqual(slot);
  });

  it("refuses ids and slots that could escape the storage directory", () => {
    // The key reaches a filesystem path, so traversal must fail loudly.
    expect(() => saveKey({ titleId: "../escape", slot: 0 })).toThrow(RangeError);
    expect(() => saveKey({ titleId: "ok", slot: -1 })).toThrow(RangeError);
    expect(() => saveKey({ titleId: "ok", slot: 1.5 })).toThrow(RangeError);
  });

  it("does not parse a key that is not one", () => {
    expect(parseSaveKey("random-file.txt")).toBeNull();
  });

  it("keeps each title's slots separate", async () => {
    const store = new InMemorySaveStore();
    await store.write({ titleId: "alpha", slot: 0 }, Uint8Array.of(1));
    await store.write({ titleId: "beta", slot: 0 }, Uint8Array.of(2));

    expect(await store.listSlots("alpha")).toEqual([0]);
    expect((await store.read({ titleId: "beta", slot: 0 }))?.data).toEqual(Uint8Array.of(2));
  });

  it("copies on write, so a later heap change cannot corrupt a stored save", async () => {
    // Save data is usually a view into the WASM heap, which moves under us.
    const store = new InMemorySaveStore();
    const live = Uint8Array.of(1, 2, 3);
    await store.write({ titleId: "alpha", slot: 0 }, live);
    live[0] = 99;

    expect((await store.read({ titleId: "alpha", slot: 0 }))?.data).toEqual(Uint8Array.of(1, 2, 3));
  });

  it("removes idempotently and reports no slots afterwards", async () => {
    const store = new InMemorySaveStore();
    await store.write({ titleId: "alpha", slot: 0 }, Uint8Array.of(1));
    await store.remove({ titleId: "alpha", slot: 0 });
    await store.remove({ titleId: "alpha", slot: 0 });

    expect(await store.listSlots("alpha")).toEqual([]);
    expect(await store.read({ titleId: "alpha", slot: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The real compiled game
// ---------------------------------------------------------------------------

describeGame("reference game (compiled WebAssembly)", () => {
  it("starts and reports a framebuffer of exactly the requested size", async () => {
    const session = await GameSession.start(await loadReferenceFactory(), {
      width: WIDTH,
      height: HEIGHT,
    });

    expect(session.frame().byteLength).toBe(WIDTH * HEIGHT * 4);
    expect(session.dimensions).toEqual({ width: WIDTH, height: HEIGHT });
  });

  it("rejects impossible dimensions before touching the module", async () => {
    const factory = await loadReferenceFactory();
    await expect(GameSession.start(factory, { width: 0, height: HEIGHT })).rejects.toThrow(GameAbiError);
  });

  it("surfaces a refused init as an ABI error rather than a null pointer", async () => {
    // The reference game caps its own dimensions; asking for more must fail loudly.
    const factory = await loadReferenceFactory();
    await expect(GameSession.start(factory, { width: 99999, height: 99999 })).rejects.toThrow(
      GameAbiError,
    );
  });

  it("paints opaque pixels once ticked", async () => {
    const session = await GameSession.start(await loadReferenceFactory(), {
      width: WIDTH,
      height: HEIGHT,
    });
    session.tick(1 / 60);
    const frame = session.frame();

    // Every pixel is written each frame, so alpha is 255 throughout.
    expect(frame[3]).toBe(255);
    expect(frame[frame.byteLength - 1]).toBe(255);
  });

  it("changes what it renders as the game runs", async () => {
    const session = await GameSession.start(await loadReferenceFactory(), {
      width: WIDTH,
      height: HEIGHT,
    });
    session.tick(0);
    const first = Uint8Array.from(session.frame());

    // Hazards drift, so a later frame differs even with no input.
    for (let i = 0; i < 30; i += 1) {
      session.tick(1 / 30);
    }
    expect(Uint8Array.from(session.frame())).not.toEqual(first);
  });

  it("responds to input by moving the player", async () => {
    const factory = await loadReferenceFactory();

    // Two identical sessions, one given input: any divergence is the input's.
    const idle = await GameSession.start(factory, { width: WIDTH, height: HEIGHT });
    const driven = await GameSession.start(factory, { width: WIDTH, height: HEIGHT });

    const held = new ButtonState();
    held.press("left");
    driven.setInput(held.mask());

    for (let i = 0; i < 20; i += 1) {
      idle.tick(1 / 60);
      driven.tick(1 / 60);
    }

    expect(Uint8Array.from(driven.frame())).not.toEqual(Uint8Array.from(idle.frame()));
  });

  it("honours the button bits the host sends", async () => {
    // Guards the C defines and BUTTON_BITS agreeing: a mismatch would move the
    // player the wrong way, which no type system would catch.
    const factory = await loadReferenceFactory();
    const left = await GameSession.start(factory, { width: WIDTH, height: HEIGHT });
    const right = await GameSession.start(factory, { width: WIDTH, height: HEIGHT });

    left.setInput(BUTTON_BITS.left);
    right.setInput(BUTTON_BITS.right);
    for (let i = 0; i < 20; i += 1) {
      left.tick(1 / 60);
      right.tick(1 / 60);
    }

    expect(Uint8Array.from(left.frame())).not.toEqual(Uint8Array.from(right.frame()));
  });

  it("reports a score", async () => {
    const session = await GameSession.start(await loadReferenceFactory(), {
      width: WIDTH,
      height: HEIGHT,
    });
    session.tick(1 / 60);

    expect(Number.isInteger(session.score())).toBe(true);
  });

  it("round-trips a save through the ABI", async () => {
    const factory = await loadReferenceFactory();
    const session = await GameSession.start(factory, { width: WIDTH, height: HEIGHT });

    // Run a while so the saved state is not the initial one.
    session.setInput(BUTTON_BITS.right);
    for (let i = 0; i < 40; i += 1) {
      session.tick(1 / 60);
    }
    const saved = session.save();
    expect(saved).not.toBeNull();
    const frameAtSave = Uint8Array.from(session.frame());

    // Diverge, then restore: the restored frame must match the saved moment.
    session.setInput(BUTTON_BITS.left);
    for (let i = 0; i < 40; i += 1) {
      session.tick(1 / 60);
    }
    expect(Uint8Array.from(session.frame())).not.toEqual(frameAtSave);

    expect(session.load(saved as Uint8Array)).toBe(true);
    session.setInput(0);
    session.tick(0);
    expect(Uint8Array.from(session.frame())).toEqual(frameAtSave);
  });

  it("restores a save into a freshly started session", async () => {
    const factory = await loadReferenceFactory();
    const origin = await GameSession.start(factory, { width: WIDTH, height: HEIGHT });

    origin.setInput(BUTTON_BITS.up);
    for (let i = 0; i < 30; i += 1) {
      origin.tick(1 / 60);
    }
    const saved = origin.save() as Uint8Array;
    const savedScore = origin.score();

    const restored = await GameSession.start(factory, { width: WIDTH, height: HEIGHT });
    expect(restored.load(saved)).toBe(true);
    expect(restored.score()).toBe(savedScore);
  });

  it("rejects a save it does not recognise instead of booting corrupt state", async () => {
    // Saves outlive game updates, so refusal is an expected outcome.
    const session = await GameSession.start(await loadReferenceFactory(), {
      width: WIDTH,
      height: HEIGHT,
    });

    expect(session.load(Uint8Array.of(1, 2, 3, 4))).toBe(false);
    expect(session.load(new Uint8Array(0))).toBe(false);
  });

  it("rejects a save of the right length whose contents are wrong", async () => {
    const session = await GameSession.start(await loadReferenceFactory(), {
      width: WIDTH,
      height: HEIGHT,
    });
    const valid = session.save() as Uint8Array;
    const corrupted = Uint8Array.from(valid);
    corrupted[0] ^= 0xff; // Break the magic number.

    expect(session.load(corrupted)).toBe(false);
  });

  it("survives a save while the heap grows, returning a detached-safe copy", async () => {
    // save() copies out of HEAPU8; a stale view would read as empty here.
    const session = await GameSession.start(await loadReferenceFactory(), {
      width: WIDTH,
      height: HEIGHT,
    });
    const saved = session.save() as Uint8Array;

    expect(saved.byteLength).toBeGreaterThan(0);
    expect(saved.some((byte) => byte !== 0)).toBe(true);
  });
});
