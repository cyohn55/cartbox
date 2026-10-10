/**
 * A vector stroke font (HALO_INFINITE_STYLE_ROADMAP.md I12): every glyph is a
 * few polylines on a 4 × 6 grid, drawn by its exact distance to those lines —
 * a signed distance field computed rather than sampled from a texture — so
 * text is crisp at any size, and the same distance gives the glow round it.
 * Thin, even strokes are the look of a visor's display.
 *
 * Coordinates are in glyph units, x right and y down from the top of the
 * capital; lowercase draws as uppercase. Pure and DOM-free.
 */

/** A glyph's cell: its strokes span 4 units across and 6 down. */
export const GLYPH_WIDTH = 4;
export const GLYPH_HEIGHT = 6;
/** Units from one glyph's left edge to the next's. */
export const GLYPH_ADVANCE = 5.5;

/** Each glyph's polylines, as "x,y x,y …" strings. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["0,0 4,0 4,6 0,6 0,0", "4,0 0,6"],
  "1": ["1,1 2,0 2,6", "1,6 3,6"],
  "2": ["0,1 1,0 3,0 4,1 4,2 0,6 4,6"],
  "3": ["0,0 4,0 2,2.5 3,2.5 4,3.5 4,5 3,6 1,6 0,5"],
  "4": ["3,6 3,0 0,4 4,4"],
  "5": ["4,0 0,0 0,2.5 3,2.5 4,3.5 4,5 3,6 0,6"],
  "6": ["4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3.5 3,2.5 0,2.5"],
  "7": ["0,0 4,0 1.5,6"],
  "8": ["1,0 3,0 4,1 4,2 3,3 1,3 0,2 0,1 1,0", "1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3"],
  "9": ["4,3.5 1,3.5 0,2.5 0,1 1,0 3,0 4,1 4,5 3,6 1,6 0,5"],
  A: ["0,6 0,2 2,0 4,2 4,6", "0,3.5 4,3.5"],
  B: ["0,0 0,6 3,6 4,5 4,4 3,3 0,3", "0,0 3,0 4,1 4,2 3,3"],
  C: ["4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5"],
  D: ["0,0 0,6 2.5,6 4,4.5 4,1.5 2.5,0 0,0"],
  E: ["4,0 0,0 0,6 4,6", "0,3 3,3"],
  F: ["4,0 0,0 0,6", "0,3 3,3"],
  G: ["4,1 3,0 1,0 0,1 0,5 1,6 3,6 4,5 4,3.5 2.5,3.5"],
  H: ["0,0 0,6", "4,0 4,6", "0,3 4,3"],
  I: ["1,0 3,0", "2,0 2,6", "1,6 3,6"],
  J: ["1,0 4,0", "3,0 3,5 2,6 1,6 0,5"],
  K: ["0,0 0,6", "4,0 0,3.5", "1.5,2.5 4,6"],
  L: ["0,0 0,6 4,6"],
  M: ["0,6 0,0 2,3 4,0 4,6"],
  N: ["0,6 0,0 4,6 4,0"],
  O: ["1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0"],
  P: ["0,6 0,0 3,0 4,1 4,2 3,3 0,3"],
  Q: ["1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,1 1,0", "2.5,4.5 4,6"],
  R: ["0,6 0,0 3,0 4,1 4,2 3,3 0,3", "2,3 4,6"],
  S: ["4,1 3,0 1,0 0,1 0,2 1,3 3,3 4,4 4,5 3,6 1,6 0,5"],
  T: ["0,0 4,0", "2,0 2,6"],
  U: ["0,0 0,5 1,6 3,6 4,5 4,0"],
  V: ["0,0 2,6 4,0"],
  W: ["0,0 1,6 2,3 3,6 4,0"],
  X: ["0,0 4,6", "4,0 0,6"],
  Y: ["0,0 2,3 4,0", "2,3 2,6"],
  Z: ["0,0 4,0 0,6 4,6"],
  " ": [],
  ".": ["2,5.7 2,6"],
  ",": ["2,5.5 1.5,7"],
  ":": ["2,1.8 2,2.2", "2,4.8 2,5.2"],
  ";": ["2,1.8 2,2.2", "2,4.8 1.5,6.5"],
  "/": ["4,0 0,6"],
  "\\": ["0,0 4,6"],
  "-": ["0.5,3 3.5,3"],
  "+": ["0.5,3 3.5,3", "2,1.5 2,4.5"],
  "=": ["0.5,2 3.5,2", "0.5,4 3.5,4"],
  _: ["0,6 4,6"],
  "%": ["0,6 4,0", "0.5,0.5 1,0.5", "3,5.5 3.5,5.5"],
  "!": ["2,0 2,4", "2,5.7 2,6"],
  "?": ["0,1 1,0 3,0 4,1 4,2 2,3.5 2,4.2", "2,5.7 2,6"],
  "'": ["2,0 2,1.5"],
  '"': ["1.3,0 1.3,1.5", "2.7,0 2.7,1.5"],
  "(": ["3,0 1.5,1.5 1.5,4.5 3,6"],
  ")": ["1,0 2.5,1.5 2.5,4.5 1,6"],
  "[": ["3,0 1.5,0 1.5,6 3,6"],
  "]": ["1,0 2.5,0 2.5,6 1,6"],
  "<": ["4,0.5 0,3 4,5.5"],
  ">": ["0,0.5 4,3 0,5.5"],
  "#": ["1,0.5 1,5.5", "3,0.5 3,5.5", "0,2 4,2", "0,4 4,4"],
  "*": ["2,1 2,5", "0.5,2 3.5,4", "3.5,2 0.5,4"],
  "|": ["2,0 2,6"],
  "@": ["3,4 3,2 1,2 1,4 4,4 4,1 3,0 1,0 0,1 0,5 1,6 4,6"],
};

/** An undrawable character: an empty box. */
const MISSING = ["0,0 4,0 4,6 0,6 0,0"];

