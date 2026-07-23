/**
 * A reusable **voxel / hexel alphabet**: a compact 5×7 bitmap font plus builders
 * that turn a string into a renderable 3D model made of cube voxels or rhombic
 * hexels. Text becomes a real object in the scene — extruded, lit and depth-sorted
 * like any other {@link VoxelModel} — so it can front an onboarding headline, a
 * title card, an in-world sign, or anything else that wants blocky retro type.
 *
 * Three entry points, sharing one font:
 *  - {@link buildGlyphModel} — one character as its own model (fixed 5×7 cell, so
 *    every glyph shares a baseline).
 *  - {@link buildVoxelText} — a whole (optionally multi-line) string merged into a
 *    single model. Cheapest to render; best for static type.
 *  - {@link layoutVoxelText} — the string as a list of per-letter models with
 *    positions, so a caller can animate each letter independently (e.g. a bob).
 *
 * Cube vs hexel is chosen with `shape`: cubes stamp one cell per lit pixel; hexels
 * scale up ×2 and fill only the even-parity FCC sites the rhombic lattice needs,
 * so the letters read as close-packed rounded cells rather than square blocks.
 */

import { geometryFor } from "../render/cellGeometry";
import type { CellShape } from "../render/cellGeometry";
import type { Rgb } from "./lighting";
import { VoxelGrid, voxelGridToModel, type GridVoxelModel } from "./VoxelGrid";

/** Cell columns per glyph. */
export const FONT_WIDTH = 5;
/** Cell rows per glyph. */
export const FONT_HEIGHT = 7;

type Row = string;

/**
 * The 5×7 uppercase font. Each glyph is seven rows of five cells, `#` filled and
 * `.` empty, top row first. Covers A–Z, 0–9, space, the punctuation the arcade
 * taglines use, and a heart. Lowercase input is folded to uppercase; unknown
 * characters render as a space.
 */
