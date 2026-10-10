/**
 * The holographic HUD (HALO_INFINITE_STYLE_ROADMAP.md I12): a holo UI
 * document drawn in true colour over the finished frame, the way a visor
 * projects its display. Everything is thin light: text in the vector stroke
 * font (strokeFont.ts) at any size, outlines, bars, arcs and a radar, each
 * drawn by its exact distance from the pixel — sharp, anti-aliased edges, and
 * from the same distance a soft glow. The whole document curves away toward
 * the screen's edges, as if on the inside of a visor.
 *
 * Pure and DOM-free: the player draws a cart's shown holo documents with it
 * each frame, and the editor's UI tab previews them with it.
 */

import { fillUiText, layoutUi, type UiDocument, type UiPlaced, type UiWidget } from "../model/ui";
import { layoutStrokeText, type Segment } from "./strokeFont";

type Rgb = readonly [number, number, number];

/** A holo widget's colour when it names none: visor cyan. */
export const HOLO_RGB: Rgb = [0.4, 0.85, 1];
/** A radar blip's colour by its kind: 0 the widget's own, 1 a hostile, 2 an objective. */
export const BLIP_RGB: readonly Rgb[] = [HOLO_RGB, [1, 0.3, 0.25], [1, 0.85, 0.3]];
/** Degrees a radar's sweep turns each second. */
export const RADAR_SWEEP_SPEED = 120;
/** Degrees the sweep jumps at a time. */
export const RADAR_SWEEP_STEP = 4;

/** What a holo document draws from: the cart's bindings, the clock, and its string table. */
export interface HoloContext {
  readonly bindings: Readonly<Record<string, unknown>>;
  /** Seconds (the radar's sweep turns with it). */
  readonly time: number;
  /** An `@key` text's string (the cart's string table). */
  readonly text?: (key: string) => string;
}

/** One piece of light: its distance function's parameters, colour and brightness (`live`: it moves every frame). */
type Shape =
  | { readonly kind: "seg"; readonly s: Segment; readonly half: number; readonly rgb: Rgb; readonly k: number; readonly live?: true }
  | { readonly kind: "arc"; readonly cx: number; readonly cy: number; readonly r: number; readonly a0: number; readonly len: number; readonly half: number; readonly rgb: Rgb; readonly k: number }
  | { readonly kind: "disc"; readonly cx: number; readonly cy: number; readonly r: number; readonly rgb: Rgb; readonly k: number }
  | { readonly kind: "fill"; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly rgb: Rgb; readonly k: number }
  // A sector's wash, brightest at its leading edge (angle a0 + len, clockwise from up) and fading to nothing at a0.
  | { readonly kind: "wedge"; readonly cx: number; readonly cy: number; readonly r: number; readonly a0: number; readonly len: number; readonly rgb: Rgb; readonly k: number; readonly live?: true };

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
/** How far behind a radar's sweep its wake reaches. */
const SWEEP_WAKE = 30 * DEG;

/** A shape's box (for culling), before glow. */
function bounds(sh: Shape): [number, number, number, number] {
  switch (sh.kind) {
    case "seg":
      return [Math.min(sh.s[0], sh.s[2]) - sh.half, Math.min(sh.s[1], sh.s[3]) - sh.half, Math.max(sh.s[0], sh.s[2]) + sh.half, Math.max(sh.s[1], sh.s[3]) + sh.half];
    case "disc":
      return [sh.cx - sh.r, sh.cy - sh.r, sh.cx + sh.r, sh.cy + sh.r];
    case "fill":
      return [sh.x0, sh.y0, sh.x1, sh.y1];
    case "arc":
    case "wedge": {
      // The box round the arc's two ends and every quarter-turn point it passes (and a wedge's centre).
      const at = (t: number) => [sh.cx + Math.sin(t) * sh.r, sh.cy - Math.cos(t) * sh.r] as const;
      const pts = [at(sh.a0), at(sh.a0 + sh.len)];
      if (sh.kind === "wedge") pts.push([sh.cx, sh.cy]);
      for (let q = Math.ceil(sh.a0 / (TAU / 4)) * (TAU / 4); q < sh.a0 + sh.len; q += TAU / 4) pts.push(at(q));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const h = sh.kind === "arc" ? sh.half : 0;
      return [Math.min(...xs) - h, Math.min(...ys) - h, Math.max(...xs) + h, Math.max(...ys) + h];
    }
  }
}

