/**
 * An angle-preserving unwrap (AAA_PRODUCTION_ROADMAP.md D2): least-squares
 * conformal maps (Lévy, Petitjean, Ray and Maillot, 2002) over charts cut at
 * seams, so a character, a creature or a curved panel lays flat with its
 * angles kept, where uvUnwrap.ts's box projection only suits flat-faced parts.
 *
 * - **Seams** are the edges given (pairs of vertex indices) and, by default,
 *   every crease sharper than `seamAngle` and every open edge. Vertices are
 *   welded by position first, so a hard edge's split normals don't cut a chart.
 * - **Charts** are the triangles joined across the other edges. A chart with
 *   no boundary (a closed smooth surface no seam opens) can't lie flat: it is
 *   split by the direction its faces face, as the box projection would.
 * - **Each chart** is flattened by LSCM: per triangle, in its own plane,
 *   (z₂−z₁)U₀ + (z₀−z₂)U₁ + (z₁−z₀)U₂ = 0 asks the map to be a similarity
 *   there; two boundary vertices far apart are pinned, and the least-squares
 *   system is solved by conjugate gradients. The chart is then turned the way
 *   it winds (never mirrored) and scaled to its surface area, so texel
 *   density is even, and the charts are packed as the box projection packs.
 *
 * Pure and DOM-free.
 */
import type { MeshPrimitive } from "./MeshAsset";
import { packBoxes, rebuild, type Box } from "./uvUnwrap";

export interface ConformalUnwrapOptions {
  /** Edges to cut along, as pairs of vertex indices (welded by position). */
  readonly seams?: readonly (readonly [number, number])[];
  /** Creases sharper than this (degrees between the faces' normals) are cut too (default 60; 180 cuts none). */
  readonly seamAngle?: number;
  /** The gap between charts and around the edge, as a share of the square (default 1/128). */
  readonly margin?: number;
}

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));

/** Solve the normal equations AᵀA x = Aᵀb by conjugate gradients, A sparse as rows of (column, value). */
function leastSquares(rows: readonly (readonly [number, number][])[], rhs: Float64Array, n: number): Float64Array {
  const multiply = (x: Float64Array): Float64Array => {
    const ax = new Float64Array(rows.length);
    rows.forEach((row, r) => {
      let s = 0;
      for (const [c, v] of row) s += v * x[c]!;
      ax[r] = s;
    });
    const out = new Float64Array(n);
    rows.forEach((row, r) => {
      for (const [c, v] of row) out[c] = out[c]! + v * ax[r]!;
    });
    return out;
  };
  const b = new Float64Array(n);
  rows.forEach((row, r) => {
    for (const [c, v] of row) b[c] = b[c]! + v * rhs[r]!;
  });
  const x = new Float64Array(n);
  const r = Float64Array.from(b);
  const p = Float64Array.from(r);
  let rr = r.reduce((s, v) => s + v * v, 0);
  const tolerance = Math.max(1e-24, rr * 1e-20);
  for (let it = 0; it < Math.max(50, 4 * n) && rr > tolerance; it += 1) {
    const ap = multiply(p);
    const pap = p.reduce((s, v, i) => s + v * ap[i]!, 0);
    if (!(pap > 0)) break;
    const alpha = rr / pap;
    for (let i = 0; i < n; i += 1) {
      x[i] = x[i]! + alpha * p[i]!;
      r[i] = r[i]! - alpha * ap[i]!;
    }
    const next = r.reduce((s, v) => s + v * v, 0);
    const beta = next / rr;
    rr = next;
    for (let i = 0; i < n; i += 1) p[i] = r[i]! + beta * p[i]!;
  }
  return x;
}

/**
 * Flatten one chart (triangles over welded vertices) by LSCM: UVs per welded
 * vertex of the chart, or null when it can't be (fewer than two vertices).
 */