/** A line segment, x0 y0 x1 y1. */
export type Segment = readonly [number, number, number, number];

const parsed = new Map<string, Segment[]>();
/** A character's segments in glyph units (lowercase as uppercase; unknown as a box). */
export function glyphSegments(ch: string): readonly Segment[] {
  const key = ch.toUpperCase();
  let out = parsed.get(key);
  if (!out) {
    out = [];
    for (const line of GLYPHS[key] ?? MISSING) {
      const pts = line.split(" ").map((p) => p.split(",").map(Number) as [number, number]);
      for (let i = 0; i + 1 < pts.length; i += 1) out.push([pts[i]![0], pts[i]![1], pts[i + 1]![0], pts[i + 1]![1]]);
    }
    parsed.set(key, out);
  }
  return out;
}

/** Whether the font has a glyph for a character (else it draws as a box). */
export function hasGlyph(ch: string): boolean {
  return ch.toUpperCase() in GLYPHS;
}

/** A string's width in pixels at a cap height of `height` pixels. */
export function strokeTextWidth(text: string, height: number): number {
  if (text.length === 0) return 0;
  const unit = height / GLYPH_HEIGHT;
  return ((text.length - 1) * GLYPH_ADVANCE + GLYPH_WIDTH) * unit;
}

/** One glyph placed: its segments in pixels and its box (for culling). */
export interface PlacedGlyph {
  readonly segments: readonly Segment[];
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * A line of text laid out in pixels: cap height `height`, its top at `y`,
 * aligned in the span from `x` to `x + width` (left, centre or right).
 */
export function layoutStrokeText(text: string, x: number, y: number, width: number, height: number, align: "left" | "center" | "right" = "left"): PlacedGlyph[] {
  const unit = height / GLYPH_HEIGHT;
  const w = strokeTextWidth(text, height);
  const left = align === "center" ? x + (width - w) / 2 : align === "right" ? x + width - w : x;
  const out: PlacedGlyph[] = [];
  [...text].forEach((ch, i) => {
    const gx = left + i * GLYPH_ADVANCE * unit;
    const segments = glyphSegments(ch).map(([a, b, c, d]) => [gx + a * unit, y + b * unit, gx + c * unit, y + d * unit] as const);
    if (segments.length > 0) out.push({ segments, x0: gx, y0: y, x1: gx + GLYPH_WIDTH * unit, y1: y + 7 * unit });
  });
  return out;
}

/** Distance from (px, py) to a segment. */
export function segmentDistance(px: number, py: number, s: Segment): number {
  const dx = s[2] - s[0];
  const dy = s[3] - s[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - s[0]) * dx + (py - s[1]) * dy) / len2)) : 0;
  return Math.hypot(px - (s[0] + dx * t), py - (s[1] + dy * t));
}
