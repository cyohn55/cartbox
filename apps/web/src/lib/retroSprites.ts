/**
 * Original retro-arcade pixel-art sprites for the onboarding backdrop.
 *
 * Each sprite is a compact pixel map (an array of equal-conceptual-width rows)
 * whose characters index a shared {@link INKS} table. An ink carries not just a
 * colour but the material hints the console's lighting model consumes — surface
 * height (for bevels and self-shadow), specular strength, roughness, and an
 * optional self-emissive glow. `stampSprite` paints those channels into a
 * scene's aligned buffers, so every prop is relit each frame exactly like the
 * rest of the wall.
 *
 * The art is deliberately original (a gamepad, cartridge, console, arcade
 * cabinet, and generic characters) rather than any trademarked design.
 *
 * Pure module: no DOM, no engine barrel, so it stays unit-testable on its own.
 */

import type { Rgb } from "./litBackdrop";

/** A material-tagged colour. Defaults model matte plastic raised off the wall. */
export interface Ink {
  readonly rgb: Rgb;
  /** Surface height 0..1 (drives bevel normals + self-shadow). Default 0.72. */
  readonly height?: number;
  /** Specular strength 0..1. Default 0.32. */
  readonly spec?: number;
  /** Roughness 0..1 (higher = softer highlight). Default 0.5. */
  readonly rough?: number;
  /** Self-emissive strength 0..1. Default 0 (not emissive). */
  readonly emissive?: number;
  /** Emissive colour; defaults to `rgb` when the ink glows. */
  readonly emissiveColor?: Rgb;
}

/** Character that marks a transparent (unpainted) sprite pixel. */
export const TRANSPARENT = ".";

/**
 * Shared ink table. Lower-case letters are matte plastics; `X` is the dark
 * outline (recessed + matte so sprites read as raised); `M` is glossy metal;
 * upper-case/digit inks glow (screens, LEDs, stars) so they pop in shadow.
 */
export const INKS: Readonly<Record<string, Ink>> = {
  // Structure.
  X: { rgb: [14, 16, 26], height: 0.34, spec: 0.05, rough: 0.95 },
  W: { rgb: [224, 230, 238], height: 0.74 },
  w: { rgb: [170, 179, 194], height: 0.7 },
  g: { rgb: [116, 125, 142], height: 0.68 },
  d: { rgb: [66, 74, 92], height: 0.66 },
  // Plastics.
  r: { rgb: [222, 66, 74] },
  e: { rgb: [150, 40, 52] },
  o: { rgb: [242, 150, 54] },
  y: { rgb: [244, 214, 84] },
  l: { rgb: [110, 206, 110] },
  n: { rgb: [58, 150, 86] },
  c: { rgb: [92, 214, 232] },
  b: { rgb: [78, 132, 224] },
  u: { rgb: [52, 82, 168] },
  p: { rgb: [170, 110, 224] },
  m: { rgb: [232, 104, 180] },
  // Glossy gold metal (cartridge contacts, coin shine).
  M: { rgb: [214, 180, 90], height: 0.6, spec: 0.86, rough: 0.14 },
  // Emissive screens.
  S: { rgb: [150, 236, 246], height: 0.5, spec: 0.1, rough: 0.6, emissive: 1, emissiveColor: [96, 224, 244] },
  G: { rgb: [160, 244, 168], height: 0.5, spec: 0.1, rough: 0.6, emissive: 1, emissiveColor: [110, 232, 130] },
  // Emissive accent LEDs / buttons (digits) and glowing icons.
  "1": { rgb: [255, 96, 96], emissive: 0.9, emissiveColor: [255, 70, 80] },
  "2": { rgb: [110, 255, 130], emissive: 0.9, emissiveColor: [90, 255, 120] },
  "3": { rgb: [120, 160, 255], emissive: 0.9, emissiveColor: [110, 150, 255] },
  "4": { rgb: [255, 224, 96], emissive: 0.9, emissiveColor: [255, 216, 84] },
  "*": { rgb: [255, 244, 168], height: 0.55, emissive: 1, emissiveColor: [255, 236, 150] },
  "+": { rgb: [255, 150, 200], height: 0.55, emissive: 1, emissiveColor: [255, 120, 186] },
};

