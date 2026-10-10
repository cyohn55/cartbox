/**
 * UVs in the editor (LOCKOUT_MULTIPLAYER_ROADMAP.md L17): unwrap a primitive
 * so it can be painted, and see and edit its UV islands.
 *
 * - **Unwrap** projects each face flat along the axis it faces most (±X, ±Y
 *   or ±Z), joins faces that share an edge and face the same way into one
 *   chart (a box's side, a plate's front), and packs the charts into the
 *   unit square at one texel density, a margin apart, so no two overlap and a
 *   brush paints the same size everywhere. Each chart keeps its handedness
 *   (seen from outside, its UVs run the way its triangles wind), so paint
 *   never comes out mirrored. A vertex two charts share is split, carrying
 *   all its other attributes (and its skin weights) to both copies; nothing
 *   moves, so the mesh stays closed and animates as before.
 * - **Islands** are the triangles joined by edges whose UVs agree on both
 *   sides. One can be picked by a point of the UV view, then moved, turned
 *   or scaled there (its vertices split from any other island's first), and
 *   the islands re-packed.
 *
 * UVs here are the stored ones: u across, v up, a texture's top row at
 * v = 1 (the rasteriser samples row (1 − v)·height). Pure and DOM-free.
 */

import type { MeshPrimitive } from "./MeshAsset";
import { primitiveTopology } from "./meshModel";

type Vec2 = [number, number];

/** A primitive rebuilt with new vertices, each a copy of a source vertex with its own UV. */
function rebuild(p: MeshPrimitive, sources: readonly number[], uvs: readonly number[], indices: Uint32Array): MeshPrimitive {
  const n = sources.length;
  const copy = <T extends Float32Array | Uint16Array>(stream: T | null | undefined, width: number, make: (n: number) => T): T | null => {
    if (!stream) return null;
    const out = make(n * width);
    sources.forEach((s, v) => out.set(stream.subarray(s * width, s * width + width), v * width));
    return out;
  };
  const f32 = (k: number) => new Float32Array(k);
  const uvs2 = copy(p.uvs2, 2, f32);
  const blend = copy(p.blend, 1, f32);
  const joints = copy(p.joints, 4, (k) => new Uint16Array(k));
  const weights = copy(p.weights, 4, f32);
  return {
    positions: copy(p.positions, 3, f32)!,
    normals: copy(p.normals, 3, f32),
    uvs: Float32Array.from(uvs),
    indices,
    material: p.material,
    ...(uvs2 ? { uvs2 } : {}),
    ...(blend ? { blend } : {}),
    ...(joints && weights ? { joints, weights } : {}),
  };
}

/** A rectangle to pack, and where it went. */
interface Box {
  readonly w: number;
  readonly h: number;
  x: number;
  y: number;
}

/**
 * Shelf-pack boxes (tallest first) into a square, `gap` apart and from its
 * edges; returns the square's side. Boxes' `x`, `y` are set.
 */
function packBoxes(boxes: Box[], gap: number): number {
  const area = boxes.reduce((s, b) => s + (b.w + gap) * (b.h + gap), 0);
  const widest = Math.max(0, ...boxes.map((b) => b.w + 2 * gap));
  const order = [...boxes].sort((a, b) => b.h - a.h || b.w - a.w);
  let side = Math.max(widest, Math.sqrt(area) * 1.05);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let x = gap, y = gap, shelf = 0;
    let fits = true;
    for (const b of order) {
      if (x + b.w + gap > side + 1e-12 && x > gap) {
        y += shelf + gap;
        x = gap;
        shelf = 0;
      }
      b.x = x;
      b.y = y;
      x += b.w + gap;
      shelf = Math.max(shelf, b.h);
      if (y + b.h + gap > side + 1e-12) fits = false;
    }
    if (fits) return side;
    side *= 1.05;
  }
  return side;
}