function flattenChart(tris: readonly (readonly [number, number, number])[], pos: (w: number) => V3): Map<number, [number, number]> | null {
  const verts = [...new Set(tris.flat())];
  if (verts.length < 3) return null;
  // Pins: two vertices far apart (the farthest from the first, then the farthest from that).
  const far = (from: number) => verts.reduce((best, w) => (len(sub(pos(w), pos(from))) > len(sub(pos(best), pos(from))) ? w : best), verts[0]!);
  const p0 = far(verts[0]!);
  const p1 = far(p0);
  if (p0 === p1) return null;
  const pinned = new Map<number, [number, number]>([
    [p0, [0, 0]],
    [p1, [len(sub(pos(p1), pos(p0))), 0]],
  ]);
  // Unknowns: u and v of each free vertex.
  const free = verts.filter((w) => !pinned.has(w));
  const col = new Map(free.map((w, i) => [w, i]));
  const rows: [number, number][][] = [];
  const rhs: number[] = [];
  for (const [a, b, c] of tris) {
    const A = pos(a), B = pos(b), C = pos(c);
    // The triangle in its own plane: a at the origin, b along x.
    const ab = sub(B, A), ac = sub(C, A);
    const e1 = len(ab);
    const n = cross(ab, ac);
    const area2 = len(n);
    if (e1 < 1e-12 || area2 < 1e-14) continue;
    const x2 = dot(ac, ab) / e1;
    const y2 = area2 / e1;
    const z: [number, number][] = [[0, 0], [e1, 0], [x2, y2]];
    const s = 1 / Math.sqrt(area2);
    // W_k = z_{k+2} − z_{k+1} for corners a, b, c.
    const W: [number, number][] = [0, 1, 2].map((k) => [(z[(k + 2) % 3]![0] - z[(k + 1) % 3]![0]) * s, (z[(k + 2) % 3]![1] - z[(k + 1) % 3]![1]) * s]);
    const corners = [a, b, c];
    // Re: Σ (Wr u − Wi v) = 0;  Im: Σ (Wi u + Wr v) = 0.
    const re: [number, number][] = [];
    const im: [number, number][] = [];
    let reRhs = 0, imRhs = 0;
    corners.forEach((w, k) => {
      const [wr, wi] = W[k]!;
      const pin = pinned.get(w);
      if (pin) {
        reRhs -= wr * pin[0] - wi * pin[1];
        imRhs -= wi * pin[0] + wr * pin[1];
        return;
      }
      const i = col.get(w)!;
      re.push([i * 2, wr], [i * 2 + 1, -wi]);
      im.push([i * 2, wi], [i * 2 + 1, wr]);
    });
    rows.push(re, im);
    rhs.push(reRhs, imRhs);
  }
  const x = leastSquares(rows, Float64Array.from(rhs), free.length * 2);
  const out = new Map<number, [number, number]>(pinned);
  free.forEach((w, i) => out.set(w, [x[i * 2]!, x[i * 2 + 1]!]));
  return out;
}

/**
 * A primitive's UVs made afresh by an angle-preserving unwrap (see the module
 * comment): charts cut at seams and creases, each flattened by LSCM, turned
 * the way it winds, scaled to its area and packed into the unit square.
 */