const truthy = (v: unknown) => v !== undefined && v !== null && v !== false && v !== 0 && v !== "";
const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "boolean" ? (v ? 1 : 0) : fallback);

/** A widget's colour: a `tint` binding holding "#rrggbb" (or 0xRRGGBB), else its own rgb, else visor cyan. */
function colourOf(w: UiWidget, bindings: Readonly<Record<string, unknown>>): Rgb {
  const t = w.tint ? bindings[w.tint] : undefined;
  if (typeof t === "string" && /^#[0-9a-f]{6}$/i.test(t)) {
    const n = parseInt(t.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  if (typeof t === "number" && t > 15) return [((t >> 16) & 255) / 255, ((t >> 8) & 255) / 255, (t & 255) / 255];
  return w.rgb ?? HOLO_RGB;
}

/** Text from a widget: `@key` from the string table, `{key}` from the bindings. */
function textOf(w: UiWidget, ctx: HoloContext): string {
  const raw = w.text ?? "";
  const base = raw.startsWith("@") ? (ctx.text?.(raw.slice(1)) ?? raw.slice(1)) : raw;
  return fillUiText(base, ctx.bindings);
}

function rectSegments(x: number, y: number, w: number, h: number): Segment[] {
  return [[x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y]];
}

/** A widget's light, as shapes in screen pixels (before the document's curve). */
export function widgetShapes(p: UiPlaced, ctx: HoloContext): Shape[] {
  const w = p.widget;
  const rgb = colourOf(w, ctx.bindings);
  const line = w.thickness ?? 1.5;
  const seg = (s: Segment, k = 1, half = line / 2, colour = rgb): Shape => ({ kind: "seg", s, half, rgb: colour, k });
  const value = Math.max(0, Math.min(1, num(w.value ? ctx.bindings[w.value] : undefined)));
  const out: Shape[] = [];
  const text = (str: string, x: number, y: number, width: number, height: number, k = 1) => {
    const half = Math.max(0.55, height * 0.07);
    for (const g of layoutStrokeText(str, x, y, width, height, w.align ?? "left")) for (const s of g.segments) out.push(seg(s, k, half));
  };
  const height = w.textSize ?? (w.scale ?? 1) * 6;
  switch (w.kind) {
    case "panel":
      for (const s of rectSegments(p.x, p.y, p.w, p.h)) out.push(seg(s, 0.8));
      if (w.fill !== undefined) out.push({ kind: "fill", x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h, rgb, k: 0.12 });
      break;
    case "button":
      for (const s of rectSegments(p.x, p.y, p.w, p.h)) out.push(seg(s, 0.8));
      text(textOf(w, ctx), p.x, p.y + (p.h - height) / 2, p.w, height);
      break;
    case "text":
      text(textOf(w, ctx), p.x, p.y, p.w, height);
      break;
    case "bar":
    case "slider":
      for (const s of rectSegments(p.x, p.y, p.w, p.h)) out.push(seg(s, 0.6));
      if (value > 0) out.push({ kind: "fill", x0: p.x + 2, y0: p.y + 2, x1: p.x + 2 + (p.w - 4) * value, y1: p.y + p.h - 2, rgb, k: 0.85 });
      break;
    case "list": {
      // A list of texts arrives as one string, a row a line.
      const raw = ctx.bindings[w.value ?? ""];
      const items = typeof raw === "string" ? raw.split("\n") : raw;
      const row = w.row ?? height + 4;
      if (Array.isArray(items)) {
        items.slice(0, Math.max(0, Math.floor(p.h / row))).forEach((item, i) => {
          const str = typeof item === "string" ? item : typeof item === "object" && item && "text" in item ? String((item as { text: unknown }).text) : String(item);
          text(str, p.x, p.y + i * row, p.w, height);
        });
      }
      break;
    }
    case "arc": {
      const cx = p.x + p.w / 2;
      const cy = p.y + p.h / 2;
      const r = Math.min(p.w, p.h) / 2 - line / 2;
      const start = (w.start ?? 0) * DEG;
      const sweep = (w.sweep ?? 360) * DEG;
      const a0 = sweep >= 0 ? start : start + sweep;
      const len = Math.abs(sweep);
      const n = w.segments ?? 1;
      const gap = n > 1 ? Math.min(2 * DEG, len / n / 3) : 0;
      // Each segment: the dim track, and over it the lit share of the value (filling from the start).
      const lit = sweep >= 0 ? [a0, a0 + len * value] : [a0 + len * (1 - value), a0 + len];
      for (let i = 0; i < n; i += 1) {
        const s0 = a0 + (len / n) * i + gap / 2;
        const s1 = a0 + (len / n) * (i + 1) - gap / 2;
        out.push({ kind: "arc", cx, cy, r, a0: s0, len: s1 - s0, half: line / 2, rgb, k: 0.22 });
        const l0 = Math.max(s0, lit[0]!);
        const l1 = Math.min(s1, lit[1]!);
        if (l1 > l0) out.push({ kind: "arc", cx, cy, r, a0: l0, len: l1 - l0, half: line / 2, rgb, k: 1 });
      }
      break;
    }
    case "radar": {
      const cx = p.x + p.w / 2;
      const cy = p.y + p.h / 2;
      const r = Math.min(p.w, p.h) / 2 - line;
      out.push({ kind: "arc", cx, cy, r, a0: 0, len: TAU, half: line / 2, rgb, k: 0.9 });
      out.push({ kind: "arc", cx, cy, r: r / 2, a0: 0, len: TAU, half: line / 3, rgb, k: 0.35 });
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) out.push(seg([cx + dx * r * 0.9, cy + dy * r * 0.9, cx + dx * r, cy + dy * r], 0.6));
      // The sweep, turning: its line, and a fading wash in its wake.
      // It moves in steps (30 a second), so at 60 frames a second every other frame reuses its layer.
      const a = ((Math.floor((ctx.time * RADAR_SWEEP_SPEED) / RADAR_SWEEP_STEP) * RADAR_SWEEP_STEP) % 360) * DEG;
      out.push({ kind: "seg", s: [cx, cy, cx + Math.sin(a) * r, cy - Math.cos(a) * r], half: line / 2, rgb, k: 0.7, live: true });
      out.push({ kind: "wedge", cx, cy, r, a0: a - SWEEP_WAKE, len: SWEEP_WAKE, rgb, k: 0.5, live: true });
      // You, in the middle, facing up.
      out.push(seg([cx - r * 0.06, cy + r * 0.06, cx, cy - r * 0.08], 1), seg([cx, cy - r * 0.08, cx + r * 0.06, cy + r * 0.06], 1));
      // Blips: x, y (−1..1 across the radar, y down) and kind, three numbers each.
      const blips = ctx.bindings[w.value ?? ""];
      if (Array.isArray(blips)) {
        for (let i = 0; i + 2 < blips.length; i += 3) {
          const bx = num(blips[i]), by = num(blips[i + 1]);
          if (bx * bx + by * by > 1) continue;
          out.push({ kind: "disc", cx: cx + bx * r, cy: cy + by * r, r: Math.max(2, r * 0.05), rgb: BLIP_RGB[Math.round(num(blips[i + 2]))] ?? rgb, k: 1 });
        }
      }
      break;
    }
    case "image":
      break;
  }
  return out;
}

/** The pixel a screen point shows of the flat document, curved away toward the edges by `curve`. */
export function holoSource(px: number, py: number, width: number, height: number, curve: number): [number, number] {
  if (curve <= 0) return [px, py];
  const cx = width / 2;
  const cy = height / 2;
  const half = Math.hypot(cx, cy);
  const dx = (px - cx) / half;
  const dy = (py - cy) / half;
  const k = 1 + curve * 0.18 * (dx * dx + dy * dy);
  return [cx + dx * half * k, cy + dy * half * k];
}

/** Where a point of the flat document lands on screen once curved: {@link holoSource}'s inverse. */
export function holoTarget(vx: number, vy: number, width: number, height: number, curve: number): [number, number] {
  if (curve <= 0) return [vx, vy];
  const cx = width / 2;
  const cy = height / 2;
  const half = Math.hypot(cx, cy);
  let [px, py] = [vx, vy];
  for (let i = 0; i < 8; i += 1) {
    const dx = (px - cx) / half;
    const dy = (py - cy) / half;
    const k = 1 + curve * 0.18 * (dx * dx + dy * dy);
    px = cx + (vx - cx) / k;
    py = cy + (vy - cy) / k;
  }
  return [px, py];
}

/**
 * A widget's light rasterised once: over its box, the pixels it touches and,
 * for each, what it does to the frame there — `out = out × mul + add` per
 * channel, so compositing it again costs one multiply-add a touched pixel.
 */
interface HoloLayer {
  readonly key: string;
  readonly pixels: Int32Array;
  readonly mul: Float32Array;
  readonly add: Float32Array;
}

/**
 * Layers kept between frames, by document, widget and part: a widget whose
 * light is unchanged (the same shapes, frame size, curve and glow) is
 * composited from its layer instead of drawn again. Only what moves — a
 * changing number, the radar's sweep — is rasterised each frame.
 */
export interface HoloCache {
  readonly layers: Map<string, HoloLayer>;
}

export function createHoloCache(): HoloCache {
  return { layers: new Map() };
}

/** Shapes flattened to typed arrays, so the hot loop reads one monomorphic layout. */
const KIND_CODE = { seg: 0, arc: 1, disc: 2, fill: 3, wedge: 4 } as const;

interface FlatShapes {
  readonly kind: Uint8Array;
  /** {@link STRIDE} parameters a shape: seg x0 y0 x1 y1 half; arc cx cy r a0 len half and its two ends' x y; disc cx cy r; fill x0 y0 x1 y1; wedge cx cy r a0 len. */
  readonly p: Float64Array;
  readonly k: Float64Array;
  readonly rgb: Float64Array;
}

const STRIDE = 10;

function flatten(shapes: readonly Shape[]): FlatShapes {
  const n = shapes.length;
  const out: FlatShapes = { kind: new Uint8Array(n), p: new Float64Array(n * STRIDE), k: new Float64Array(n), rgb: new Float64Array(n * 3) };
  shapes.forEach((sh, j) => {
    out.kind[j] = KIND_CODE[sh.kind];
    out.k[j] = sh.k;
    out.rgb.set(sh.rgb, j * 3);
    const params =
      sh.kind === "seg" ? [...sh.s, sh.half]
      : sh.kind === "arc"
        ? [sh.cx, sh.cy, sh.r, sh.a0, sh.len, sh.half, sh.cx + Math.sin(sh.a0) * sh.r, sh.cy - Math.cos(sh.a0) * sh.r, sh.cx + Math.sin(sh.a0 + sh.len) * sh.r, sh.cy - Math.cos(sh.a0 + sh.len) * sh.r]
      : sh.kind === "disc" ? [sh.cx, sh.cy, sh.r]
      : sh.kind === "fill" ? [sh.x0, sh.y0, sh.x1, sh.y1]
      : [sh.cx, sh.cy, sh.r, sh.a0, sh.len];
    out.p.set(params, j * STRIDE);
  });
  return out;
}

/** Past this distance from its ring, an arc's distance is taken as the ring's (it is beyond any glow's reach). */
const ARC_EXACT = 64;

/** A vector's length (Math.hypot is several times slower in the hot loop). */
const len2d = (x: number, y: number) => Math.sqrt(x * x + y * y);
/** An angle wrapped to [0, 2π) (Math.floor, not the slower float `%`). */
const turn = (a: number) => a - Math.floor(a / TAU) * TAU;

/** Distance from (px, py) to a flattened shape's edge (negative inside a filled one). */
function flatDistance(f: FlatShapes, j: number, px: number, py: number): number {
  const p = f.p;
  const o = j * STRIDE;
  switch (f.kind[j]) {
    case 0: {
      const ax = p[o]!, ay = p[o + 1]!;
      const dx = p[o + 2]! - ax, dy = p[o + 3]! - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      return len2d(px - (ax + dx * t), py - (ay + dy * t)) - p[o + 4]!;
    }
    case 1: {
      const cx = p[o]!, cy = p[o + 1]!, r = p[o + 2]!, a0 = p[o + 3]!, len = p[o + 4]!;
      const dx = px - cx, dy = py - cy;
      // The distance to the whole ring is never more than to the arc: far from the ring, it is enough.
      const ring = Math.abs(len2d(dx, dy) - r) - p[o + 5]!;
      if (ring >= ARC_EXACT) return ring;
      const a = turn(Math.atan2(dx, -dy) - a0);
      if (a <= len) return ring;
      return Math.min(len2d(px - p[o + 6]!, py - p[o + 7]!), len2d(px - p[o + 8]!, py - p[o + 9]!)) - p[o + 5]!;
    }
    case 2:
    case 4:
      return len2d(px - p[o]!, py - p[o + 1]!) - p[o + 2]!;
    default: {
      const x0 = p[o]!, y0 = p[o + 1]!, x1 = p[o + 2]!, y1 = p[o + 3]!;
      const dx = Math.max(x0 - px, 0, px - x1);
      const dy = Math.max(y0 - py, 0, py - y1);
      return dx > 0 || dy > 0 ? len2d(dx, dy) : -Math.min(px - x0, x1 - px, py - y0, y1 - py);
    }
  }
}

/** The screen box a flat box lands in once curved (its corners and edge midpoints carried in). */
function landedBox(x0: number, y0: number, x1: number, y1: number, width: number, height: number, curve: number): [number, number, number, number] {
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1], [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1], [x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2]].map(([vx, vy]) => holoTarget(vx!, vy!, width, height, curve));
  return [Math.min(x0, ...pts.map((q) => q[0])), Math.min(y0, ...pts.map((q) => q[1])), Math.max(x1, ...pts.map((q) => q[0])), Math.max(y1, ...pts.map((q) => q[1]))];
}