/** The (u, v) axes a face facing `normal` is projected onto, so its UVs run the way it winds (u × v = its axis). */
function projectionAxes(normal: readonly number[]): [readonly number[], readonly number[]] {
  const a = [Math.abs(normal[0]!), Math.abs(normal[1]!), Math.abs(normal[2]!)];
  if (a[0]! >= a[1]! && a[0]! >= a[2]!) return normal[0]! > 0 ? [[0, 0, -1], [0, 1, 0]] : [[0, 0, 1], [0, 1, 0]];
  if (a[1]! >= a[2]!) return normal[1]! > 0 ? [[1, 0, 0], [0, 0, -1]] : [[1, 0, 0], [0, 0, 1]];
  return normal[2]! > 0 ? [[1, 0, 0], [0, 1, 0]] : [[-1, 0, 0], [0, 1, 0]];
}

/** Which of the six directions a face faces most (0..5: +X −X +Y −Y +Z −Z). */
function facing(normal: readonly number[]): number {
  const a = [Math.abs(normal[0]!), Math.abs(normal[1]!), Math.abs(normal[2]!)];
  const axis = a[0]! >= a[1]! && a[0]! >= a[2]! ? 0 : a[1]! >= a[2]! ? 1 : 2;
  return axis * 2 + (normal[axis]! > 0 ? 0 : 1);
}

export interface UnwrapOptions {
  /** The gap between charts and around the edge, as a share of the square (default 1/128). */
  readonly margin?: number;
}

/**
 * A primitive's UVs made afresh (any it had are replaced): its faces projected
 * along the axes they face, joined into charts, and packed into the unit square.
 */
export function unwrapPrimitive(p: MeshPrimitive, options: UnwrapOptions = {}): MeshPrimitive {
  const topo = primitiveTopology(p);
  const faces = topo.faces;
  // Charts: faces facing one way, joined across shared edges.
  const parent = Int32Array.from({ length: faces.length }, (_, k) => k);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const dir = faces.map((f) => facing(f.normal));
  for (const e of topo.edges) {
    for (let i = 1; i < e.faces.length; i += 1) {
      const a = e.faces[0]!, b = e.faces[i]!;
      if (dir[a] === dir[b]) parent[find(b)] = find(a);
    }
  }
  const chartOf = Int32Array.from({ length: faces.length }, (_, f) => find(f));
  const charts = [...new Set(chartOf)];
  const chartIndex = new Map(charts.map((c, k) => [c, k]));
  // Project each chart's corners (in world units), and its bounds.
  const triangles = p.indices.length / 3;
  const corner2d = new Float64Array(p.indices.length * 2);
  const lo = charts.map(() => [Infinity, Infinity]), hi = charts.map(() => [-Infinity, -Infinity]);
  for (let t = 0; t < triangles; t += 1) {
    const f = topo.faceOfTriangle[t]!;
    const k = chartIndex.get(chartOf[f]!)!;
    const [ua, va] = projectionAxes(faces[chartOf[f]!]!.normal);
    for (let c = 0; c < 3; c += 1) {
      const v = p.indices[t * 3 + c]!;
      const pos = [p.positions[v * 3]!, p.positions[v * 3 + 1]!, p.positions[v * 3 + 2]!];
      const u = pos[0]! * ua[0]! + pos[1]! * ua[1]! + pos[2]! * ua[2]!;
      const w = pos[0]! * va[0]! + pos[1]! * va[1]! + pos[2]! * va[2]!;
      corner2d[(t * 3 + c) * 2] = u;
      corner2d[(t * 3 + c) * 2 + 1] = w;
      lo[k]![0] = Math.min(lo[k]![0]!, u);
      lo[k]![1] = Math.min(lo[k]![1]!, w);
      hi[k]![0] = Math.max(hi[k]![0]!, u);
      hi[k]![1] = Math.max(hi[k]![1]!, w);
    }
  }
  const boxes: Box[] = charts.map((_, k) => ({ w: Math.max(1e-6, hi[k]![0]! - lo[k]![0]!), h: Math.max(1e-6, hi[k]![1]! - lo[k]![1]!), x: 0, y: 0 }));
  const margin = options.margin ?? 1 / 128;
  // The gap in world units: the margin's share of a square that fits the charts (refined once).
  let gap = margin * Math.sqrt(boxes.reduce((s, b) => s + b.w * b.h, 0)) * 1.2;
  let side = packBoxes(boxes, gap);
  gap = margin * side;
  side = packBoxes(boxes, gap);
  // One vertex per (source vertex, chart): a vertex two charts share is split.
  const key = new Map<string, number>();
  const sources: number[] = [];
  const uvs: number[] = [];
  const indices = new Uint32Array(p.indices.length);
  for (let t = 0; t < triangles; t += 1) {
    const k = chartIndex.get(chartOf[topo.faceOfTriangle[t]!]!)!;
    for (let c = 0; c < 3; c += 1) {
      const v = p.indices[t * 3 + c]!;
      const id = `${v}:${k}`;
      let out = key.get(id);
      if (out === undefined) {
        out = sources.length;
        key.set(id, out);
        sources.push(v);
        const b = boxes[k]!;
        uvs.push((b.x + corner2d[(t * 3 + c) * 2]! - lo[k]![0]!) / side, (b.y + corner2d[(t * 3 + c) * 2 + 1]! - lo[k]![1]!) / side);
      }
      indices[t * 3 + c] = out;
    }
  }
  return rebuild(p, sources, uvs, indices);
}