export function unwrapConformal(p: MeshPrimitive, options: ConformalUnwrapOptions = {}): MeshPrimitive {
  const count = p.positions.length / 3;
  // Weld by position.
  const weldKey = new Map<string, number>();
  const weld = new Int32Array(count);
  const weldPos: V3[] = [];
  for (let v = 0; v < count; v += 1) {
    const k = `${p.positions[v * 3]!.toFixed(6)},${p.positions[v * 3 + 1]!.toFixed(6)},${p.positions[v * 3 + 2]!.toFixed(6)}`;
    let w = weldKey.get(k);
    if (w === undefined) {
      w = weldPos.length;
      weldKey.set(k, w);
      weldPos.push([p.positions[v * 3]!, p.positions[v * 3 + 1]!, p.positions[v * 3 + 2]!]);
    }
    weld[v] = w;
  }
  const pos = (w: number) => weldPos[w]!;
  const triangles = p.indices.length / 3;
  const tri = Array.from({ length: triangles }, (_, t) => [weld[p.indices[t * 3]!]!, weld[p.indices[t * 3 + 1]!]!, weld[p.indices[t * 3 + 2]!]!] as [number, number, number]);
  const normal = tri.map(([a, b, c]) => {
    const n = cross(sub(pos(b), pos(a)), sub(pos(c), pos(a)));
    const l = len(n) || 1;
    return [n[0] / l, n[1] / l, n[2] / l] as V3;
  });
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const edgeTris = new Map<string, number[]>();
  tri.forEach(([a, b, c], t) => {
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const k = edgeKey(x, y);
      if (!edgeTris.has(k)) edgeTris.set(k, []);
      edgeTris.get(k)!.push(t);
    }
  });
  const seams = new Set((options.seams ?? []).map(([a, b]) => edgeKey(weld[a] ?? -1, weld[b] ?? -1)));
  const crease = Math.cos(((options.seamAngle ?? 60) * Math.PI) / 180);
  // An edge joins its two triangles unless it is a seam, a crease, or not shared by exactly two.
  const joins = (k: string, ts: readonly number[]) => ts.length === 2 && !seams.has(k) && dot(normal[ts[0]!]!, normal[ts[1]!]!) >= crease;
  // Charts: triangles joined across such edges.
  const parent = Int32Array.from({ length: triangles }, (_, k) => k);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (const [k, ts] of edgeTris) if (joins(k, ts)) parent[find(ts[1]!)] = find(ts[0]!);
  const groups = new Map<number, number[]>();
  for (let t = 0; t < triangles; t += 1) {
    const r = find(t);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(t);
  }
  // A chart no cut opens can't lie flat: split it by the way its faces face.
  const charts: number[][] = [];
  for (const ts of groups.values()) {
    const open = ts.some((t) => {
      const [a, b, c] = tri[t]!;
      return [[a, b], [b, c], [c, a]].some(([x, y]) => {
        const k = edgeKey(x!, y!);
        return !joins(k, edgeTris.get(k)!);
      });
    });
    if (open) {
      charts.push(ts);
      continue;
    }
    const byFacing = new Map<number, number[]>();
    for (const t of ts) {
      const n = normal[t]!;
      const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
      const axis = a[0]! >= a[1]! && a[0]! >= a[2]! ? 0 : a[1]! >= a[2]! ? 1 : 2;
      const f = axis * 2 + (n[axis]! > 0 ? 0 : 1);
      if (!byFacing.has(f)) byFacing.set(f, []);
      byFacing.get(f)!.push(t);
    }
    charts.push(...byFacing.values());
  }
  const chartOf = new Int32Array(triangles);
  charts.forEach((ts, c) => ts.forEach((t) => (chartOf[t] = c)));
  // Chart vertices: triangle corners joined across the edges that join within a chart, so a
  // vertex on a seam becomes one chart vertex a side and the chart really opens there.
  const corner = Int32Array.from({ length: triangles * 3 }, (_, k) => k);
  const findCorner = (x: number): number => {
    while (corner[x] !== x) {
      corner[x] = corner[corner[x]!]!;
      x = corner[x]!;
    }
    return x;
  };
  const cornerAt = (t: number, w: number) => t * 3 + tri[t]!.indexOf(w);
  for (const [k, ts] of edgeTris) {
    if (!joins(k, ts) || chartOf[ts[0]!] !== chartOf[ts[1]!]) continue;
    const [x, y] = k.split(":").map(Number) as [number, number];
    for (const w of [x, y]) corner[findCorner(cornerAt(ts[1]!, w))] = findCorner(cornerAt(ts[0]!, w));
  }
  const cornerPos = (g: number) => pos(tri[Math.floor(g / 3)]![g % 3]!);
  // Flatten, orient, scale each chart.
  const chartUv: Map<number, [number, number]>[] = [];
  const boxes: Box[] = [];
  for (const ts of charts) {
    const faces = ts.map((t) => [findCorner(t * 3), findCorner(t * 3 + 1), findCorner(t * 3 + 2)] as [number, number, number]);
    const flat = flattenChart(faces, cornerPos) ?? new Map<number, [number, number]>();
    // Its winding: the signed UV area of its triangles against their 3D area.
    let signed = 0;
    let area3 = 0;
    for (const [a, b, c] of faces) {
      const A = flat.get(a), B = flat.get(b), C = flat.get(c);
      area3 += len(cross(sub(cornerPos(b), cornerPos(a)), sub(cornerPos(c), cornerPos(a)))) / 2;
      if (!A || !B || !C) continue;
      signed += ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / 2;
    }
    const mirror = signed < 0 ? -1 : 1;
    const k = Math.abs(signed) > 1e-18 ? Math.sqrt(area3 / Math.abs(signed)) : 1;
    let lo: [number, number] = [Infinity, Infinity];
    let hi: [number, number] = [-Infinity, -Infinity];
    const uv = new Map<number, [number, number]>();
    for (const [g, [u, v]] of flat) {
      const q: [number, number] = [u * k * mirror, v * k];
      uv.set(g, q);
      lo = [Math.min(lo[0], q[0]), Math.min(lo[1], q[1])];
      hi = [Math.max(hi[0], q[0]), Math.max(hi[1], q[1])];
    }
    for (const [g, q] of uv) uv.set(g, [q[0] - lo[0], q[1] - lo[1]]);
    chartUv.push(uv);
    boxes.push({ w: Math.max(1e-6, hi[0] - lo[0]), h: Math.max(1e-6, hi[1] - lo[1]), x: 0, y: 0 });
  }
  const margin = options.margin ?? 1 / 128;
  let gap = margin * Math.sqrt(boxes.reduce((s, b) => s + b.w * b.h, 0)) * 1.2;
  let side = packBoxes(boxes, gap);
  gap = margin * side;
  side = packBoxes(boxes, gap);
  // One vertex per (source vertex, chart vertex): a seam's vertices are split, nothing else moves.
  const key = new Map<string, number>();
  const sources: number[] = [];
  const uvs: number[] = [];
  const indices = new Uint32Array(p.indices.length);
  for (let t = 0; t < triangles; t += 1) {
    const c = chartOf[t]!;
    for (let k = 0; k < 3; k += 1) {
      const v = p.indices[t * 3 + k]!;
      const g = findCorner(t * 3 + k);
      const id = `${v}:${g}`;
      let out = key.get(id);
      if (out === undefined) {
        out = sources.length;
        key.set(id, out);
        sources.push(v);
        const q = chartUv[c]!.get(g) ?? [0, 0];
        const b = boxes[c]!;
        uvs.push((b.x + q[0]) / side, (b.y + q[1]) / side);
      }
      indices[t * 3 + k] = out;
    }
  }
  return rebuild(p, sources, uvs, indices);
}