/**
 * Rasterise `shapes` (flat-document pixels) to a layer, curved by `curve`,
 * with the document's glow. Each shape walks only the pixels its light and
 * glow can reach; at each pixel the brightest light wins.
 */
function rasterise(key: string, shapes: readonly Shape[], width: number, height: number, curve: number, glow: number): HoloLayer {
  const glowWidth = 3 + 3 * glow;
  const glowGain = 0.45 * glow;
  const margin = glowWidth * 4;
  const edge = Math.exp(-margin / glowWidth);
  // The glow by distance, tabulated (exp is the hot loop's dearest call).
  const GLOW_STEPS = 256;
  const glowTable = new Float64Array(GLOW_STEPS + 2);
  for (let t = 0; t <= GLOW_STEPS + 1; t += 1) glowTable[t] = Math.max(0, Math.exp(-Math.min(margin, (t / GLOW_STEPS) * margin) / glowWidth) - edge) * glowGain;
  const glowScale = GLOW_STEPS / margin;
  const f = flatten(shapes);
  // Each shape's reach in the flat document: its box grown by its glow (a wash has none, only its edge's anti-aliasing).
  const reach = shapes.map((sh) => {
    const b = bounds(sh);
    const m = sh.kind === "fill" || sh.kind === "wedge" ? 1 : margin;
    return [b[0] - m, b[1] - m, b[2] + m, b[3] + m] as const;
  });
  const screen = reach.map((r) => landedBox(r[0], r[1], r[2], r[3], width, height, curve));
  const sx0 = Math.max(0, Math.floor(Math.min(...screen.map((b) => b[0])) - 1));
  const sy0 = Math.max(0, Math.floor(Math.min(...screen.map((b) => b[1])) - 1));
  const sx1 = Math.min(width - 1, Math.ceil(Math.max(...screen.map((b) => b[2])) + 1));
  const sy1 = Math.min(height - 1, Math.ceil(Math.max(...screen.map((b) => b[3])) + 1));
  if (shapes.length === 0 || sx1 < sx0 || sy1 < sy0) return { key, pixels: new Int32Array(0), mul: new Float32Array(0), add: new Float32Array(0) };
  const bw = sx1 - sx0 + 1;
  const bh = sy1 - sy0 + 1;
  // Each screen pixel's point in the flat document (the curve inverted: holoSource, inlined).
  const vxs = new Float64Array(bw * bh);
  const vys = new Float64Array(bw * bh);
  const ccx = width / 2;
  const ccy = height / 2;
  const half = Math.hypot(ccx, ccy);
  const bend = curve > 0 ? (curve * 0.18) / (half * half) : 0;
  for (let y = 0; y < bh; y += 1) {
    const qy = sy0 + y + 0.5 - ccy;
    for (let x = 0; x < bw; x += 1) {
      const qx = sx0 + x + 0.5 - ccx;
      const k = 1 + bend * (qx * qx + qy * qy);
      vxs[y * bw + x] = ccx + qx * k;
      vys[y * bw + x] = ccy + qy * k;
    }
  }
  const score = new Float32Array(bw * bh);
  const cover = new Float32Array(bw * bh);
  const halo = new Float32Array(bw * bh);
  const line = new Int32Array(bw * bh).fill(-1);
  const fill = new Float32Array(bw * bh);
  const fillBy = new Int32Array(bw * bh).fill(-1);
  for (let j = 0; j < shapes.length; j += 1) {
    const [rx0, ry0, rx1, ry1] = reach[j]!;
    const b = screen[j]!;
    const px0 = Math.max(sx0, Math.floor(b[0])), px1 = Math.min(sx1, Math.ceil(b[2]));
    const py0 = Math.max(sy0, Math.floor(b[1])), py1 = Math.min(sy1, Math.ceil(b[3]));
    const kind = f.kind[j]!;
    const sk = f.k[j]!;
    const wash = kind === 3 || kind === 4;
    for (let y = py0; y <= py1; y += 1) {
      for (let x = px0; x <= px1; x += 1) {
        const i = (y - sy0) * bw + (x - sx0);
        const vx = vxs[i]!, vy = vys[i]!;
        if (vx < rx0 || vx > rx1 || vy < ry0 || vy > ry1) continue;
        const d = flatDistance(f, j, vx, vy);
        if (d >= margin) continue; // beyond its light and its glow
        if (wash) {
          let c = Math.max(0, Math.min(1, 0.5 - d)) * sk;
          if (kind === 4 && c > 0) {
            // A wedge's share by how far behind its leading edge this pixel is.
            const o = j * STRIDE;
            const lead = f.p[o + 3]! + f.p[o + 4]!;
            const behind = turn(lead - Math.atan2(vx - f.p[o]!, f.p[o + 1]! - vy));
            c *= behind <= f.p[o + 4]! ? 1 - behind / f.p[o + 4]! : 0;
          }
          if (c > fill[i]!) { fill[i] = c; fillBy[i] = j; }
          continue;
        }
        // The brightest light here wins: its solid line, or the glow round it.
        const c = Math.max(0, Math.min(1, 0.5 - d)) * Math.min(1, sk);
        // The glow eases to nothing at the margin, so it never ends in a visible edge.
        const u = Math.max(0, d) * glowScale;
        const t0 = Math.floor(u);
        const g = (glowTable[t0]! + (glowTable[t0 + 1]! - glowTable[t0]!) * (u - t0)) * sk;
        if (c + g > score[i]!) {
          score[i] = c + g;
          cover[i] = c;
          halo[i] = g;
          line[i] = j;
        }
      }
    }
  }
  const pixels: number[] = [];
  const mul: number[] = [];
  const add: number[] = [];
  for (let i = 0; i < bw * bh; i += 1) {
    const cv = cover[i]!, h = halo[i]!, fl = fill[i]!;
    if (cv <= 0 && h < 1e-3 && fl <= 0) continue;
    pixels.push((sy0 + Math.floor(i / bw)) * width + sx0 + (i % bw));
    // Fill blended over the frame, the line blended over that, the glow added where the line isn't solid.
    mul.push((1 - fl) * (1 - cv));
    const lo = line[i]! * 3, fo = fillBy[i]! * 3;
    for (let c = 0; c < 3; c += 1) {
      const lc = lo >= 0 ? f.rgb[lo + c]! : 0;
      const fc = fo >= 0 ? f.rgb[fo + c]! : 0;
      add.push(255 * (fc * fl * (1 - cv) + lc * cv + lc * h * (1 - cv)));
    }
  }
  return { key, pixels: Int32Array.from(pixels), mul: Float32Array.from(mul), add: Float32Array.from(add) };
}

