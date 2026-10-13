/**
 * Splines (EDITOR_PRO_ROADMAP.md P3), after Unreal's Landscape and Water
 * splines and Unity's Spline package: a smooth curve through points the
 * creator places, each with its own width, that shapes the world along it.
 *
 * - A **river** carves its bed and banks into a terrain, lays a water surface
 *   whose ripples flow along its course (round every bend), a line of foam
 *   where it meets its banks, and can paint the banks wet.
 * - A **path** levels the ground along it and paints a terrain layer.
 * - A **wall** (fence, ledge, kerb) bends a mesh along it, repeated end to end.
 *
 * The curve is a centripetal Catmull–Rom spline (no cusps or loops however
 * unevenly the points are spaced), sampled by arc length. Points are in world
 * space. Everything here is pure and DOM-free; each operation returns new
 * data, so each is an undo step.
 */

import { bakeTerrainPaint } from "./terrainBrush";
import type { Terrain } from "./terrain";
import type { EncodedImage, MeshAsset, MeshMaterial, MeshPrimitive } from "./MeshAsset";
import { valueNoise } from "./materialGraph";
import { encodeRgbaPng } from "./png";

export type SplineKind = "river" | "path" | "wall";

export interface SplinePoint {
  /** World position: for a river, its water surface here; for a path, the ground's height. */
  readonly p: readonly [number, number, number];
  /** Width here (world units): a river's water, a path's tread, a wall's thickness scale. */
  readonly width: number;
}

export interface Spline {
  readonly id: string;
  readonly name: string;
  readonly kind: SplineKind;
  readonly points: readonly SplinePoint[];
  /** The terrain (by id) a river carves or a path levels. */
  readonly terrain?: string;
  /** River: how far the bed lies below the water (default 1). */
  readonly depth?: number;
  /** River and path: how far the banks or shoulders reach beyond the width, each side (default half the width). */
  readonly bank?: number;
  /** River: the terrain layer its banks are painted (wet mud), or absent. Path: the layer its tread is painted. */
  readonly layer?: number;
  /** Wall: the scene object (by id) whose mesh is bent along the spline. */
  readonly mesh?: string;
}

export const MAX_SPLINE_POINTS = 256;

// --- The curve ---------------------------------------------------------------------------

type V3 = [number, number, number];

const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const len = (a: readonly number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!);

/**
 * A point on the centripetal Catmull–Rom segment from p1 to p2 (Barry and
 * Goldman's pyramid), `t` 0..1, with the neighbours p0 and p3 shaping it.
 */