/**
 * How far a primitive's UVs are from conformal: each triangle's mean absolute
 * difference between its angles in 3D and in UV (radians), averaged over the
 * triangles, weighted by area. 0 is an exact similarity everywhere.
 */
export function angleDistortion(p: MeshPrimitive): number {
  if (!p.uvs) return Infinity;
  const angles = (a: number[], b: number[], c: number[]) => {
    const ang = (o: number[], x: number[], y: number[]) => {
      const u = x.map((v, i) => v - o[i]!), w = y.map((v, i) => v - o[i]!);
      const d = u.reduce((s, v, i) => s + v * w[i]!, 0);
      const l = Math.sqrt(u.reduce((s, v) => s + v * v, 0) * w.reduce((s, v) => s + v * v, 0)) || 1;
      return Math.acos(Math.max(-1, Math.min(1, d / l)));
    };
    return [ang(a, b, c), ang(b, c, a), ang(c, a, b)];
  };
  let total = 0;
  let weight = 0;
  for (let t = 0; t < p.indices.length / 3; t += 1) {
    const ids = [0, 1, 2].map((k) => p.indices[t * 3 + k]!);
    const P = ids.map((v) => [p.positions[v * 3]!, p.positions[v * 3 + 1]!, p.positions[v * 3 + 2]!]);
    const U = ids.map((v) => [p.uvs![v * 2]!, p.uvs![v * 2 + 1]!]);
    const area = len(cross(sub(P[1] as V3, P[0] as V3), sub(P[2] as V3, P[0] as V3))) / 2;
    const a3 = angles(P[0]!, P[1]!, P[2]!);
    const a2 = angles(U[0]!, U[1]!, U[2]!);
    total += area * (Math.abs(a3[0]! - a2[0]!) + Math.abs(a3[1]! - a2[1]!) + Math.abs(a3[2]! - a2[2]!)) / 3;
    weight += area;
  }
  return weight > 0 ? total / weight : 0;
}
