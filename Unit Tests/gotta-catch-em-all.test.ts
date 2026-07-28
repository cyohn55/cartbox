/**
 * "Gotta Catch 'Em All" cart — behavioural tests on the real Classic core.
 *
 * Loads the actual built .tic (assembled from the Cartbox editor asset models +
 * game.lua) and the shipped Classic engine, runs it, and asserts on the pixels:
 * the overworld renders with its HUD, the world scrolls when the player walks,
 * and the authored grassy palette is what shows. Nothing is stubbed and no
 * golden image is baked in — expectations come from the game's own design
 * (HUD height, gamepad bits, palette intent) applied to the rendered frames.
 *
 * Skips (with a warning) if the engine or the built cart is missing.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const W = 240, H = 136;
const HUD_H = 9;                 // game.lua draws the HUD bar in the top 9 rows
const GP_DOWN = 1 << 1;          // Classic gamepad bit for "down" (ConsoleButton)

const enginePath = fileURLToPath(
  new URL("../packages/engine/dist/tic80.js", import.meta.url),
);
const cartPath = fileURLToPath(new URL("../../gotta-catch-em-all/game.tic", import.meta.url));
const ready = existsSync(enginePath) && existsSync(cartPath);
const suite = ready ? describe : describe.skip;
if (!ready) {
  console.warn(`[gotta-catch] engine or game.tic missing; skipping. Run Working/gotta-catch-em-all/run.sh.`);
}

type Frame = Uint8Array;

suite("Gotta Catch 'Em All on the real Classic core", () => {
  let mod: any;

  beforeAll(async () => {
    mod = await (await import(pathToFileURL(enginePath).href)).default();
  }, 30000);

  /** Run the cart from cold and return snapshots at the requested frames, each
   * frame advanced with the given gamepad mask. */
  function run(steps: Array<{ mask: number }>, capture: number[]): Map<number, Frame> {
    const cart = new Uint8Array(readFileSync(cartPath));
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(cart.byteLength);
    mod.HEAPU8.set(cart, ptr);
    mod._cbx_load(h, ptr, cart.byteLength);
    mod._free(ptr);
    const want = new Set(capture);
    const out = new Map<number, Frame>();
    for (let f = 0; f < steps.length; f++) {
      mod._cbx_tick(h, steps[f].mask);
      if (want.has(f)) {
        const sp = mod._cbx_screen_ptr(h);
        out.set(f, Uint8Array.from(mod.HEAPU8.subarray(sp, sp + W * H * 4)));
      }
    }
    mod._cbx_delete(h);
    return out;
  }

  const rgb = (f: Frame, x: number, y: number) => {
    const i = (y * W + x) * 4;
    return [f[i], f[i + 1], f[i + 2]] as const;
  };

  it("renders a populated overworld frame", () => {
    const frame = run(Array(6).fill({ mask: 0 }), [5]).get(5)!;
    expect(frame.byteLength).toBe(W * H * 4);
    const colors = new Set<number>();
    let nonBlack = 0;
    for (let i = 0; i < frame.length; i += 4) {
      colors.add((frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2]);
      if (frame[i] || frame[i + 1] || frame[i + 2]) nonBlack++;
    }
    expect(colors.size).toBeGreaterThan(6);              // palette + sprites in use
    expect(nonBlack / (W * H)).toBeGreaterThan(0.6);     // not a blank/black screen
  });

  it("draws a solid HUD bar with bright text across the top", () => {
    const frame = run(Array(6).fill({ mask: 0 }), [5]).get(5)!;
    // The HUD bar is one flat dark colour spanning the full width on a top row.
    const y = 3;
    const counts = new Map<number, number>();
    for (let x = 0; x < W; x++) {
      const [r, g, b] = rgb(frame, x, y);
      const key = (r << 16) | (g << 8) | b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const [barKey, barCount] = [...counts].sort((a, b) => b[1] - a[1])[0];
    const barLum = ((barKey >> 16) + ((barKey >> 8) & 255) + (barKey & 255)) / 3;
    expect(barCount / W).toBeGreaterThan(0.5);           // one colour dominates the row
    expect(barLum).toBeLessThan(90);                     // and it's dark (the bar)

    // Bright HUD text (the lightest palette entry) appears in the bar.
    let bright = 0;
    for (let yy = 0; yy < HUD_H; yy++)
      for (let x = 0; x < W; x++) {
        const [r, g, b] = rgb(frame, x, yy);
        if (r > 200 && g > 220 && b > 180) bright++;
      }
    expect(bright).toBeGreaterThan(30);                  // "POKEDEX 0/3" etc.
  });

  it("is grass-dominant below the HUD (the authored palette shows through)", () => {
    const frame = run(Array(6).fill({ mask: 0 }), [5]).get(5)!;
    let grass = 0, total = 0;
    for (let y = HUD_H; y < H; y++)
      for (let x = 0; x < W; x++) {
        const [r, g, b] = rgb(frame, x, y);
        total++;
        if (g > r && g > b && g > 70) grass++;           // green terrain
      }
    expect(grass / total).toBeGreaterThan(0.2);
  });

  it("scrolls the world when the player walks (movement is live)", () => {
    // Hold "down" and compare the play area before vs after — the camera follows
    // the player through the authored map, so the frame must change.
    const shots = run(
      [{ mask: 0 }, ...Array(14).fill({ mask: GP_DOWN })],
      [0, 14],
    );
    const a = shots.get(0)!;
    const b = shots.get(14)!;
    let diff = 0, total = 0;
    for (let y = HUD_H; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        total++;
      }
    expect(diff / total).toBeGreaterThan(5);             // meaningful visual change
  });
});