function catmullRom(p0: readonly number[], p1: readonly number[], p2: readonly number[], p3: readonly number[], t: number): V3 {
  const knot = (a: readonly number[], b: readonly number[]) => Math.max(1e-6, Math.sqrt(len(sub(b, a))));
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const lerp = (a: readonly number[], b: readonly number[], ta: number, tb: number): V3 => {
    const w = (u - ta) / (tb - ta);
    return [a[0]! + (b[0]! - a[0]!) * w, a[1]! + (b[1]! - a[1]!) * w, a[2]! + (b[2]! - a[2]!) * w];
  };
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

/** One arc-length sample of a spline. */
export interface SplineSample {
  readonly p: V3;
  /** The horizontal direction of travel (unit, y = 0). */
  readonly tangent: V3;
  /** The horizontal direction to the right of travel (unit, y = 0): tangent × up. */
  readonly right: V3;
  readonly width: number;
  /** Distance along the spline from its first point. */
  readonly s: number;
}

/**
 * The spline sampled about every `step` world units along its length (exactly
 * through both ends), widths eased between points. Fewer than two points: none.
 */
export function sampleSpline(spline: Pick<Spline, "points">, step = 0.5): SplineSample[] {
  const pts = spline.points;
  if (pts.length < 2) return [];
  // A dense polyline first, then resampled evenly by arc length.
  const dense: { p: V3; w: number }[] = [];
  const at = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))]!;
  const ghost = (i: number): readonly number[] => {
    // Past an end, mirror the neighbour (keeps the end's direction).
    if (i < 0) return sub([2 * pts[0]!.p[0], 2 * pts[0]!.p[1], 2 * pts[0]!.p[2]], pts[1]!.p);
    if (i >= pts.length) {
      const n = pts.length;
      return sub([2 * pts[n - 1]!.p[0], 2 * pts[n - 1]!.p[1], 2 * pts[n - 1]!.p[2]], pts[n - 2]!.p);
    }
    return pts[i]!.p;
  };
  const per = 24;
  for (let i = 0; i < pts.length - 1; i += 1) {
    for (let k = 0; k < per; k += 1) {
      const t = k / per;
      const e = t * t * (3 - 2 * t);
      dense.push({ p: catmullRom(ghost(i - 1), at(i).p, at(i + 1).p, ghost(i + 2), t), w: at(i).width + (at(i + 1).width - at(i).width) * e });
    }
  }
  dense.push({ p: [...pts[pts.length - 1]!.p] as V3, w: pts[pts.length - 1]!.width });
  const cumulative = [0];
  for (let i = 1; i < dense.length; i += 1) cumulative.push(cumulative[i - 1]! + len(sub(dense[i]!.p, dense[i - 1]!.p)));
  const total = cumulative[cumulative.length - 1]!;
  if (!(total > 0)) return [];
  const count = Math.max(1, Math.round(total / Math.max(1e-3, step)));
  const out: SplineSample[] = [];
  let j = 0;
  for (let k = 0; k <= count; k += 1) {
    const s = (k / count) * total;
    while (j < dense.length - 2 && cumulative[j + 1]! < s) j += 1;
    const span = cumulative[j + 1]! - cumulative[j]!;
    const f = span > 0 ? (s - cumulative[j]!) / span : 0;
    const a = dense[j]!, b = dense[j + 1]!;
    const p: V3 = [a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f, a.p[2] + (b.p[2] - a.p[2]) * f];
    const dx = b.p[0] - a.p[0], dz = b.p[2] - a.p[2];
    const dl = Math.hypot(dx, dz) || 1;
    const tangent: V3 = [dx / dl, 0, dz / dl];
    out.push({ p, tangent, right: [-tangent[2], 0, tangent[0]], width: a.w + (b.w - a.w) * f, s });
  }
  // Smooth each tangent with its neighbours', so a frame doesn't jump at a dense vertex.
  return out.map((sample, i) => {
    const prev = out[Math.max(0, i - 1)]!.p, next = out[Math.min(out.length - 1, i + 1)]!.p;
    const dx = next[0] - prev[0], dz = next[2] - prev[2];
    const dl = Math.hypot(dx, dz);
    if (!(dl > 0)) return sample;
    const tangent: V3 = [dx / dl, 0, dz / dl];
    return { ...sample, tangent, right: [-tangent[2], 0, tangent[0]] };
  });
}

/** The nearest point of a sampled spline to world (x, z): how far along, how far to the side (signed, + right), and its height and width there. */
export function nearestOnSpline(samples: readonly SplineSample[], x: number, z: number): { s: number; side: number; y: number; width: number } | null {
  if (samples.length < 2) return null;
  let best = Infinity;
  let out: { s: number; side: number; y: number; width: number } | null = null;
  for (let i = 0; i < samples.length - 1; i += 1) {
    const a = samples[i]!, b = samples[i + 1]!;
    const ax = b.p[0] - a.p[0], az = b.p[2] - a.p[2];
    const l2 = ax * ax + az * az;
    const f = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.p[0]) * ax + (z - a.p[2]) * az) / l2)) : 0;
    const px = a.p[0] + ax * f, pz = a.p[2] + az * f;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      // Signed by which side of the travel direction the point lies.
      const cross = ax * (z - a.p[2]) - az * (x - a.p[0]);
      out = { s: a.s + (b.s - a.s) * f, side: cross >= 0 ? d : -d, y: a.p[1] + (b.p[1] - a.p[1]) * f, width: a.width + (b.width - a.width) * f };
    }
  }
  return out;
}

const smooth = (x: number): number => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/** The world bounds a spline's samples reach, padded by `pad`: [minX, minZ, maxX, maxZ]. */
function reachOf(samples: readonly SplineSample[], pad: number): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const { p, width } of samples) {
    const r = width / 2 + pad;
    x0 = Math.min(x0, p[0] - r);
    z0 = Math.min(z0, p[2] - r);
    x1 = Math.max(x1, p[0] + r);
    z1 = Math.max(z1, p[2] + r);
  }
  return [x0, z0, x1, z1];
}