/** A named sprite: rows of ink characters, ragged rows padded as transparent. */
export interface Sprite {
  readonly rows: readonly string[];
}

const sprite = (rows: readonly string[]): Sprite => ({ rows });

/** Widest row — sprites may be ragged; short rows are transparent-padded. */
export function spriteWidth(s: Sprite): number {
  return s.rows.reduce((max, row) => Math.max(max, row.length), 0);
}

/** Row count. */
export function spriteHeight(s: Sprite): number {
  return s.rows.length;
}

// --- The sprite set -------------------------------------------------------

/** Two-handed gamepad: D-pad at left, four glowing face buttons at right. */
export const GAMEPAD = sprite([
  "....XXXXXXXXXXXXXXXX....",
  "..XXWWWWWWWWWWWWWWWWXX..",
  ".XWWWWWWWWWWWWWWWWWWWWX.",
  ".XWWXwXWWWWWWWWW1WWWWWX.",
  ".XWWwwwWWWWWWWW4W2WWWWX.",
  ".XWWXwXWWWWWWWWW3WWWWWX.",
  ".XWWWWWWWWWWWWWWWWWWWWX.",
  "..XXWWWWWWWWWWWWWWWWXX..",
  "....XXXXXXXXXXXXXXXX....",
]);

/** Game cartridge: blue shell, white label with art, gold edge contacts. */
export const CARTRIDGE = sprite([
  ".XXXXXXXXXX.",
  ".XbbbbbbbbX.",
  ".XbWWWWWWbX.",
  ".XbWyllyWbX.",
  ".XbWyllyWbX.",
  ".XbWyllyWbX.",
  ".XbWWWWWWbX.",
  ".XbbbbbbbbX.",
  ".XbbbbbbbbX.",
  ".Xb.bb.bbX.",
  ".XbbbbbbbbX.",
  "XMMMMMMMMMMX",
  "XM.M.M.M.MMX",
  ".XXXXXXXXXX.",
]);

/** Flat home console: grey shell, green power LED, dark cartridge slot. */
export const CONSOLE = sprite([
  "XXXXXXXXXXXXXXXXXXXX",
  "XWWWWWWWWWWWWWWWWWWX",
  "XWggggggggggggggggWX",
  "XWg2ggggggggggggggWX",
  "XWggggggggggggggggWX",
  "XWWWWWWWWWWWWWWWWWWX",
  "XWddddddddddddddddWX",
  "XWddddddddddddddddWX",
  "XWWWWWWWWWWWWWWWWWWX",
  "XXXXXXXXXXXXXXXXXXXX",
]);

/** Upright arcade cabinet: marquee, glowing screen, control panel, red body. */
export const ARCADE = sprite([
  ".XXXXXXXXXXXX.",
  ".XyyyyyyyyyyX.",
  ".XuSSSSSSSSuX.",
  ".XuSSSSSSSSuX.",
  ".XuSSSSSSSSuX.",
  ".XuSSSSSSSSuX.",
  ".XddddddddddX.",
  ".Xd1dd2dd3dX.",
  ".XddddddddddX.",
  ".XrrrrrrrrrrX.",
  ".XrrrrrrrrrrX.",
  ".XrreeeerrrrX.",
  ".XrrrrrrrrrrX.",
  ".XddddddddddX.",
  ".XXXXXXXXXXXX.",
]);

/** Classic-style descending invader (original silhouette). */
export const INVADER = sprite([
  "..l.....l..",
  "...l...l...",
  "..lllllll..",
  ".ll.lll.ll.",
  "lllllllllll",
  "l.lllllll.l",
  "l.l.....l.l",
  "...ll.ll...",
]);

/** Friendly ghost: purple body, white eyes, blue pupils, wavy hem. */
export const GHOST = sprite([
  "...XXXX...",
  "..XppppX..",
  ".XppppppX.",
  ".XWWppWWX.",
  ".XWuppWuX.",
  ".XppppppX.",
  ".XppppppX.",
  ".XppppppX.",
  ".XppppppX.",
  ".Xp.pp.pX.",
  ".X.XX.X.X.",
]);

