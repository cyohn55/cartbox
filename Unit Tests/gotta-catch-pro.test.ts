/**
 * "Gotta Catch 'Em All (PRO)" cart — behavioural tests on the real Pro core.
 *
 * Loads the actual built .tic (assembled from the Cartbox editor asset models +
 * game-pro.lua) and the shipped Pro engine (640x360), runs it, and asserts on
 * the pixels. Also verifies the authored map survives the editor -> cart -> core
 * round trip at deep rows: the Pro map is 640x360 cells, and a hard-coded
 * Classic stride (240) in the editor's map accessors once truncated everything
 * below row ~22 — these tests pin that regression. Expectations come from the
 * game's own design (HUD height, gamepad bits, buildMap layout), not goldens.
 *
 * Skips (with a warning) if the engine or the built cart is missing.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { PRO_MODEL, createWasmCartEngine, loadEditorModule } from "@cartbox/editor";

const SCREEN_WIDTH = 640;
const SCREEN_HEIGHT = 360;
const HUD_HEIGHT = 14;           // game-pro.lua draws rect(0,0,640,14,...) as the HUD
const GAMEPAD_DOWN = 1 << 1;     // Pro keeps the Classic gamepad bit layout

// From buildMap() in build-game-pro.mjs: 90x60 world ringed with tree tiles,
// a vertical path at column 44, and a tall-grass rect at (50,30,14x10).
const WORLD_WIDTH = 90;
const WORLD_HEIGHT = 60;
const TILE_TREE = 3;
const TILE_PATH = 5;
const TILE_TALL_GRASS = 2;

const enginePath = fileURLToPath(
  new URL("../packages/engine/dist/pro/engine.js", import.meta.url),
);
const cartPath = fileURLToPath(new URL("../../gotta-catch-pro/game-pro.tic", import.meta.url));
const ready = existsSync(enginePath) && existsSync(cartPath);
const suite = ready ? describe : describe.skip;
if (!ready) {
  console.warn("[gotta-catch-pro] engine or game-pro.tic missing; skipping. Run Working/gotta-catch-pro/run.sh.");
}

type Frame = Uint8Array;

suite("Gotta Catch 'Em All (PRO) on the real Pro core", () => {
  let module: any;

  beforeAll(async () => {
    module = await loadEditorModule(pathToFileURL(enginePath).href);
  }, 30000);

  /** Run the cart from cold and return snapshots at the requested frames, each
   * frame advanced with the given gamepad mask. */
  function run(steps: Array<{ mask: number }>, capture: number[]): Map<number, Frame> {
    const cart = new Uint8Array(readFileSync(cartPath));
    const handle = module._cbx_create(44100);
    const ptr = module._malloc(cart.byteLength);
    module.HEAPU8.set(cart, ptr);
    module._cbx_load(handle, ptr, cart.byteLength);
    module._free(ptr);
    const want = new Set(capture);
    const out = new Map<number, Frame>();
    for (let frame = 0; frame < steps.length; frame++) {
      module._cbx_tick(handle, steps[frame].mask);
      if (want.has(frame)) {
        const screenPtr = module._cbx_screen_ptr(handle);
        out.set(frame, Uint8Array.from(
          module.HEAPU8.subarray(screenPtr, screenPtr + SCREEN_WIDTH * SCREEN_HEIGHT * 4),
        ));
      }
    }
    module._cbx_delete(handle);
    return out;
  }

  const rgb = (frame: Frame, x: number, y: number) => {
    const i = (y * SCREEN_WIDTH + x) * 4;
    return [frame[i], frame[i + 1], frame[i + 2]] as const;
  };

  it("renders a populated 640x360 overworld (map data reaches the whole screen)", () => {
    // Regression pin: with the Classic map stride, everything below the first
    // ~22 map rows was empty and this frame was mostly black.
    const frame = run(Array(6).fill({ mask: 0 }), [5]).get(5)!;
    expect(frame.byteLength).toBe(SCREEN_WIDTH * SCREEN_HEIGHT * 4);
    const colors = new Set<number>();
    let nonBlack = 0;
    for (let i = 0; i < frame.length; i += 4) {
      colors.add((frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2]);
      if (frame[i] || frame[i + 1] || frame[i + 2]) nonBlack++;
    }
    expect(colors.size).toBeGreaterThan(8);                          // palette + sprites in use
    expect(nonBlack / (SCREEN_WIDTH * SCREEN_HEIGHT)).toBeGreaterThan(0.9);
  });

  it("draws the HUD bar with readable text across the top", () => {
    const frame = run(Array(6).fill({ mask: 0 }), [5]).get(5)!;
    // One flat colour dominates a row inside the HUD band.
    const y = 4;
    const counts = new Map<number, number>();
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      const [r, g, b] = rgb(frame, x, y);
      const key = (r << 16) | (g << 8) | b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const [, barCount] = [...counts].sort((a, b) => b[1] - a[1])[0];
    expect(barCount / SCREEN_WIDTH).toBeGreaterThan(0.5);

    // Text pixels (the pale-green ink, distinct from the amber bar) show up.
    let textPixels = 0;
    for (let yy = 0; yy < HUD_HEIGHT; yy++)
      for (let x = 0; x < SCREEN_WIDTH; x++) {
        const [r, g, b] = rgb(frame, x, yy);
        if (r > 180 && g > 220 && b > 180) textPixels++;
      }
    expect(textPixels).toBeGreaterThan(30);                          // "POKEDEX 0/3" etc.
  });

  it("is grass-dominant below the HUD (the authored palette shows through)", () => {
    const frame = run(Array(6).fill({ mask: 0 }), [5]).get(5)!;
    let grass = 0, total = 0;
    for (let y = HUD_HEIGHT; y < SCREEN_HEIGHT; y++)
      for (let x = 0; x < SCREEN_WIDTH; x++) {
        const [r, g, b] = rgb(frame, x, y);
        total++;
        if (g > r && g > b && g > 70) grass++;
      }
    expect(grass / total).toBeGreaterThan(0.2);
  });

  it("moves the player when walking (input and movement are live)", () => {
    // The Pro screen shows most of the small world and the camera starts at its
    // bottom clamp, so holding "down" moves the sprite, not the map. Track the
    // red-capped player sprite's centroid: 14 held frames cover ~3 grid steps
    // (24px), so the centroid must drop by well over one 8px tile.
    const shots = run(
      [{ mask: 0 }, ...Array(14).fill({ mask: GAMEPAD_DOWN })],
      [0, 14],
    );
    const centroidY = (frame: Frame): number => {
      let sum = 0, count = 0;
      for (let y = HUD_HEIGHT; y < SCREEN_HEIGHT; y++)
        for (let x = 0; x < SCREEN_WIDTH; x++) {
          const [r, g, b] = rgb(frame, x, y);
          if (r > 130 && g < 80 && b < 80) { sum += y; count++; }  // the red cap/body
        }
      expect(count).toBeGreaterThan(20);                           // sprite was found
      return sum / count;
    };
    expect(centroidY(shots.get(14)!) - centroidY(shots.get(0)!)).toBeGreaterThan(12);
  });

  it("keeps the authored map intact at deep rows through the editor engine", () => {
    // Reads the built cart back through WasmCartEngine on the PRO model. With a
    // wrong (Classic) stride these landmark cells scramble, because the cart was
    // written with the Pro layout.
    const engine = createWasmCartEngine(module, PRO_MODEL);
    engine.loadTic(new Uint8Array(readFileSync(cartPath)));

    // The tree border rings the whole 90x60 world — including the last row,
    // which sits far past where the Classic stride could reach.
    expect(engine.getMapCell(0, 0)).toBe(TILE_TREE);
    expect(engine.getMapCell(WORLD_WIDTH - 1, 0)).toBe(TILE_TREE);
    expect(engine.getMapCell(0, WORLD_HEIGHT - 1)).toBe(TILE_TREE);
    expect(engine.getMapCell(WORLD_WIDTH - 1, WORLD_HEIGHT - 1)).toBe(TILE_TREE);

    // Landmarks from buildMap(): the vertical path and a tall-grass field.
    expect(engine.getMapCell(44, 50)).toBe(TILE_PATH);
    expect(engine.getMapCell(55, 35)).toBe(TILE_TALL_GRASS);
  });
});