/** Visit every terrain sample within a spline's reach, with its world position and the nearest point of the spline. */
function alongTerrain(t: Terrain, samples: readonly SplineSample[], pad: number, visit: (k: number, i: number, j: number, near: { s: number; side: number; y: number; width: number }) => void): void {
  const n = t.samples;
  const dx = t.size[0] / (n - 1), dz = t.size[1] / (n - 1);
  const [x0, z0, x1, z1] = reachOf(samples, pad);
  const i0 = Math.max(0, Math.floor((x0 - t.origin[0]) / dx)), i1 = Math.min(n - 1, Math.ceil((x1 - t.origin[0]) / dx));
  const j0 = Math.max(0, Math.floor((z0 - t.origin[2]) / dz)), j1 = Math.min(n - 1, Math.ceil((z1 - t.origin[2]) / dz));
  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      const near = nearestOnSpline(samples, t.origin[0] + i * dx, t.origin[2] + j * dz);
      if (near) visit(j * n + i, i, j, near);
    }
  }
}

/** Raise one layer's paint weight at a sample toward `w` (0..1), taking it from the others. */
function paintSample(paint: Uint8Array, layers: number, k: number, layer: number, w: number): void {
  if (w <= 0) return;
  const o = k * layers;
  for (let l = 0; l < layers; l += 1) {
    const target = l === layer ? 255 : 0;
    paint[o + l] = Math.round(paint[o + l]! + (target - paint[o + l]!) * Math.min(1, w));
  }
}

// --- Rivers ------------------------------------------------------------------------------

/** The bed's floor is flat across this share of the half width, then rises to the water's edge. */
const BED_FLAT = 0.5;
/** The water's edge sits this far above the water, so the banks hold it. */
const EDGE_RISE = 0.05;

/** A river's cross-section at side distance `d` from its centre line: the ground's height relative to the water there. */
export function riverProfile(d: number, width: number, depth: number): number {
  const half = width / 2;
  const a = Math.abs(d);
  if (a <= half * BED_FLAT) return -depth;
  if (a <= half) return -depth + (depth + EDGE_RISE) * smooth((a - half * BED_FLAT) / (half * (1 - BED_FLAT)));
  return EDGE_RISE;
}

/**
 * Carve a river into the terrain it names: across its width the ground takes
 * the river's cross-section below the water (a flat bed rising to the water's
 * edge); across its banks it eases from the edge back to the ground as it was
 * (lowering high ground, building up low ground, so the water is held). With
 * a `layer`, the banks are painted with it, fading out across them.
 */
export function carveRiver(t: Terrain, spline: Spline): Terrain {
  const samples = sampleSpline(spline, Math.min(1, t.size[0] / (t.samples - 1)));
  if (samples.length < 2) return t;
  const depth = spline.depth ?? 1;
  const bank = (w: number) => spline.bank ?? w / 2;
  const heights = Float32Array.from(t.heights);
  const layer = spline.layer !== undefined && spline.layer >= 0 && spline.layer < t.layers.length ? spline.layer : -1;
  const paint = layer >= 0 ? Uint8Array.from(t.paint ?? bakeTerrainPaint(t)) : null;
  const maxBank = Math.max(...samples.map((s) => bank(s.width)));
  alongTerrain(t, samples, maxBank, (k, _i, _j, near) => {
    const half = near.width / 2;
    const d = Math.abs(near.side);
    const water = near.y - t.origin[1];
    const b = bank(near.width);
    if (d <= half) heights[k] = water + riverProfile(d, near.width, depth);
    else if (d <= half + b) {
      const f = smooth((d - half) / b);
      heights[k] = water + EDGE_RISE + (t.heights[k]! - water - EDGE_RISE) * f;
    }
    if (paint && d <= half + b) paintSample(paint, t.layers.length, k, layer, 1 - smooth((d - half * 0.8) / (b + half * 0.2)));
  });
  return { ...t, heights, ...(paint ? { paint } : {}) };
}

/** How far the water surface reaches past the river's width each side, under its banks, so no gap shows at the edge. */
const SURFACE_OVERLAP = 0.25;
/** How far into a bend's inside a strip may reach, as a share of the bend's radius. */
const INNER_REACH = 0.85;
/** The foam line's width (world units) along each edge. */
const FOAM_WIDTH = 0.6;

/**
 * A river's water surface: a ribbon at the water's height, a little wider than
 * the river, its UVs in metres — U across (0 at the centre line), V along — so
 * the water's ripples, flowing along V, follow the river round every bend.
 */
export function riverSurface(spline: Spline, material: MeshMaterial): MeshPrimitive | null {
  return ribbon(sampleSpline(spline, 0.5), (s) => [-(s.width / 2 + SURFACE_OVERLAP), s.width / 2 + SURFACE_OVERLAP], 0, material, "metres");
}