/** Blocky retro robot: cyan chest panel, glowing eyes and buttons. */
export const ROBOT = sprite([
  "..XXXXXX..",
  ".XWWWWWWX.",
  ".XW3WW3WX.",
  ".XWWWWWWX.",
  ".XW1111WX.",
  "..XXXXXX..",
  "...XwwX...",
  ".XXXXXXXX.",
  "XWccccccWX",
  "XWc1234cWX",
  "XWccccccWX",
  "XWWWWWWWWX",
  ".X.XX.X.X.",
]);

/** Glowing five-point star. */
export const STAR = sprite([
  "....*....",
  "...***...",
  ".*******.",
  "..*****..",
  "..*****..",
  ".**...**.",
  ".*.....*.",
]);

/** Glowing heart (a life pickup). */
export const HEART = sprite([
  ".++.+.++.",
  "+++++++++",
  "+++++++++",
  "+++++++++",
  ".+++++++.",
  "..+++++..",
  "...+++...",
  "....+....",
]);

/** Spinning-style gold coin. */
export const COIN = sprite([
  "..oooo..",
  ".oyyyyo.",
  "oyyMMyyo",
  "oyMMMMyo",
  "oyyMMyyo",
  ".oyyyyo.",
  "..oooo..",
]);

/**
 * The channel surface `stampSprite` writes into — the mutable subset of a
 * BackdropScene. Kept structural so both this module and the scene builder can
 * share it without a circular import.
 */
export interface StampTarget {
  readonly width: number;
  readonly height: number;
  readonly albedo: Uint8ClampedArray; // width*height*3
  readonly heightField: Float32Array;
  readonly specular: Float32Array;
  readonly roughness: Float32Array;
  readonly emissive: Float32Array;
  readonly emissiveColor: Uint8ClampedArray; // width*height*3
}

const DEFAULT_HEIGHT = 0.72;
const DEFAULT_SPEC = 0.32;
const DEFAULT_ROUGH = 0.5;

/**
 * Paint `sprite` into `target` with its top-left at (originX, originY),
 * optionally nearest-neighbour upscaled by an integer `scale`. Transparent
 * characters are skipped (they let the wall show through); opaque pixels
 * overwrite every material channel so props layer cleanly (last stamp wins).
 * Pixels outside the buffer are clipped. Returns the number of pixels painted.
 */
export function stampSprite(
  target: StampTarget,
  sprite: Sprite,
  originX: number,
  originY: number,
  scale = 1,
): number {
  const step = Math.max(1, Math.floor(scale));
  let painted = 0;

  for (let sy = 0; sy < sprite.rows.length; sy += 1) {
    const row = sprite.rows[sy]!;
    for (let sx = 0; sx < row.length; sx += 1) {
      const glyph = row[sx]!;
      if (glyph === TRANSPARENT || glyph === " ") continue;
      const ink = INKS[glyph];
      if (!ink) continue;

      const h = ink.height ?? DEFAULT_HEIGHT;
      const spec = ink.spec ?? DEFAULT_SPEC;
      const rough = ink.rough ?? DEFAULT_ROUGH;
      const emis = ink.emissive ?? 0;
      const [er, eg, eb] = ink.emissiveColor ?? ink.rgb;

      for (let dy = 0; dy < step; dy += 1) {
        const y = originY + sy * step + dy;
        if (y < 0 || y >= target.height) continue;
        for (let dx = 0; dx < step; dx += 1) {
          const x = originX + sx * step + dx;
          if (x < 0 || x >= target.width) continue;
          const i = y * target.width + x;
          target.albedo[i * 3] = ink.rgb[0];
          target.albedo[i * 3 + 1] = ink.rgb[1];
          target.albedo[i * 3 + 2] = ink.rgb[2];
          target.heightField[i] = h;
          target.specular[i] = spec;
          target.roughness[i] = rough;
          target.emissive[i] = emis;
          target.emissiveColor[i * 3] = er;
          target.emissiveColor[i * 3 + 1] = eg;
          target.emissiveColor[i * 3 + 2] = eb;
          painted += 1;
        }
      }
    }
  }
  return painted;
}