function composite(out: Uint8ClampedArray, layer: HoloLayer): void {
  const { pixels, mul, add } = layer;
  for (let i = 0; i < pixels.length; i += 1) {
    const o = pixels[i]! * 4;
    const m = mul[i]!;
    out[o] = out[o]! * m + add[i * 3]!;
    out[o + 1] = out[o + 1]! * m + add[i * 3 + 1]!;
    out[o + 2] = out[o + 2]! * m + add[i * 3 + 2]!;
  }
}

/**
 * Draw a holo document's shown widgets over `out` (RGBA, `width × height`):
 * each one's light alpha-blended where it is solid and its glow added round
 * it. Widgets bound invisible are left out with everything under them. With a
 * `cache`, a widget whose light hasn't changed since it was last drawn is
 * composited from its kept layer; the radar's sweep is kept apart from the
 * rest of the radar, so only the sweep is redrawn as it turns.
 */
export function renderHoloDocument(out: Uint8ClampedArray, width: number, height: number, doc: UiDocument, ctx: HoloContext, cache?: HoloCache): void {
  const placed = layoutUi(doc, width, height);
  const glow = doc.glow ?? 1;
  const curve = doc.curve ?? 0;
  const frame = `${width}x${height}|${curve}|${glow}|`;
  for (let i = 0; i < placed.length; i += 1) {
    const p = placed[i]!;
    if (p.widget.visible && !truthy(ctx.bindings[p.widget.visible])) {
      i += p.descendants;
      continue;
    }
    const shapes = widgetShapes(p, ctx);
    const parts = [shapes.filter((sh) => !("live" in sh)), shapes.filter((sh) => "live" in sh)];
    parts.forEach((part, n) => {
      if (part.length === 0) return;
      const id = `${doc.name}/${i}/${n}`;
      const key = frame + JSON.stringify(part);
      let layer = cache?.layers.get(id);
      if (!layer || layer.key !== key) {
        layer = rasterise(key, part, width, height, curve, glow);
        cache?.layers.set(id, layer);
      }
      composite(out, layer);
    });
  }
}