/**
 * A river's foam: a strip along each edge where the water meets its banks,
 * just above the water. Its UVs are in metres too (U across the strip from 0
 * at the water's side to 1 at the bank, V along), for a foam texture whose
 * alpha thins toward open water.
 */
export function riverFoam(spline: Spline, material: MeshMaterial): MeshPrimitive | null {
  const samples = sampleSpline(spline, 0.5);
  const left = ribbon(samples, (s) => [-(s.width / 2), -(s.width / 2) + FOAM_WIDTH], 0.01, material, "inward");
  const right = ribbon(samples, (s) => [s.width / 2 - FOAM_WIDTH, s.width / 2], 0.01, material, "outward");
  if (!left || !right) return null;
  return mergePrimitives(left, right);
}

/**
 * A strip along the samples between two side offsets (left negative), `lift`
 * above them. U is the side offset in metres, or 0..1 across the strip rising
 * toward its `outward` (right) or `inward` (left) edge; V is metres along.
 */
function ribbon(samples: readonly SplineSample[], span: (s: SplineSample) => [number, number], lift: number, material: MeshMaterial, u: "metres" | "outward" | "inward"): MeshPrimitive | null {
  if (samples.length < 2) return null;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  samples.forEach((s, i) => {
    const [a, b] = span(s);
    // On the inside of a bend tighter than the strip is wide, the inner edge
    // would fold back on itself: hold it within the bend's radius.
    const turnAt = (k: number): number => {
      const prev = samples[Math.max(0, k - 1)]!, next = samples[Math.min(samples.length - 1, k + 1)]!;
      return next.s > prev.s ? (prev.tangent[0] * next.tangent[2] - prev.tangent[2] * next.tangent[0]) / (next.s - prev.s) : 0;
    };
    // The sharpest turn nearby, so a neighbour's tighter bend is held too.
    let turn = turnAt(i);
    for (let k = Math.max(0, i - 2); k <= Math.min(samples.length - 1, i + 2); k += 1) if (Math.abs(turnAt(k)) > Math.abs(turn)) turn = turnAt(k);
    const reach = Math.abs(turn) > 1e-9 ? INNER_REACH / Math.abs(turn) : Infinity;
    for (const want of [a, b]) {
      const side = want * turn > 0 ? Math.sign(want) * Math.min(Math.abs(want), reach) : want;
      positions.push(s.p[0] + s.right[0] * side, s.p[1] + lift, s.p[2] + s.right[2] * side);
      const across = b - a || 1;
      // UVs by where the edge was meant to be, so only the geometry is squeezed.
      uvs.push(u === "metres" ? want : u === "outward" ? (want - a) / across : (b - want) / across, s.s);
    }
  });
  for (let k = 0; k < samples.length - 1; k += 1) {
    const o = k * 2;
    // Counter-clockwise seen from above (left edge at o, right at o + 1).
    indices.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  }
  const count = positions.length / 3;
  const normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v += 1) normals[v * 3 + 1] = 1;
  return { positions: Float32Array.from(positions), normals, uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material };
}

function mergePrimitives(a: MeshPrimitive, b: MeshPrimitive): MeshPrimitive {
  const offset = a.positions.length / 3;
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices);
  for (let i = 0; i < b.indices.length; i += 1) indices[a.indices.length + i] = b.indices[i]! + offset;
  const join = (x: Float32Array, y: Float32Array) => {
    const out = new Float32Array(x.length + y.length);
    out.set(x);
    out.set(y, x.length);
    return out;
  };
  return { positions: join(a.positions, b.positions), normals: join(a.normals!, b.normals!), uvs: join(a.uvs!, b.uvs!), indices, material: a.material };
}

// --- Paths -------------------------------------------------------------------------------

/**
 * Lay a path: across its width the ground eases to the spline's height (its
 * points' heights, smoothly between), the shoulders blending back to the
 * ground as it was; with a `layer`, the tread is painted with it.
 */