export const VOXEL_FONT: Readonly<Record<string, readonly Row[]>> = {
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".####", "#....", "#....", "#..##", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  J: ["..###", "...#.", "...#.", "...#.", "#..#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", ".##..", ".#..."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  "'": ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  "/": ["....#", "....#", "...#.", "..#..", ".#...", "#....", "#...."],
  "[": [".###.", ".#...", ".#...", ".#...", ".#...", ".#...", ".###."],
  "]": [".###.", "...#.", "...#.", "...#.", "...#.", "...#.", ".###."],
  "♥": [".....", ".#.#.", "#####", "#####", ".###.", "..#..", "....."],
};

/** Per-glyph colour: a fixed triple, or a function of position in the text. */
export type GlyphColor = Rgb | ((lineIndex: number, charIndex: number, char: string) => Rgb);

export interface VoxelTextOptions {
  /** Cube voxels (default) or rhombic hexels. */
  readonly shape?: CellShape;
  /** Extrusion depth in cells (how thick the letters are). Default 2. */
  readonly depth?: number;
  /** Fill colour, or a per-glyph colour function. Default a bright off-white. */
  readonly color?: GlyphColor;
  /** Self-emissive strength 0..255 (a retro glow). Default 0 (lit by the scene). */
  readonly emissive?: number;
  /** Blank cells between glyphs. Default 1. */
  readonly letterSpacing?: number;
  /** Blank rows between lines. Default 2. */
  readonly lineSpacing?: number;
  /** Horizontal alignment of each line within the block. Default "center". */
  readonly align?: "left" | "center";
}

const DEFAULT_COLOR: Rgb = [232, 238, 250];

/** The glyph rows for a character, folded to uppercase, or the space glyph. */
function glyphFor(char: string): readonly Row[] {
  return VOXEL_FONT[char] ?? VOXEL_FONT[char.toUpperCase()] ?? VOXEL_FONT[" "]!;
}

/** Resolve a {@link GlyphColor} for one glyph. */
function resolveColor(color: GlyphColor | undefined, line: number, col: number, char: string): Rgb {
  if (!color) return DEFAULT_COLOR;
  return typeof color === "function" ? color(line, col, char) : color;
}

/** Hexels scale the bitmap up so the even-parity FCC lattice still reads. */
function scaleFor(shape: CellShape): number {
  return shape === "hexel" ? 2 : 1;
}

/** Hexels need ≥2 depth layers so the ×2 scale fills a solid across parities. */
function depthFor(shape: CellShape, depth: number): number {
  return shape === "hexel" ? Math.max(2, depth) : depth;
}

/**
 * Stamp one glyph into `grid` with its bottom-left glyph pixel at cell
 * `(originX, originY)` (pre-scale), flipping rows so the top of the bitmap is the
 * top of the letter (y up). Scales by `scale` and fills `depth` layers; for
 * hexels only even-parity `(x+y+z)` sites are set, so the rhombic lattice stays
 * closed. Silently clips anything out of bounds (VoxelGrid.set is a no-op there).
 */
function stampGlyph(
  grid: VoxelGrid,
  glyph: readonly Row[],
  originX: number,
  originY: number,
  scale: number,
  depth: number,
  hexel: boolean,
  [r, g, b]: Rgb,
  emissive: number,
): void {
  for (let row = 0; row < FONT_HEIGHT; row += 1) {
    const bits = glyph[row] ?? "";
    // Top row (row 0) is the highest cell; flip within the glyph's 7-row box.
    const pixelY = originY + (FONT_HEIGHT - 1 - row);
    for (let col = 0; col < FONT_WIDTH; col += 1) {
      if (bits[col] !== "#") continue;
      const pixelX = originX + col;
      for (let sx = 0; sx < scale; sx += 1) {
        for (let sy = 0; sy < scale; sy += 1) {
          const x = pixelX * scale + sx;
          const y = pixelY * scale + sy;
          for (let z = 0; z < depth; z += 1) {
            if (hexel && ((x + y + z) & 1) !== 0) continue;
            grid.set(x, y, z, r, g, b, emissive);
          }
        }
      }
    }
  }
}

/** Whether any cell in the grid is occupied (alpha > 0). */
function hasFilledCell(grid: VoxelGrid): boolean {
  for (let alpha = 3; alpha < grid.colors.length; alpha += 4) {
    if (grid.colors[alpha]! > 0) return true;
  }
  return false;
}

/** The width in glyph pixels a line of `charCount` monospace glyphs occupies. */
function lineWidthPx(charCount: number, letterSpacing: number): number {
  return charCount <= 0 ? 0 : charCount * FONT_WIDTH + (charCount - 1) * letterSpacing;
}

/** Split into uppercase lines and report the widest line + total block height. */
function measureText(
  text: string,
  letterSpacing: number,
  lineSpacing: number,
): { lines: string[]; widthPx: number; heightPx: number } {
  const lines = text.toUpperCase().split("\n");
  const widthPx = Math.max(1, ...lines.map((line) => lineWidthPx([...line].length, letterSpacing)));
  const heightPx = lines.length * FONT_HEIGHT + (lines.length - 1) * lineSpacing;
  return { lines, widthPx, heightPx };
}

/**
 * Build a single character as its own model, centred on a fixed 5×7×depth box so
 * every glyph shares one baseline and cell (what {@link layoutVoxelText} places).
 * Returns `null` for a glyph with no filled pixels (e.g. a space) so callers can
 * skip empty models while still advancing the pen.
 */
export function buildGlyphModel(char: string, options: VoxelTextOptions = {}): GridVoxelModel | null {
  const shape = options.shape ?? "cube";
  const scale = scaleFor(shape);
  const depth = depthFor(shape, options.depth ?? 2);
  const hexel = shape === "hexel";
  const glyph = glyphFor(char);

  const grid = new VoxelGrid(FONT_WIDTH * scale, FONT_HEIGHT * scale, depth);
  stampGlyph(grid, glyph, 0, 0, scale, depth, hexel, resolveColor(options.color, 0, 0, char), options.emissive ?? 0);
  if (!hasFilledCell(grid)) return null;
  // "grid" centring keeps the origin at the fixed box centre, so glyphs of
  // different content still line up on a shared baseline.
  return voxelGridToModel(grid, { center: "grid", geometry: geometryFor(shape) });
}

/**
 * Build a whole string (newlines start new lines) as one merged model. Cheapest to
 * render and the right choice for static type; use {@link layoutVoxelText} when the
 * letters need to animate independently.
 */
export function buildVoxelText(text: string, options: VoxelTextOptions = {}): GridVoxelModel {
  const shape = options.shape ?? "cube";
  const scale = scaleFor(shape);
  const depth = depthFor(shape, options.depth ?? 2);
  const hexel = shape === "hexel";
  const letterSpacing = options.letterSpacing ?? 1;
  const lineSpacing = options.lineSpacing ?? 2;
  const align = options.align ?? "center";
  const emissive = options.emissive ?? 0;

  const { lines, widthPx, heightPx } = measureText(text, letterSpacing, lineSpacing);
  const grid = new VoxelGrid(widthPx * scale, heightPx * scale, depth);

  lines.forEach((line, lineIndex) => {
    const chars = [...line];
    const startX = align === "center" ? Math.floor((widthPx - lineWidthPx(chars.length, letterSpacing)) / 2) : 0;
    // Rows measured from the top of the block; convert to a y-up bottom origin.
    const lineTopRow = lineIndex * (FONT_HEIGHT + lineSpacing);
    const bottomY = heightPx - lineTopRow - FONT_HEIGHT;
    chars.forEach((char, charIndex) => {
      const originX = startX + charIndex * (FONT_WIDTH + letterSpacing);
      stampGlyph(grid, glyphFor(char), originX, bottomY, scale, depth, hexel, resolveColor(options.color, lineIndex, charIndex, char), emissive);
    });
  });

  return voxelGridToModel(grid, { center: "content", geometry: geometryFor(shape) });
}

/** One placed letter: its model and the cell-space centre to render it at. */
export interface VoxelLetter {
  readonly char: string;
  readonly model: GridVoxelModel;
  readonly position: readonly [number, number, number];
}

/** A laid-out string: per-letter models with positions, and the block extent. */
export interface VoxelTextLayout {
  readonly letters: readonly VoxelLetter[];
  readonly width: number;
  readonly height: number;
}

/**
 * Lay a string out as individual letter models positioned around the block's
 * centre (cell units, y up, matching {@link buildVoxelText}'s coordinates), so a
 * caller can render each letter as its own placed model and animate them
 * independently — e.g. bob each one on a phase-shifted sine. Space glyphs advance
 * the pen without emitting a model.
 */
export function layoutVoxelText(text: string, options: VoxelTextOptions = {}): VoxelTextLayout {
  const shape = options.shape ?? "cube";
  const scale = scaleFor(shape);
  const letterSpacing = options.letterSpacing ?? 1;
  const lineSpacing = options.lineSpacing ?? 2;
  const align = options.align ?? "center";

  const { lines, widthPx, heightPx } = measureText(text, letterSpacing, lineSpacing);
  const letters: VoxelLetter[] = [];

  lines.forEach((line, lineIndex) => {
    const chars = [...line];
    const startX = align === "center" ? Math.floor((widthPx - lineWidthPx(chars.length, letterSpacing)) / 2) : 0;
    const lineTopRow = lineIndex * (FONT_HEIGHT + lineSpacing);
    chars.forEach((char, charIndex) => {
      const model = buildGlyphModel(char, options);
      if (!model) return; // spaces and blank glyphs still consume a slot below
      // The glyph's slot centre, in glyph pixels, relative to the block centre.
      const centreXPx = startX + charIndex * (FONT_WIDTH + letterSpacing) + FONT_WIDTH / 2;
      const centreYPx = heightPx - (lineTopRow + FONT_HEIGHT / 2);
      letters.push({
        char,
        model,
        position: [(centreXPx - widthPx / 2) * scale, (centreYPx - heightPx / 2) * scale, 0],
      });
    });
  });

  return { letters, width: widthPx * scale, height: heightPx * scale };
}