// --- Islands -----------------------------------------------------------------------

export interface UvIsland {
  readonly triangles: readonly number[];
  readonly min: Vec2;
  readonly max: Vec2;
}

/** The UV islands of a primitive: triangles joined by edges whose UVs agree on both sides. */
export function uvIslands(p: MeshPrimitive): UvIsland[] {
  if (!p.uvs) return [];
  const topo = primitiveTopology(p);
  const uv = p.uvs;
  // A corner's identity: its weld and its UV.
  const id = (v: number) => `${topo.weldOf[v]}:${Math.round(uv[v * 2]! * 1e6)},${Math.round(uv[v * 2 + 1]! * 1e6)}`;
  const triangles = p.indices.length / 3;
  const parent = Int32Array.from({ length: triangles }, (_, k) => k);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const byEdge = new Map<string, number>();
  for (let t = 0; t < triangles; t += 1) {
    const ids = [0, 1, 2].map((c) => id(p.indices[t * 3 + c]!));
    for (let c = 0; c < 3; c += 1) {
      const a = ids[c]!, b = ids[(c + 1) % 3]!;
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      const other = byEdge.get(k);
      if (other === undefined) byEdge.set(k, t);
      else parent[find(t)] = find(other);
    }
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < triangles; t += 1) {
    const r = find(t);
    const list = groups.get(r);
    if (list) list.push(t);
    else groups.set(r, [t]);
  }
  return [...groups.values()].map((tris) => {
    const min: Vec2 = [Infinity, Infinity], max: Vec2 = [-Infinity, -Infinity];
    for (const t of tris) {
      for (let c = 0; c < 3; c += 1) {
        const v = p.indices[t * 3 + c]!;
        min[0] = Math.min(min[0], uv[v * 2]!);
        min[1] = Math.min(min[1], uv[v * 2 + 1]!);
        max[0] = Math.max(max[0], uv[v * 2]!);
        max[1] = Math.max(max[1], uv[v * 2 + 1]!);
      }
    }
    return { triangles: tris, min, max };
  });
}

/** The island whose triangles cover a point of the UV square, or −1. */
export function pickIsland(p: MeshPrimitive, islands: readonly UvIsland[], uv: readonly [number, number]): number {
  if (!p.uvs) return -1;
  const at = (v: number): Vec2 => [p.uvs![v * 2]!, p.uvs![v * 2 + 1]!];
  for (let k = 0; k < islands.length; k += 1) {
    const island = islands[k]!;
    if (uv[0] < island.min[0] || uv[0] > island.max[0] || uv[1] < island.min[1] || uv[1] > island.max[1]) continue;
    for (const t of island.triangles) {
      const [a, b, c] = [0, 1, 2].map((i) => at(p.indices[t * 3 + i]!)) as [Vec2, Vec2, Vec2];
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(d) < 1e-14) continue;
      const l1 = ((b[1] - c[1]) * (uv[0] - c[0]) + (c[0] - b[0]) * (uv[1] - c[1])) / d;
      const l2 = ((c[1] - a[1]) * (uv[0] - c[0]) + (a[0] - c[0]) * (uv[1] - c[1])) / d;
      if (l1 >= -1e-9 && l2 >= -1e-9 && 1 - l1 - l2 >= -1e-9) return k;
    }
  }
  return -1;
}