export function layPath(t: Terrain, spline: Spline): Terrain {
  const samples = sampleSpline(spline, Math.min(1, t.size[0] / (t.samples - 1)));
  if (samples.length < 2) return t;
  const heights = Float32Array.from(t.heights);
  const layer = spline.layer !== undefined && spline.layer >= 0 && spline.layer < t.layers.length ? spline.layer : -1;
  const paint = layer >= 0 ? Uint8Array.from(t.paint ?? bakeTerrainPaint(t)) : null;
  const shoulder = (w: number) => Math.max(1e-3, spline.bank ?? w / 2);
  const maxShoulder = Math.max(...samples.map((s) => shoulder(s.width)));
  alongTerrain(t, samples, maxShoulder, (k, _i, _j, near) => {
    const half = near.width / 2;
    const d = Math.abs(near.side);
    const w = d <= half ? 1 : 1 - smooth((d - half) / shoulder(near.width));
    if (w <= 0) return;
    const level = near.y - t.origin[1];
    heights[k] = t.heights[k]! + (level - t.heights[k]!) * w;
    if (paint) paintSample(paint, t.layers.length, k, layer, d <= half ? 1 : w * 0.6);
  });
  return { ...t, heights, ...(paint ? { paint } : {}) };
}

// --- Spline meshes -----------------------------------------------------------------------

/**
 * A mesh bent along the spline (Unreal's Spline Mesh): repeated end to end,
 * its own +X running along the curve, +Z to the right, +Y up, each copy
 * stretched a little so a whole number of them spans the spline exactly. Its
 * Z (sideways) is scaled by the spline's width there over `baseWidth`.
 */
export function splineMesh(spline: Spline, source: MeshAsset, options: { readonly baseWidth?: number } = {}): MeshAsset | null {
  const samples = sampleSpline(spline, 0.25);
  if (samples.length < 2) return null;
  let minX = Infinity, maxX = -Infinity;
  for (const p of source.primitives) for (let v = 0; v < p.positions.length; v += 3) {
    minX = Math.min(minX, p.positions[v]!);
    maxX = Math.max(maxX, p.positions[v]!);
  }
  const unit = maxX - minX;
  if (!(unit > 0)) return null;
  const total = samples[samples.length - 1]!.s;
  const copies = Math.max(1, Math.round(total / unit));
  const stretch = total / (copies * unit);
  const baseWidth = options.baseWidth ?? 1;
  // The frame at distance s, by linear interpolation between samples.
  const frame = (s: number) => {
    const step = total / (samples.length - 1);
    const f = Math.max(0, Math.min(samples.length - 1 - 1e-9, s / step));
    const i = Math.floor(f), w = f - i;
    const a = samples[i]!, b = samples[Math.min(samples.length - 1, i + 1)]!;
    const mix = (x: readonly number[], y: readonly number[]): V3 => [x[0]! + (y[0]! - x[0]!) * w, x[1]! + (y[1]! - x[1]!) * w, x[2]! + (y[2]! - x[2]!) * w];
    const t = mix(a.tangent, b.tangent);
    const tl = Math.hypot(t[0], t[2]) || 1;
    const tangent: V3 = [t[0] / tl, 0, t[2] / tl];
    return { p: mix(a.p, b.p), tangent, right: [-tangent[2], 0, tangent[0]] as V3, width: a.width + (b.width - a.width) * w };
  };
  const primitives = source.primitives.map((p): MeshPrimitive => {
    const vertices = p.positions.length / 3;
    const positions = new Float32Array(vertices * 3 * copies);
    const normals = p.normals ? new Float32Array(vertices * 3 * copies) : null;
    const uvs = p.uvs ? new Float32Array(vertices * 2 * copies) : null;
    const indices = new Uint32Array(p.indices.length * copies);
    for (let c = 0; c < copies; c += 1) {
      for (let v = 0; v < vertices; v += 1) {
        const x = p.positions[v * 3]!, y = p.positions[v * 3 + 1]!, z = p.positions[v * 3 + 2]!;
        const f = frame((c * unit + (x - minX)) * stretch);
        const sz = z * (f.width / baseWidth);
        const o = (c * vertices + v) * 3;
        positions[o] = f.p[0] + f.right[0] * sz;
        positions[o + 1] = f.p[1] + y;
        positions[o + 2] = f.p[2] + f.right[2] * sz;
        if (normals && p.normals) {
          // The normal turned into the frame (X along, Z right, Y up).
          const nx = p.normals[v * 3]!, ny = p.normals[v * 3 + 1]!, nz = p.normals[v * 3 + 2]!;
          const wx = f.tangent[0] * nx + f.right[0] * nz, wz = f.tangent[2] * nx + f.right[2] * nz;
          const nl = Math.hypot(wx, ny, wz) || 1;
          normals[o] = wx / nl;
          normals[o + 1] = ny / nl;
          normals[o + 2] = wz / nl;
        }
        if (uvs && p.uvs) {
          uvs[(c * vertices + v) * 2] = p.uvs[v * 2]!;
          uvs[(c * vertices + v) * 2 + 1] = p.uvs[v * 2 + 1]!;
        }
      }
      for (let i = 0; i < p.indices.length; i += 1) indices[c * p.indices.length + i] = p.indices[i]! + c * vertices;
    }
    // (+X, +Y, +Z) → (tangent, up, right) is a rotation (right = tangent × up), so the winding holds.
    return { positions, normals, uvs, indices, material: p.material };
  });
  return { name: `${source.name} along ${spline.name}`, primitives };
}

