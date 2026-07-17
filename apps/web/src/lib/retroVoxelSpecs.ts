/**
 * Pure specification of the backdrop's 3D props: how to decode each sprite to
 * pixels, and — for every placed prop — its depth, centre anchor, size and
 * motion. Kept free of the editor's voxel core (which pulls the WASM engine
 * barrel) so it loads under the node TS hook and the same data drives both the
 * app and the offline render checks. The extrusion into voxel models lives in
 * retroVoxels.ts.
 */

import type { MotionParams } from "./bobSpin";
import {
  ARCADE,
  CARTRIDGE,
  COIN,
  CONSOLE,
  GAMEPAD,
  GHOST,
  HEART,
  INKS,
  INVADER,
  ROBOT,
  STAR,
  TRANSPARENT,
  type Sprite,
} from "./retroSprites";

/** Decoded pixels of a sprite, ready to extrude. */
export interface SpritePixels {
  readonly albedo: Uint8ClampedArray;
  readonly emissive: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Turn a character sprite + its ink table into straight-alpha pixels + emissive. */
export function spriteToPixels(sprite: Sprite): SpritePixels {
  const width = sprite.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const height = sprite.rows.length;
  const albedo = new Uint8ClampedArray(width * height * 4);
  const emissive = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    const row = sprite.rows[y]!;
    for (let x = 0; x < row.length; x += 1) {
      const glyph = row[x]!;
      if (glyph === TRANSPARENT || glyph === " ") continue;
      const ink = INKS[glyph];
      if (!ink) continue;
      const p = y * width + x;
      albedo[p * 4] = ink.rgb[0];
      albedo[p * 4 + 1] = ink.rgb[1];
      albedo[p * 4 + 2] = ink.rgb[2];
      albedo[p * 4 + 3] = 255;
      emissive[p] = Math.round((ink.emissive ?? 0) * 255);
    }
  }
  return { albedo, emissive, width, height };
}

/** A world-fixed light with the structural shape of the editor's ModelLight. */
export interface BackdropLightSpec {
  readonly direction: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly ambient: number;
}

function normalized(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/** A warm key light from the upper-front; spinning props turn their faces into it. */
export const BACKDROP_LIGHT: BackdropLightSpec = {
  direction: normalized(0.45, 0.72, 0.62),
  color: [1, 0.98, 0.92],
  intensity: 1,
  ambient: 0.34,
};

/**
 * Bob + occasional-spin profile with individual phases so nothing moves in sync.
 * The spin is deliberately slow (a full turn takes {@link MotionParams.spinDuration}
 * seconds): a leisurely rotation both reads as a solid object turning and leaves
 * almost no per-frame voxel crawl for the renderer's anti-aliasing to smooth.
 */
function motion(over: Partial<MotionParams> = {}): MotionParams {
  return {
    bobAmplitude: 3,
    bobPeriod: 4,
    bobPhase: 0,
    spinCycle: 15,
    spinDuration: 6,
    spinPhase: 0,
    ...over,
  };
}

/** How each prop is built and placed. Positions are centre anchors (0..1). */
export interface PropSpec {
  readonly name: string;
  readonly sprite: Sprite;
  readonly depth: number;
  readonly fx: number;
  readonly fy: number;
  readonly cell: number;
  readonly motion: MotionParams;
}

// Depths give each prop real front-to-back volume (~0.9× its shorter sprite side,
// floored so nothing collapses to a sliver when it turns side-on) so the props
// read as solid blocks through a whole spin rather than as flat cards.
export const PROP_SPECS: readonly PropSpec[] = [
  { name: "Arcade cabinet", sprite: ARCADE, depth: 12, fx: 0.11, fy: 0.44, cell: 2, motion: motion({ bobPhase: 0.0, spinPhase: 0.05 }) },
  { name: "Console", sprite: CONSOLE, depth: 9, fx: 0.82, fy: 0.8, cell: 2, motion: motion({ bobPhase: 0.5, spinPhase: 0.55 }) },
  { name: "Gamepad", sprite: GAMEPAD, depth: 8, fx: 0.47, fy: 0.84, cell: 2, motion: motion({ bobPhase: 0.25, spinPhase: 0.3 }) },
  { name: "Cartridge (left)", sprite: CARTRIDGE, depth: 11, fx: 0.31, fy: 0.17, cell: 2, motion: motion({ bobPhase: 0.7, spinPhase: 0.15 }) },
  { name: "Cartridge (right)", sprite: CARTRIDGE, depth: 11, fx: 0.9, fy: 0.24, cell: 2, motion: motion({ bobPhase: 0.15, spinPhase: 0.8 }) },
  { name: "Invader", sprite: INVADER, depth: 7, fx: 0.58, fy: 0.16, cell: 2, motion: motion({ bobAmplitude: 4, bobPhase: 0.4, spinPhase: 0.45 }) },
  { name: "Ghost", sprite: GHOST, depth: 9, fx: 0.78, fy: 0.42, cell: 2, motion: motion({ bobAmplitude: 4, bobPhase: 0.85, spinPhase: 0.65 }) },
  { name: "Robot", sprite: ROBOT, depth: 9, fx: 0.19, fy: 0.78, cell: 2, motion: motion({ bobPhase: 0.6, spinPhase: 0.25 }) },
  { name: "Coin", sprite: COIN, depth: 6, fx: 0.48, fy: 0.45, cell: 3, motion: motion({ bobPhase: 0.2, spinCycle: 10, spinDuration: 4, spinPhase: 0.0 }) },
  { name: "Heart", sprite: HEART, depth: 7, fx: 0.9, fy: 0.54, cell: 3, motion: motion({ bobAmplitude: 4, bobPhase: 0.35, spinCycle: 20, spinPhase: 0.9 }) },
  { name: "Star (centre)", sprite: STAR, depth: 6, fx: 0.36, fy: 0.56, cell: 3, motion: motion({ bobPhase: 0.55, spinCycle: 9, spinPhase: 0.4 }) },
  { name: "Star (right)", sprite: STAR, depth: 6, fx: 0.66, fy: 0.6, cell: 2, motion: motion({ bobPhase: 0.1, spinCycle: 11, spinPhase: 0.7 }) },
  { name: "Star (upper-left)", sprite: STAR, depth: 6, fx: 0.24, fy: 0.32, cell: 2, motion: motion({ bobAmplitude: 2, bobPhase: 0.9, spinCycle: 13, spinPhase: 0.2 }) },
];