export type IslandTransform =
  | { readonly kind: "move"; readonly offset: readonly [number, number] }
  | { readonly kind: "rotate"; readonly angle: number }
  | { readonly kind: "scale"; readonly factor: number };

/**
 * One island's UVs moved, turned or scaled (about its centre). Its vertices
 * are split first from any triangle outside it, so nothing else moves.
 */
export function transformIsland(p: MeshPrimitive, island: UvIsland, transform: IslandTransform): MeshPrimitive {
  if (!p.uvs) return p;
  const inside = new Set(island.triangles);
  const used = new Set<number>();
  for (const t of island.triangles) for (let c = 0; c < 3; c += 1) used.add(p.indices[t * 3 + c]!);
  const shared = new Set<number>();
  for (let t = 0; t < p.indices.length / 3; t += 1) if (!inside.has(t)) for (let c = 0; c < 3; c += 1) if (used.has(p.indices[t * 3 + c]!)) shared.add(p.indices[t * 3 + c]!);
  const vertexCount = p.positions.length / 3;
  const sources = Array.from({ length: vertexCount }, (_, v) => v);
  const uvs = Array.from(p.uvs);
  const indices = p.indices.slice();
  const copyOf = new Map<number, number>();
  for (const t of island.triangles) {
    for (let c = 0; c < 3; c += 1) {
      const v = p.indices[t * 3 + c]!;
      if (!shared.has(v)) continue;
      let copy = copyOf.get(v);
      if (copy === undefined) {
        copy = sources.length;
        sources.push(v);
        uvs.push(p.uvs[v * 2]!, p.uvs[v * 2 + 1]!);
        copyOf.set(v, copy);
      }
      indices[t * 3 + c] = copy;
    }
  }
  const mine = new Set<number>();
  for (const t of island.triangles) for (let c = 0; c < 3; c += 1) mine.add(indices[t * 3 + c]!);
  const cu = (island.min[0] + island.max[0]) / 2, cv = (island.min[1] + island.max[1]) / 2;
  const cos = transform.kind === "rotate" ? Math.cos(transform.angle) : 1, sin = transform.kind === "rotate" ? Math.sin(transform.angle) : 0;
  for (const v of mine) {
    const u = uvs[v * 2]!, w = uvs[v * 2 + 1]!;
    if (transform.kind === "move") {
      uvs[v * 2] = u + transform.offset[0];
      uvs[v * 2 + 1] = w + transform.offset[1];
    } else if (transform.kind === "scale") {
      uvs[v * 2] = cu + (u - cu) * transform.factor;
      uvs[v * 2 + 1] = cv + (w - cv) * transform.factor;
    } else {
      uvs[v * 2] = cu + (u - cu) * cos - (w - cv) * sin;
      uvs[v * 2 + 1] = cv + (u - cu) * sin + (w - cv) * cos;
    }
  }
  return rebuild(p, sources, uvs, indices);
}

/** The islands re-packed into the unit square, each keeping its size relative to the others. */
export function packIslands(p: MeshPrimitive, margin = 1 / 128): MeshPrimitive {
  if (!p.uvs) return p;
  const islands = uvIslands(p);
  // Split any vertex two islands share, so each moves on its own.
  let q = p;
  for (const island of islands) q = transformIsland(q, island, { kind: "move", offset: [0, 0] });
  const again = uvIslands(q);
  const boxes: Box[] = again.map((i) => ({ w: Math.max(1e-6, i.max[0] - i.min[0]), h: Math.max(1e-6, i.max[1] - i.min[1]), x: 0, y: 0 }));
  const area = Math.sqrt(boxes.reduce((s, b) => s + b.w * b.h, 0));
  let side = packBoxes(boxes, margin * area * 1.2);
  side = packBoxes(boxes, margin * side);
  const uvs = Float32Array.from(q.uvs!);
  again.forEach((island, k) => {
    const b = boxes[k]!;
    const vs = new Set(island.triangles.flatMap((t) => [0, 1, 2].map((c) => q.indices[t * 3 + c]!)));
    for (const v of vs) {
      uvs[v * 2] = (b.x + q.uvs![v * 2]! - island.min[0]) / side;
      uvs[v * 2 + 1] = (b.y + q.uvs![v * 2 + 1]! - island.min[1]) / side;
    }
  });
  return { ...q, uvs };
}