// --- Storage -----------------------------------------------------------------------------

const KINDS: ReadonlySet<string> = new Set(["river", "path", "wall"]);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Read stored splines defensively: malformed points and splines dropped, numbers clamped. */
export function readSplines(value: unknown): Spline[] {
  if (!Array.isArray(value)) return [];
  const out: Spline[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 256)) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id || seen.has(r.id) || typeof r.kind !== "string" || !KINDS.has(r.kind) || !Array.isArray(r.points)) continue;
    const points: SplinePoint[] = [];
    for (const q of r.points.slice(0, MAX_SPLINE_POINTS)) {
      const pt = (q ?? {}) as { p?: unknown; width?: unknown };
      if (!Array.isArray(pt.p) || pt.p.length !== 3 || !pt.p.every(finite) || !finite(pt.width)) continue;
      points.push({ p: [pt.p[0] as number, pt.p[1] as number, pt.p[2] as number], width: Math.max(0.1, Math.min(200, pt.width)) });
    }
    seen.add(r.id);
    out.push({
      id: r.id,
      name: typeof r.name === "string" ? r.name.slice(0, 64) : r.kind,
      kind: r.kind as SplineKind,
      points,
      ...(typeof r.terrain === "string" && r.terrain ? { terrain: r.terrain } : {}),
      ...(finite(r.depth) ? { depth: Math.max(0, Math.min(50, r.depth)) } : {}),
      ...(finite(r.bank) ? { bank: Math.max(0, Math.min(200, r.bank)) } : {}),
      ...(finite(r.layer) && r.layer >= 0 ? { layer: Math.floor(r.layer) } : {}),
      ...(typeof r.mesh === "string" && r.mesh ? { mesh: r.mesh } : {}),
    });
  }
  return out;
}

// --- Default river materials -------------------------------------------------------------

/** A river's water: clear, glossy and refracting, its ripples flowing down the course (along V). */
export function riverWaterMaterial(): MeshMaterial {
  return {
    name: "river-water",
    baseColorFactor: [0.16, 0.3, 0.34, 0.55],
    baseColorImage: null,
    metallicFactor: 0,
    roughnessFactor: 0.06,
    alphaMode: "blend",
    reflectivity: 1.3,
    refraction: 0.3,
    softDepth: 0.35,
    water: { strength: 0.35, scale: 1.2, speed: 0.7, flow: Math.PI / 2, along: true },
  };
}

let foam: EncodedImage | null = null;

/**
 * The foam line's texture: white, its alpha broken into tileable blotches
 * that thicken toward U = 1 (the bank) and thin out toward open water. One
 * shared image, so every river's foam stores it once.
 */
export function foamTexture(): EncodedImage {
  if (foam) return foam;
  const n = 64;
  const rgba = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      // Tileable along V (y): each noise crossfaded with itself one period on, so row n meets row 0.
      const f = y / n;
      const field = (yy: number) => valueNoise(x / 6, (yy / n) * 8, 3, 2) * 0.6 + valueNoise(x / 2.5, (yy / n) * 21, 11, 1) * 0.4;
      const blotch = field(y) * (1 - f) + field(y - n) * f;
      const edge = x / (n - 1);
      const a = Math.max(0, Math.min(1, (blotch - 0.55 + edge * 0.75) * 2.2)) * Math.min(1, edge * 1.6);
      rgba.set([245, 250, 250, Math.round(a * 255)], (y * n + x) * 4);
    }
  }
  foam = { mime: "image/png", bytes: encodeRgbaPng(rgba, n, n, { compress: true }) };
  return foam;
}

/** A river's foam: white, see-through where its texture thins, rough. */
export function riverFoamMaterial(): MeshMaterial {
  return { name: "river-foam", baseColorFactor: [1, 1, 1, 0.85], baseColorImage: foamTexture(), metallicFactor: 0, roughnessFactor: 0.9, alphaMode: "blend" };
}
