/**
 * Modelling in the editor (LOCKOUT_MULTIPLAYER_ROADMAP.md L15): vertex, edge
 * and face selection, a move, rotate and scale for the selection, and merge,
 * delete, loop cut, subdivide, mirror and add primitive — on static and
 * skinned meshes alike.
 *
 * The mesh stays what the runtime draws: triangle lists whose vertices are
 * split wherever an attribute changes (a hard edge, a UV seam). Modelling
 * works one level up, on what a modelling tool shows:
 *
 * - A **vertex** is a weld: every vertex of a primitive at one position, so a
 *   moved corner takes all of its split copies with it and the surface never
 *   tears.
 * - A **face** is a polygon as {@link faceAt} finds it: the coplanar
 *   triangles that share vertices edge to edge. Its corners are a loop of
 *   welds, counter-clockwise about its normal.
 * - An **edge** is a side of a face, between two welds; on a closed mesh each
 *   has a face on either side.
 *
 * Every operation keeps a closed mesh closed and consistently wound (each
 * edge used once each way round, checked by {@link meshClosure}): a cut
 * through an edge splits the faces on both sides of it, a delete fills the
 * hole it leaves, and a mirrored part turns its triangles round.
 *
 * Skinned meshes carry their weights through every edit. A moved vertex keeps
 * its own; a new one blends its neighbours' (the ends of the edge it splits,
 * the corners of the face it subdivides), keeping the four strongest joints
 * and normalising them to sum to 1. A mirrored part moves to the mirrored
 * joints (`_l` ↔ `_r`), and an added primitive rides the joints of the
 * vertices nearest it. So a reshaped Spartan still animates.
 *
 * New faces are separate faces (their own split vertices), flat-shaded where
 * the primitive stores normals; a light map no longer fits an edited surface,
 * so topology edits drop it (as face edits do). Pure and DOM-free.
 */

import type { MeshAsset, MeshPrimitive } from "./MeshAsset";
import type { MeshSkin } from "./skeleton";

export type Vec3 = [number, number, number];

/** Two triangles are one face when their normals agree this closely (cosine) — as {@link faceAt}. */
const COPLANAR_COS = 0.9995;

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const len = (a: readonly number[]) => Math.sqrt(dot(a, a));
const normalize = (a: readonly number[]): Vec3 => {
  const l = len(a);
  return l > 0 ? [a[0]! / l, a[1]! / l, a[2]! / l] : [0, 0, 0];
};
/** A position's identity, so vertices split for shading still meet (as meshEdit.ts). */
const keyOf = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
const edgeKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// --- Topology ----------------------------------------------------------------

/** A polygon of a primitive: its triangles and its corners as loops of welds. */
export interface TopologyFace {
  readonly triangles: readonly number[];
  /** The outer loop of corner welds, counter-clockwise about the normal. */
  readonly loop: readonly number[];
  /** The vertex this face uses at each corner of {@link loop} (its attributes there). */
  readonly corners: readonly number[];
  /** Every boundary loop (a face with a hole has more than one). */
  readonly loops: readonly (readonly number[])[];
  readonly normal: Vec3;
}

/** A side of one or more faces, between welds `a` < `b`. */
export interface TopologyEdge {
  readonly a: number;
  readonly b: number;
  readonly faces: readonly number[];
}

/** A primitive as a modelling tool sees it: welds, faces and edges. */
export interface PrimitiveTopology {
  /** Each vertex's weld. */
  readonly weldOf: Int32Array;
  /** Each weld's position (x, y, z): its first vertex's. */
  readonly weldPositions: Float64Array;
  readonly weldVertices: readonly (readonly number[])[];
  readonly faces: readonly TopologyFace[];
  readonly faceOfTriangle: Int32Array;
  readonly edges: readonly TopologyEdge[];
  /** An edge's index by its welds ({@link edgeKey}). */
  readonly edgeIndex: ReadonlyMap<string, number>;
  readonly weldEdges: readonly (readonly number[])[];
  readonly weldFaces: readonly (readonly number[])[];
}

const topologies = new WeakMap<MeshPrimitive, PrimitiveTopology>();

/** The topology of a primitive (cached per primitive object: primitives are never mutated). */
export function primitiveTopology(p: MeshPrimitive): PrimitiveTopology {
  const cached = topologies.get(p);
  if (cached) return cached;
  const vertexCount = p.positions.length / 3;
  const triCount = p.indices.length / 3;
  // Welds.
  const weldOf = new Int32Array(vertexCount);
  const byKey = new Map<string, number>();
  const weldVertices: number[][] = [];
  const weldPos: number[] = [];
  for (let v = 0; v < vertexCount; v += 1) {
    const x = p.positions[v * 3]!, y = p.positions[v * 3 + 1]!, z = p.positions[v * 3 + 2]!;
    const key = keyOf(x, y, z);
    let w = byKey.get(key);
    if (w === undefined) {
      w = weldVertices.length;
      byKey.set(key, w);
      weldVertices.push([]);
      weldPos.push(x, y, z);
    }
    weldOf[v] = w;
    weldVertices[w]!.push(v);
  }
  // Faces: as faceAt, flood from each unclaimed triangle through triangles
  // sharing a vertex pair, in its plane — but with the edge map built once.
  const byEdge = new Map<string, number[]>();
  const corner = (t: number, c: number) => p.indices[t * 3 + c]!;
  for (let t = 0; t < triCount; t += 1) {
    for (let e = 0; e < 3; e += 1) {
      const k = edgeKey(corner(t, e), corner(t, (e + 1) % 3));
      const list = byEdge.get(k);
      if (list) list.push(t);
      else byEdge.set(k, [t]);
    }
  }
  const vtx = (i: number): Vec3 => [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!];
  const triCross = (t: number) => {
    const a = vtx(corner(t, 0));
    return cross(sub(vtx(corner(t, 1)), a), sub(vtx(corner(t, 2)), a));
  };
  const faceOfTriangle = new Int32Array(triCount).fill(-1);
  const faces: TopologyFace[] = [];
  for (let seed = 0; seed < triCount; seed += 1) {
    if (faceOfTriangle[seed]! >= 0) continue;
    const normal = normalize(triCross(seed));
    const origin = vtx(corner(seed, 0));
    const extent = Math.max(1e-6, ...[0, 1, 2].map((c) => len(sub(vtx(corner(seed, c)), origin))));
    const inPlane = (t: number) =>
      dot(normalize(triCross(t)), normal) >= COPLANAR_COS && [0, 1, 2].every((c) => Math.abs(dot(sub(vtx(corner(t, c)), origin), normal)) < 1e-4 * Math.max(1, extent));
    const f = faces.length;
    const triangles = [seed];
    faceOfTriangle[seed] = f;
    for (let q = 0; q < triangles.length; q += 1) {
      const t = triangles[q]!;
      for (let e = 0; e < 3; e += 1) {
        for (const n of byEdge.get(edgeKey(corner(t, e), corner(t, (e + 1) % 3))) ?? []) {
          if (faceOfTriangle[n]! < 0 && inPlane(n)) {
            faceOfTriangle[n] = f;
            triangles.push(n);
          }
        }
      }
    }
    triangles.sort((a, b) => a - b);
    // The face's boundary: directed weld edges its own triangles don't pair.
    const directed = new Set<string>();
    const vertexAt = new Map<number, number>();
    for (const t of triangles) {
      for (let c = 0; c < 3; c += 1) {
        const a = weldOf[corner(t, c)]!, b = weldOf[corner(t, (c + 1) % 3)]!;
        directed.add(`${a}>${b}`);
        if (!vertexAt.has(a)) vertexAt.set(a, corner(t, c));
      }
    }
    const next = new Map<number, number>();
    for (const k of directed) {
      const [a, b] = k.split(">").map(Number) as [number, number];
      if (a !== b && !directed.has(`${b}>${a}`) && !next.has(a)) next.set(a, b);
    }
    const loops: number[][] = [];
    const used = new Set<number>();
    for (const start of next.keys()) {
      if (used.has(start)) continue;
      const loop: number[] = [];
      let at: number | undefined = start;
      while (at !== undefined && !used.has(at)) {
        used.add(at);
        loop.push(at);
        at = next.get(at);
      }
      if (loop.length >= 3) loops.push(loop);
    }
    loops.sort((a, b) => b.length - a.length);
    const loop = loops[0] ?? [];
    faces.push({ triangles, loop, corners: loop.map((w) => vertexAt.get(w)!), loops, normal });
  }
  // Edges: the sides of faces.
  const edges: { a: number; b: number; faces: number[] }[] = [];
  const edgeIndex = new Map<string, number>();
  const weldEdges: number[][] = weldVertices.map(() => []);
  const weldFaces: number[][] = weldVertices.map(() => []);
  faces.forEach((face, f) => {
    for (const loop of face.loops) {
      for (let i = 0; i < loop.length; i += 1) {
        const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
        weldFaces[a]!.push(f);
        const k = edgeKey(a, b);
        let e = edgeIndex.get(k);
        if (e === undefined) {
          e = edges.length;
          edgeIndex.set(k, e);
          edges.push({ a: Math.min(a, b), b: Math.max(a, b), faces: [] });
          weldEdges[a]!.push(e);
          weldEdges[b]!.push(e);
        }
        if (!edges[e]!.faces.includes(f)) edges[e]!.faces.push(f);
      }
    }
  });
  const topology: PrimitiveTopology = {
    weldOf,
    weldPositions: Float64Array.from(weldPos),
    weldVertices,
    faces,
    faceOfTriangle,
    edges,
    edgeIndex,
    weldEdges,
    weldFaces,
  };
  topologies.set(p, topology);
  return topology;
}

const weldPosition = (topo: PrimitiveTopology, w: number): Vec3 => [topo.weldPositions[w * 3]!, topo.weldPositions[w * 3 + 1]!, topo.weldPositions[w * 3 + 2]!];

/** Whether a face is a quad: one loop of four corners. */
const isQuad = (face: TopologyFace) => face.loops.length === 1 && face.loop.length === 4;

// --- Checks ------------------------------------------------------------------

/**
 * Whether a primitive is closed and consistently wound, by position: every
 * directed edge of its triangles (a → b) is matched by exactly one b → a, and
 * none is used twice. A closed, consistently wound mesh has none of either.
 */
export function meshClosure(p: MeshPrimitive): { readonly openEdges: number; readonly repeatedEdges: number; readonly degenerate: number; readonly closed: boolean } {
  const key = (i: number) => keyOf(p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!);
  const count = new Map<string, number>();
  let degenerate = 0;
  for (let t = 0; t < p.indices.length; t += 3) {
    const k = [0, 1, 2].map((c) => key(p.indices[t + c]!));
    if (k[0] === k[1] || k[1] === k[2] || k[2] === k[0]) {
      degenerate += 1;
      continue;
    }
    for (let e = 0; e < 3; e += 1) {
      const d = `${k[e]}>${k[(e + 1) % 3]}`;
      count.set(d, (count.get(d) ?? 0) + 1);
    }
  }
  let openEdges = 0;
  let repeatedEdges = 0;
  for (const [d, n] of count) {
    const [a, b] = d.split(">");
    if (n > 1) repeatedEdges += 1;
    if ((count.get(`${b}>${a}`) ?? 0) !== n) openEdges += 1;
  }
  return { openEdges, repeatedEdges, degenerate, closed: openEdges === 0 && repeatedEdges === 0 && degenerate === 0 };
}

/** The largest amount any vertex's weights miss summing to 1 by (0 for an unskinned primitive). */
export function weightError(p: MeshPrimitive): number {
  if (!p.weights) return 0;
  let worst = 0;
  for (let v = 0; v < p.weights.length / 4; v += 1) {
    let sum = 0;
    for (let k = 0; k < 4; k += 1) {
      const w = p.weights[v * 4 + k]!;
      if (w < 0) return Infinity;
      sum += w;
    }
    worst = Math.max(worst, Math.abs(sum - 1));
  }
  return worst;
}

// --- Selection ---------------------------------------------------------------

export type SelectMode = "vertex" | "edge" | "face";

/**
 * What is selected: per primitive (by index), the welds, edges or faces of
 * its {@link primitiveTopology}, sorted. Ids are only meaningful for the mesh
 * they were made on: a topology edit starts a fresh selection.
 */
export interface MeshSelection {
  readonly mode: SelectMode;
  readonly parts: readonly (readonly number[])[];
}

export function emptySelection(mode: SelectMode): MeshSelection {
  return { mode, parts: [] };
}

/** How many elements are selected. */
export function selectionSize(selection: MeshSelection): number {
  return selection.parts.reduce((n, ids) => n + (ids?.length ?? 0), 0);
}

const sortedUnique = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);

function fromSets(mode: SelectMode, sets: readonly (Set<number> | undefined)[]): MeshSelection {
  return { mode, parts: sets.map((s) => (s ? sortedUnique(s) : [])) };
}

/** The welds a selection covers, per primitive. */
export function selectionWelds(mesh: MeshAsset, selection: MeshSelection): Set<number>[] {
  return mesh.primitives.map((p, i) => {
    const ids = selection.parts[i] ?? [];
    const out = new Set<number>();
    if (ids.length === 0) return out;
    const topo = primitiveTopology(p);
    for (const id of ids) {
      if (selection.mode === "vertex") {
        if (id >= 0 && id < topo.weldVertices.length) out.add(id);
      } else if (selection.mode === "edge") {
        const e = topo.edges[id];
        if (e) out.add(e.a).add(e.b);
      } else {
        for (const loop of topo.faces[id]?.loops ?? []) for (const w of loop) out.add(w);
      }
    }
    return out;
  });
}

/** The faces a selection covers, per primitive: those selected, or (vertex and edge modes) whose every corner is. */
export function selectionFaces(mesh: MeshAsset, selection: MeshSelection): Set<number>[] {
  if (selection.mode === "face") return mesh.primitives.map((p, i) => new Set((selection.parts[i] ?? []).filter((f) => f >= 0 && f < primitiveTopology(p).faces.length)));
  const welds = selectionWelds(mesh, selection);
  return mesh.primitives.map((p, i) => {
    const topo = primitiveTopology(p);
    const out = new Set<number>();
    const ws = welds[i]!;
    if (ws.size === 0) return out;
    topo.faces.forEach((face, f) => {
      if (face.loops.every((loop) => loop.every((w) => ws.has(w)))) out.add(f);
    });
    return out;
  });
}

/** A selection carried to another mode: welds to the edges and faces they span, and back to their corners. */
export function convertSelection(mesh: MeshAsset, selection: MeshSelection, mode: SelectMode): MeshSelection {
  if (mode === selection.mode) return selection;
  if (mode === "face") return fromSets("face", selectionFaces(mesh, selection));
  const welds = selectionWelds(mesh, selection);
  if (mode === "vertex") return fromSets("vertex", welds);
  return fromSets(
    "edge",
    mesh.primitives.map((p, i) => {
      const topo = primitiveTopology(p);
      const ws = welds[i]!;
      const out = new Set<number>();
      topo.edges.forEach((e, k) => {
        if (ws.has(e.a) && ws.has(e.b)) out.add(k);
      });
      return out;
    }),
  );
}

/** Two selections combined: `add` joins them, `toggle` flips the second's elements in the first, `subtract` removes them. */
export function combineSelection(base: MeshSelection, change: MeshSelection, op: "replace" | "add" | "toggle" | "subtract"): MeshSelection {
  if (op === "replace" || base.mode !== change.mode) return change;
  const count = Math.max(base.parts.length, change.parts.length);
  const parts: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    const set = new Set(base.parts[i] ?? []);
    for (const id of change.parts[i] ?? []) {
      if (op === "add") set.add(id);
      else if (op === "subtract") set.delete(id);
      else if (set.has(id)) set.delete(id);
      else set.add(id);
    }
    parts.push(sortedUnique(set));
  }
  return { mode: base.mode, parts };
}

/** One element of one primitive as a selection. */
export function singleSelection(mode: SelectMode, primitive: number, id: number): MeshSelection {
  const parts: number[][] = [];
  for (let i = 0; i <= primitive; i += 1) parts.push(i === primitive ? [id] : []);
  return { mode, parts };
}

/** Every element of every primitive. */
export function selectAll(mesh: MeshAsset, mode: SelectMode): MeshSelection {
  return {
    mode,
    parts: mesh.primitives.map((p) => {
      const topo = primitiveTopology(p);
      const n = mode === "vertex" ? topo.weldVertices.length : mode === "edge" ? topo.edges.length : topo.faces.length;
      return Array.from({ length: n }, (_, k) => k);
    }),
  };
}

/** The centre of the selected welds (the gizmo's pivot), or null for nothing selected. */
export function selectionPivot(mesh: MeshAsset, selection: MeshSelection): Vec3 | null {
  const welds = selectionWelds(mesh, selection);
  let sum: Vec3 = [0, 0, 0];
  let n = 0;
  mesh.primitives.forEach((p, i) => {
    const topo = primitiveTopology(p);
    for (const w of welds[i]!) {
      sum = [sum[0] + topo.weldPositions[w * 3]!, sum[1] + topo.weldPositions[w * 3 + 1]!, sum[2] + topo.weldPositions[w * 3 + 2]!];
      n += 1;
    }
  });
  return n > 0 ? [sum[0] / n, sum[1] / n, sum[2] / n] : null;
}

/**
 * The vertices a joint carries at least `min` of (a Spartan's helmet is what
 * `head` carries), as a selection in `mode`.
 */
export function selectByJoint(mesh: MeshAsset, joint: number, mode: SelectMode = "vertex", min = 0.5): MeshSelection {
  const sets = mesh.primitives.map((p) => {
    const out = new Set<number>();
    if (!p.joints || !p.weights) return out;
    const topo = primitiveTopology(p);
    for (let v = 0; v < topo.weldOf.length; v += 1) {
      let w = 0;
      for (let k = 0; k < 4; k += 1) if (p.joints[v * 4 + k] === joint) w += p.weights[v * 4 + k]!;
      if (w >= min) out.add(topo.weldOf[v]!);
    }
    return out;
  });
  return convertSelection(mesh, fromSets("vertex", sets), mode);
}

/**
 * The parts of a mesh a selection touches, grown to whole connected shells
 * (each closed piece of a primitive: a plate, a visor, a stock).
 */
export function selectLinked(mesh: MeshAsset, selection: MeshSelection): MeshSelection {
  const welds = selectionWelds(mesh, selection);
  const sets = mesh.primitives.map((p, i) => {
    const shells = primitiveShells(p);
    const picked = new Set<number>();
    for (const w of welds[i]!) picked.add(shells.shellOfWeld[w]!);
    const out = new Set<number>();
    shells.shellOfWeld.forEach((s, w) => {
      if (picked.has(s)) out.add(w);
    });
    return out;
  });
  return convertSelection(mesh, fromSets("vertex", sets), selection.mode);
}

/** Connected pieces of a primitive, by welds shared between triangles. */
function primitiveShells(p: MeshPrimitive): { shellOfWeld: Int32Array; shellOfTriangle: Int32Array } {
  const topo = primitiveTopology(p);
  const parent = Int32Array.from({ length: topo.weldVertices.length }, (_, k) => k);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  for (let t = 0; t < p.indices.length; t += 3) {
    const a = find(topo.weldOf[p.indices[t]!]!);
    for (let c = 1; c < 3; c += 1) {
      const b = find(topo.weldOf[p.indices[t + c]!]!);
      if (a !== b) parent[b] = a;
    }
  }
  const shellOfWeld = Int32Array.from({ length: parent.length }, (_, w) => find(w));
  const shellOfTriangle = Int32Array.from({ length: p.indices.length / 3 }, (_, t) => shellOfWeld[topo.weldOf[p.indices[t * 3]!]!]!);
  return { shellOfWeld, shellOfTriangle };
}

// --- Picking (in the preview's projection) -------------------------------------

/** A point projected by a column-major view-projection: NDC x, y (−1..1, y up) and depth; null behind the eye. */
export function projectPoint(viewProj: ArrayLike<number>, p: readonly number[]): [number, number, number] | null {
  const m = viewProj;
  const [x, y, z] = [p[0]!, p[1]!, p[2]!];
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (w <= 1e-6) return null;
  return [(m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w, (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w, w];
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/**
 * The element under a click (NDC), as one-element selection, or null. `hit`
 * is the triangle the click lands on (pickMeshTriangle): a face is the one it
 * belongs to, and a vertex or edge is the nearest of that face's (so only
 * what's in front is picked), else the nearest anywhere within `radius`.
 */
export function pickElement(
  mesh: MeshAsset,
  viewProj: ArrayLike<number>,
  ndc: readonly [number, number],
  mode: SelectMode,
  hit: { readonly primitive: number; readonly triangle: number } | null,
  radius = 0.05,
): { primitive: number; id: number } | null {
  const hitFace = hit && mesh.primitives[hit.primitive] ? primitiveTopology(mesh.primitives[hit.primitive]!).faceOfTriangle[hit.triangle] : undefined;
  if (mode === "face") return hit && hitFace !== undefined && hitFace >= 0 ? { primitive: hit.primitive, id: hitFace } : null;
  const best = { primitive: -1, id: -1, d: Infinity };
  const scan = (primitive: number, onlyFace: number | null, limit: number) => {
    const topo = primitiveTopology(mesh.primitives[primitive]!);
    const welds = onlyFace !== null ? topo.faces[onlyFace]!.loops.flat() : topo.weldVertices.map((_, w) => w);
    const at = new Map<number, [number, number, number] | null>();
    const screen = (w: number) => {
      if (!at.has(w)) at.set(w, projectPoint(viewProj, weldPosition(topo, w)));
      return at.get(w)!;
    };
    const consider = (id: number, d: number) => {
      if (d <= limit && d < best.d) Object.assign(best, { primitive, id, d });
    };
    if (mode === "vertex") {
      for (const w of welds) {
        const s = screen(w);
        if (s) consider(w, Math.hypot(s[0] - ndc[0], s[1] - ndc[1]));
      }
      return;
    }
    const edges = onlyFace !== null ? [...new Set(welds.flatMap((w) => topo.weldEdges[w]!))].filter((e) => topo.edges[e]!.faces.includes(onlyFace)) : topo.edges.map((_, e) => e);
    for (const e of edges) {
      const { a, b } = topo.edges[e]!;
      const sa = screen(a), sb = screen(b);
      if (sa && sb) consider(e, segmentDistance(ndc[0], ndc[1], sa[0], sa[1], sb[0], sb[1]));
    }
  };
  // The clicked face's own corners or sides first: what's in front.
  if (hit && hitFace !== undefined && hitFace >= 0) scan(hit.primitive, hitFace, Infinity);
  if (best.id < 0) mesh.primitives.forEach((_, i) => scan(i, null, radius));
  return best.id >= 0 ? { primitive: best.primitive, id: best.id } : null;
}

/**
 * Every element inside a screen rectangle (NDC corners, either way round): the
 * welds in it, the edges with both ends in it, the faces with every corner in
 * it. It selects through the mesh, front and back alike.
 */
export function boxSelect(mesh: MeshAsset, viewProj: ArrayLike<number>, from: readonly [number, number], to: readonly [number, number], mode: SelectMode): MeshSelection {
  const [x0, x1] = [Math.min(from[0], to[0]), Math.max(from[0], to[0])];
  const [y0, y1] = [Math.min(from[1], to[1]), Math.max(from[1], to[1])];
  const sets = mesh.primitives.map((p) => {
    const topo = primitiveTopology(p);
    const inside = new Set<number>();
    for (let w = 0; w < topo.weldVertices.length; w += 1) {
      const s = projectPoint(viewProj, weldPosition(topo, w));
      if (s && s[0] >= x0 && s[0] <= x1 && s[1] >= y0 && s[1] <= y1) inside.add(w);
    }
    return inside;
  });
  return convertSelection(mesh, fromSets("vertex", sets), mode);
}

/** The edge loop through an edge: on through every corner where four edges meet, to the edge across from it. */
function edgeLoop(topo: PrimitiveTopology, start: number): number[] {
  const out = new Set([start]);
  const walk = (edge: number, from: number) => {
    let e = edge;
    let at = from;
    for (let guard = 0; guard < topo.edges.length; guard += 1) {
      const { a, b } = topo.edges[e]!;
      const w = a === at ? b : a; // the far end
      const around = topo.weldEdges[w]!;
      if (around.length !== 4) return;
      const faces = new Set(topo.edges[e]!.faces);
      const next = around.find((n) => n !== e && !topo.edges[n]!.faces.some((f) => faces.has(f)));
      if (next === undefined || out.has(next)) return;
      out.add(next);
      e = next;
      at = w;
    }
  };
  const { a, b } = topo.edges[start]!;
  walk(start, a);
  walk(start, b);
  return [...out];
}

/** One step of an edge ring across a quad: entered by its side (u, v) with u on the left, the side across (u2, v2). */
function across(face: TopologyFace, u: number, v: number): { u2: number; v2: number } | null {
  if (!isQuad(face)) return null;
  const loop = face.loop;
  const iu = loop.indexOf(u), iv = loop.indexOf(v);
  if (iu < 0 || iv < 0) return null;
  const forward = (iu + 1) % 4 === iv;
  if (!forward && (iv + 1) % 4 !== iu) return null;
  const step = forward ? 3 : 1; // from u away from v
  return { u2: loop[(iu + step) % 4]!, v2: loop[(iv + (forward ? 1 : 3)) % 4]! };
}

/**
 * The ring of quads an edge runs across, walking both ways from it until a
 * face isn't a quad or the ring closes: each face with the side it was
 * entered by (`u` the left end) and the side across.
 */
function faceRing(topo: PrimitiveTopology, start: number): { faces: { face: number; u: number; v: number; u2: number; v2: number }[]; cuts: Map<number, { left: number; right: number }> } {
  const faces: { face: number; u: number; v: number; u2: number; v2: number }[] = [];
  const cuts = new Map<number, { left: number; right: number }>();
  const visited = new Set<number>();
  const { a, b } = topo.edges[start]!;
  cuts.set(start, { left: a, right: b });
  const walk = (face: number | undefined, u: number, v: number) => {
    let f = face;
    let [cu, cv] = [u, v];
    while (f !== undefined && !visited.has(f)) {
      const step = across(topo.faces[f]!, cu, cv);
      if (!step) return;
      visited.add(f);
      faces.push({ face: f, u: cu, v: cv, ...step });
      const e = topo.edgeIndex.get(edgeKey(step.u2, step.v2));
      if (e === undefined) return;
      if (!cuts.has(e)) cuts.set(e, { left: step.u2, right: step.v2 });
      const before: number = f;
      f = topo.edges[e]!.faces.find((g) => g !== before);
      [cu, cv] = [step.u2, step.v2];
    }
  };
  const [f1, f2] = topo.edges[start]!.faces;
  walk(f1, a, b);
  if (f2 !== undefined && !visited.has(f2)) walk(f2, a, b);
  return { faces, cuts };
}

/**
 * Loop select from an edge: its edge loop (edge mode, and in vertex mode the
 * loop's welds), or in face mode the ring of quads it runs across.
 */
export function loopSelect(mesh: MeshAsset, primitive: number, edge: number, mode: SelectMode): MeshSelection {
  const p = mesh.primitives[primitive];
  if (!p || !primitiveTopology(p).edges[edge]) return emptySelection(mode);
  const topo = primitiveTopology(p);
  const sets: Set<number>[] = mesh.primitives.map(() => new Set());
  if (mode === "face") {
    for (const f of faceRing(topo, edge).faces) sets[primitive]!.add(f.face);
    return fromSets("face", sets);
  }
  const loop = edgeLoop(topo, edge);
  if (mode === "edge") {
    for (const e of loop) sets[primitive]!.add(e);
    return fromSets("edge", sets);
  }
  for (const e of loop) sets[primitive]!.add(topo.edges[e]!.a).add(topo.edges[e]!.b);
  return fromSets("vertex", sets);
}

/** The edge nearest a point of the screen (NDC), preferring the clicked face's sides; null when none is near. */
export function pickEdge(mesh: MeshAsset, viewProj: ArrayLike<number>, ndc: readonly [number, number], hit: { readonly primitive: number; readonly triangle: number } | null, radius = 0.05) {
  return pickElement(mesh, viewProj, ndc, "edge", hit, radius);
}

// --- Rebuilding a primitive --------------------------------------------------

/** One source vertex's share of a new one. */
type Part = readonly [vertex: number, share: number];

/**
 * Blend influences: each joint's weight summed over the parts, the four
 * strongest kept, normalised to 1. All zero when the parts are unweighted.
 */
export function blendInfluences(joints: Uint16Array | ArrayLike<number>, weights: Float32Array | ArrayLike<number>, parts: readonly Part[]): { joints: number[]; weights: number[] } {
  const byJoint = new Map<number, number>();
  for (const [v, share] of parts) {
    for (let k = 0; k < 4; k += 1) {
      const w = weights[v * 4 + k]! * share;
      if (w > 0) byJoint.set(joints[v * 4 + k]!, (byJoint.get(joints[v * 4 + k]!) ?? 0) + w);
    }
  }
  const top = [...byJoint].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 4);
  const total = top.reduce((s, [, w]) => s + w, 0);
  const out = { joints: [0, 0, 0, 0], weights: [0, 0, 0, 0] };
  if (total <= 0) return out;
  top.forEach(([j, w], k) => {
    out.joints[k] = j;
    out.weights[k] = w / total;
  });
  // Float rounding: put any remainder on the strongest, so the sum is exactly 1 in float32.
  const sum = Math.fround(out.weights.reduce((s, w) => s + Math.fround(w), 0));
  if (sum !== 1) out.weights[0] = Math.fround(out.weights[0]! + (1 - sum));
  return out;
}

/** A primitive being rebuilt: its vertex streams (growable), the triangles to keep, and new vertices blended from old. */
class Rebuild {
  readonly pos: number[];
  readonly nrm: number[] | null;
  readonly uv: number[] | null;
  readonly uv2: number[] | null;
  readonly blendW: number[] | null;
  readonly jnt: number[] | null;
  readonly wgt: number[] | null;
  readonly tris: number[] = [];
  /** Vertices whose normals are worked out afresh. */
  readonly touched = new Set<number>();

  constructor(readonly src: MeshPrimitive) {
    this.pos = Array.from(src.positions);
    this.nrm = src.normals ? Array.from(src.normals) : null;
    this.uv = src.uvs ? Array.from(src.uvs) : null;
    this.uv2 = src.uvs2 ? Array.from(src.uvs2) : null;
    this.blendW = src.blend ? Array.from(src.blend) : null;
    this.jnt = src.joints && src.weights ? Array.from(src.joints) : null;
    this.wgt = src.joints && src.weights ? Array.from(src.weights) : null;
  }

  /** A new vertex blended from source vertices (shares sum to 1), at `position` (default: the blend of theirs). */
  blend(parts: readonly Part[], position?: readonly number[]): number {
    const v = this.pos.length / 3;
    const mix = (stream: number[] | null, width: number) => {
      if (!stream) return;
      for (let c = 0; c < width; c += 1) stream.push(parts.reduce((s, [i, w]) => s + stream[i * width + c]! * w, 0));
    };
    if (position) this.pos.push(position[0]!, position[1]!, position[2]!);
    else mix(this.pos, 3);
    mix(this.nrm, 3);
    mix(this.uv, 2);
    mix(this.uv2, 2);
    mix(this.blendW, 1);
    if (this.jnt && this.wgt) {
      const b = blendInfluences(this.jnt, this.wgt, parts);
      this.jnt.push(...b.joints);
      this.wgt.push(...b.weights);
    }
    this.touched.add(v);
    return v;
  }

  /** A fresh copy of vertex `i` (so a new face has vertices of its own). */
  copy(i: number): number {
    return this.blend([[i, 1]]);
  }

  tri(a: number, b: number, c: number): void {
    this.tris.push(a, b, c);
  }

  setPosition(v: number, p: readonly number[]): void {
    this.pos[v * 3] = p[0]!;
    this.pos[v * 3 + 1] = p[1]!;
    this.pos[v * 3 + 2] = p[2]!;
  }

  /** The primitive: unused vertices dropped, touched vertices' normals remade, a light map dropped if `topology` changed. */
  build(topology: boolean): MeshPrimitive {
    const used = new Int32Array(this.pos.length / 3).fill(-1);
    let count = 0;
    const indices = new Uint32Array(this.tris.length);
    this.tris.forEach((v, k) => {
      if (used[v]! < 0) used[v] = count++;
      indices[k] = used[v]!;
    });
    const pick = (stream: number[] | null, width: number, Kind: Float32ArrayConstructor | Uint16ArrayConstructor) => {
      if (!stream) return null;
      const out = new Kind(count * width);
      used.forEach((n, v) => {
        if (n >= 0) for (let c = 0; c < width; c += 1) out[n * width + c] = stream[v * width + c]!;
      });
      return out;
    };
    const positions = pick(this.pos, 3, Float32Array) as Float32Array;
    let normals = pick(this.nrm, 3, Float32Array) as Float32Array | null;
    if (normals && this.touched.size > 0) {
      // Each touched vertex's normal: the area-weighted sum of its triangles' (as computeSmoothNormals).
      const touched = new Uint8Array(count);
      for (const v of this.touched) if (used[v]! >= 0) touched[used[v]!] = 1;
      const acc = new Float64Array(count * 3);
      for (let t = 0; t < indices.length; t += 3) {
        const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
        if (!touched[a] && !touched[b] && !touched[c]) continue;
        const pa = [positions[a * 3]!, positions[a * 3 + 1]!, positions[a * 3 + 2]!];
        const n = cross(sub([positions[b * 3]!, positions[b * 3 + 1]!, positions[b * 3 + 2]!], pa), sub([positions[c * 3]!, positions[c * 3 + 1]!, positions[c * 3 + 2]!], pa));
        for (const v of [a, b, c]) if (touched[v]) for (let k = 0; k < 3; k += 1) acc[v * 3 + k] = acc[v * 3 + k]! + n[k]!;
      }
      normals = normals.slice();
      for (let v = 0; v < count; v += 1) {
        if (!touched[v]) continue;
        const n = normalize([acc[v * 3]!, acc[v * 3 + 1]!, acc[v * 3 + 2]!]);
        if (len(n) > 0) normals.set(n, v * 3);
      }
    }
    const { lightmapImage: _lightmap, ...withoutLightmap } = this.src.material;
    const joints = pick(this.jnt, 4, Uint16Array) as Uint16Array | null;
    const weights = pick(this.wgt, 4, Float32Array) as Float32Array | null;
    const uvs2 = pick(this.uv2, 2, Float32Array) as Float32Array | null;
    const blend = pick(this.blendW, 1, Float32Array) as Float32Array | null;
    return {
      positions,
      normals,
      uvs: pick(this.uv, 2, Float32Array) as Float32Array | null,
      indices,
      material: topology && this.src.material.lightmapImage ? withoutLightmap : this.src.material,
      ...(uvs2 && !(topology && this.src.material.lightmapImage) ? { uvs2 } : {}),
      ...(blend ? { blend } : {}),
      ...(joints && weights ? { joints, weights } : {}),
    };
  }
}

/** Keep every triangle of a primitive except those in `drop`. */
function keepTriangles(r: Rebuild, drop: ReadonlySet<number>): void {
  const p = r.src;
  for (let t = 0; t < p.indices.length / 3; t += 1) if (!drop.has(t)) r.tri(p.indices[t * 3]!, p.indices[t * 3 + 1]!, p.indices[t * 3 + 2]!);
}

/** Fan-free triangulation of a polygon (indices into `points`, any winding) by ear clipping in its plane; keeps its winding. */
function triangulate(points: readonly Vec3[]): [number, number, number][] {
  const n = points.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  // Newell's normal: the polygon's winding axis.
  let normal: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    const a = points[i]!, b = points[(i + 1) % n]!;
    normal = [normal[0] + (a[1] - b[1]) * (a[2] + b[2]), normal[1] + (a[2] - b[2]) * (a[0] + b[0]), normal[2] + (a[0] - b[0]) * (a[1] + b[1])];
  }
  normal = normalize(normal);
  const remaining = Array.from({ length: n }, (_, i) => i);
  const out: [number, number, number][] = [];
  const area2 = (a: Vec3, b: Vec3, c: Vec3) => dot(cross(sub(b, a), sub(c, a)), normal);
  const inside = (p: Vec3, a: Vec3, b: Vec3, c: Vec3) => area2(a, b, p) >= -1e-12 && area2(b, c, p) >= -1e-12 && area2(c, a, p) >= -1e-12;
  let guard = n * n;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < remaining.length; k += 1) {
      const i0 = remaining[(k + remaining.length - 1) % remaining.length]!, i1 = remaining[k]!, i2 = remaining[(k + 1) % remaining.length]!;
      const [a, b, c] = [points[i0]!, points[i1]!, points[i2]!];
      if (area2(a, b, c) <= 1e-14) continue; // reflex or flat
      if (remaining.some((j) => j !== i0 && j !== i1 && j !== i2 && inside(points[j]!, a, b, c))) continue;
      out.push([i0, i1, i2]);
      remaining.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Degenerate or self-touching: close the rest as a fan.
      for (let k = 1; k + 1 < remaining.length; k += 1) out.push([remaining[0]!, remaining[k]!, remaining[k + 1]!]);
      return out;
    }
  }
  if (remaining.length === 3) out.push([remaining[0]!, remaining[1]!, remaining[2]!]);
  return out;
}

/** Emit a polygon (vertex indices, counter-clockwise) as a face of its own: fresh copies of its corners, triangulated. */
function emitPolygon(r: Rebuild, corners: readonly number[]): void {
  const own = corners.map((v) => r.copy(v));
  const points = own.map((v) => [r.pos[v * 3]!, r.pos[v * 3 + 1]!, r.pos[v * 3 + 2]!] as Vec3);
  for (const [a, b, c] of triangulate(points)) r.tri(own[a]!, own[b]!, own[c]!);
}

/**
 * Split one triangle at the midpoints (new vertices) of some of its sides,
 * keeping it in its face: `mids[e]` is the new vertex on side e (corner e to
 * e+1), or undefined. One split side makes two triangles, two make three,
 * all three make four.
 */
function splitTriangle(r: Rebuild, corners: readonly [number, number, number], mids: readonly (number | undefined)[]): void {
  const split = [0, 1, 2].filter((e) => mids[e] !== undefined);
  const [a, b, c] = corners;
  if (split.length === 0) return r.tri(a, b, c);
  if (split.length === 3) {
    const [m0, m1, m2] = mids as [number, number, number];
    r.tri(a, m0, m2);
    r.tri(m0, b, m1);
    r.tri(m2, m1, c);
    r.tri(m0, m1, m2);
    return;
  }
  // Rotate so the (first) split side is side 0.
  const s = split.length === 1 ? split[0]! : split.includes(0) && split.includes(1) ? 0 : split.includes(1) && split.includes(2) ? 1 : 2;
  const k = [corners[s]!, corners[(s + 1) % 3]!, corners[(s + 2) % 3]!];
  const m = [mids[s], mids[(s + 1) % 3], mids[(s + 2) % 3]];
  if (split.length === 1) {
    r.tri(k[0]!, m[0]!, k[2]!);
    r.tri(m[0]!, k[1]!, k[2]!);
    return;
  }
  // Sides 0 and 1 split.
  r.tri(m[0]!, k[1]!, m[1]!);
  r.tri(k[0]!, m[0]!, m[1]!);
  r.tri(k[0]!, m[1]!, k[2]!);
}

/** Replace some primitives of a mesh. */
function withPrimitives(mesh: MeshAsset, next: ReadonlyMap<number, MeshPrimitive>): MeshAsset {
  if (next.size === 0) return mesh;
  return { ...mesh, primitives: mesh.primitives.map((p, i) => next.get(i) ?? p) };
}

// --- Transform -----------------------------------------------------------------

export type SelectionTransform =
  | { readonly kind: "move"; readonly offset: readonly [number, number, number] }
  | { readonly kind: "rotate"; readonly axis: 0 | 1 | 2; readonly angle: number }
  | { readonly kind: "scale"; readonly factor: readonly [number, number, number] };

/** A point under a transform about a pivot. */
export function transformPoint(p: readonly number[], transform: SelectionTransform, pivot: readonly number[]): Vec3 {
  if (transform.kind === "move") return [p[0]! + transform.offset[0], p[1]! + transform.offset[1], p[2]! + transform.offset[2]];
  const d = sub(p, pivot);
  if (transform.kind === "scale") return [pivot[0]! + d[0] * transform.factor[0], pivot[1]! + d[1] * transform.factor[1], pivot[2]! + d[2] * transform.factor[2]];
  const c = Math.cos(transform.angle), s = Math.sin(transform.angle);
  const [i, j] = transform.axis === 0 ? [1, 2] : transform.axis === 1 ? [2, 0] : [0, 1];
  const out: Vec3 = [d[0], d[1], d[2]];
  out[i] = d[i]! * c - d[j]! * s;
  out[j] = d[i]! * s + d[j]! * c;
  return [pivot[0]! + out[0], pivot[1]! + out[1], pivot[2]! + out[2]];
}

/**
 * Move, rotate or scale the selected welds about `pivot` (default: their
 * centre). Every split copy of a weld moves together; weights stay as they
 * are; normals around the moved vertices are remade (where it stores them).
 */
export function transformSelection(mesh: MeshAsset, selection: MeshSelection, transform: SelectionTransform, pivot?: readonly number[]): MeshAsset {
  const centre = pivot ?? selectionPivot(mesh, selection);
  if (!centre) return mesh;
  const welds = selectionWelds(mesh, selection);
  const next = new Map<number, MeshPrimitive>();
  mesh.primitives.forEach((p, i) => {
    const ws = welds[i]!;
    if (ws.size === 0) return;
    const topo = primitiveTopology(p);
    const r = new Rebuild(p);
    for (const w of ws) {
      const to = transformPoint(weldPosition(topo, w), transform, centre);
      for (const v of topo.weldVertices[w]!) {
        r.setPosition(v, to);
        r.touched.add(v);
      }
    }
    // Neighbours' normals change too.
    for (let t = 0; t < p.indices.length; t += 3) {
      const tri = [p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!];
      if (tri.some((v) => ws.has(topo.weldOf[v]!))) for (const v of tri) r.touched.add(v);
    }
    keepTriangles(r, new Set());
    next.set(i, r.build(false));
  });
  return withPrimitives(mesh, next);
}

// --- Merge -----------------------------------------------------------------------

/**
 * Merge the selected welds of each primitive into one, at their centre (all
 * selected primitives share it). Triangles the merge collapses go, and so do
 * pairs left back to back; the merged vertex takes the blend of their weights.
 */
export function mergeSelection(mesh: MeshAsset, selection: MeshSelection): MeshAsset {
  const centre = selectionPivot(mesh, selection);
  if (!centre) return mesh;
  const welds = selectionWelds(mesh, selection);
  const next = new Map<number, MeshPrimitive>();
  mesh.primitives.forEach((p, i) => {
    const ws = welds[i]!;
    if (ws.size < 2 && welds.filter((s) => s.size > 0).length < 2) return;
    if (ws.size === 0) return;
    const topo = primitiveTopology(p);
    const r = new Rebuild(p);
    const reps = [...ws].map((w) => [topo.weldVertices[w]![0]!, 1 / ws.size] as const);
    const merged = r.jnt && r.wgt ? blendInfluences(r.jnt, r.wgt, reps) : null;
    for (const w of ws) {
      for (const v of topo.weldVertices[w]!) {
        r.setPosition(v, centre);
        r.touched.add(v);
        if (merged) {
          for (let k = 0; k < 4; k += 1) {
            r.jnt![v * 4 + k] = merged.joints[k]!;
            r.wgt![v * 4 + k] = merged.weights[k]!;
          }
        }
      }
    }
    // The merged welds are one now; drop collapsed triangles and back-to-back pairs.
    const mergedWeld = Math.min(...ws);
    const weld = (v: number) => (ws.has(topo.weldOf[v]!) ? mergedWeld : topo.weldOf[v]!);
    const kept = new Set<number>();
    const facing = new Map<string, number[]>();
    for (let t = 0; t < p.indices.length / 3; t += 1) {
      const w = [0, 1, 2].map((c) => weld(p.indices[t * 3 + c]!));
      if (w[0] === w[1] || w[1] === w[2] || w[2] === w[0]) continue;
      kept.add(t);
      const rot = w.indexOf(Math.min(...w));
      const key = [w[rot], w[(rot + 1) % 3], w[(rot + 2) % 3]].join(",");
      facing.set(key, [...(facing.get(key) ?? []), t]);
    }
    const drop = new Set<number>();
    for (let t = 0; t < p.indices.length / 3; t += 1) if (!kept.has(t)) drop.add(t);
    for (const [key, list] of facing) {
      const [a, b, c] = key.split(",");
      const back = facing.get([a, c, b].join(","));
      if (!back) continue;
      // Pair them off: each back-to-back pair leaves the surface.
      const pairs = Math.min(list.length, back.length);
      for (let k = 0; k < pairs; k += 1) {
        drop.add(list[k]!);
        drop.add(back[k]!);
      }
    }
    // The merged vertices' neighbours face a new way.
    for (let t = 0; t < p.indices.length; t += 3) {
      const tri = [p.indices[t]!, p.indices[t + 1]!, p.indices[t + 2]!];
      if (tri.some((v) => ws.has(topo.weldOf[v]!))) for (const v of tri) r.touched.add(v);
    }
    keepTriangles(r, drop);
    next.set(i, r.build(true));
  });
  return withPrimitives(mesh, next);
}

// --- Delete ----------------------------------------------------------------------

/** The loops of directed weld edges (a → b) that no triangle pairs, each with the vertex its triangle uses at a. */
function openLoops(p: MeshPrimitive, topo: PrimitiveTopology, triangles: readonly number[]): { welds: number[]; vertices: number[]; edges: string[] }[] {
  const directed = new Map<string, number>(); // "a>b" → the vertex at a
  for (const t of triangles) {
    for (let c = 0; c < 3; c += 1) {
      const va = p.indices[t * 3 + c]!, vb = p.indices[t * 3 + ((c + 1) % 3)]!;
      directed.set(`${topo.weldOf[va]}>${topo.weldOf[vb]}`, va);
    }
  }
  const next = new Map<number, { to: number; vertex: number; edge: string }>();
  for (const [k, v] of directed) {
    const [a, b] = k.split(">").map(Number) as [number, number];
    if (!directed.has(`${b}>${a}`) && !next.has(a)) next.set(a, { to: b, vertex: v, edge: k });
  }
  const loops: { welds: number[]; vertices: number[]; edges: string[] }[] = [];
  const used = new Set<number>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop = { welds: [] as number[], vertices: [] as number[], edges: [] as string[] };
    let at: number | undefined = start;
    while (at !== undefined && !used.has(at)) {
      used.add(at);
      const step: { to: number; vertex: number; edge: string } | undefined = next.get(at);
      if (!step) break;
      loop.welds.push(at);
      loop.vertices.push(step.vertex);
      loop.edges.push(step.edge);
      at = step.to;
    }
    if (at === start && loop.welds.length >= 3) loops.push(loop);
  }
  return loops;
}

/**
 * Delete the selection — the triangles touching the selected welds, the faces
 * either side of the selected edges, or the selected faces — and fill each
 * hole that leaves with a face, so the mesh stays closed. A whole piece
 * selected (see {@link selectLinked}) simply goes. The fill takes the
 * attributes (and weights) of the vertices around it.
 */
export function deleteSelection(mesh: MeshAsset, selection: MeshSelection): MeshAsset {
  const next = new Map<number, MeshPrimitive>();
  const welds = selection.mode === "vertex" ? selectionWelds(mesh, selection) : null;
  mesh.primitives.forEach((p, i) => {
    const ids = selection.parts[i] ?? [];
    if (ids.length === 0) return;
    const topo = primitiveTopology(p);
    const drop = new Set<number>();
    if (selection.mode === "vertex") {
      const ws = welds![i]!;
      for (let t = 0; t < p.indices.length / 3; t += 1) if ([0, 1, 2].some((c) => ws.has(topo.weldOf[p.indices[t * 3 + c]!]!))) drop.add(t);
    } else {
      const faces = selection.mode === "face" ? ids : ids.flatMap((e) => topo.edges[e]?.faces ?? []);
      for (const f of faces) for (const t of topo.faces[f]?.triangles ?? []) drop.add(t);
    }
    if (drop.size === 0) return;
    const all = Array.from({ length: p.indices.length / 3 }, (_, t) => t);
    const before = new Set(openLoops(p, topo, all).flatMap((l) => l.edges));
    const kept = all.filter((t) => !drop.has(t));
    const r = new Rebuild(p);
    keepTriangles(r, drop);
    for (const loop of openLoops(p, topo, kept)) {
      if (loop.edges.every((e) => before.has(e))) continue; // a hole the mesh already had
      // The fill runs the other way round the hole.
      emitPolygon(r, [...loop.vertices].reverse());
    }
    if (r.tris.length === 0) {
      // Everything went: an empty primitive can't be stored, so it keeps nothing but stays valid.
      next.set(i, { ...p, positions: new Float32Array(0), normals: p.normals ? new Float32Array(0) : null, uvs: p.uvs ? new Float32Array(0) : null, indices: new Uint32Array(0) });
      return;
    }
    next.set(i, r.build(true));
  });
  const edited = withPrimitives(mesh, next);
  // Primitives emptied by the delete leave the mesh (with their material sets' entries).
  const keep = edited.primitives.map((p) => p.indices.length > 0);
  if (keep.every(Boolean) || !keep.some(Boolean)) return keep.some(Boolean) ? edited : mesh;
  return {
    ...edited,
    primitives: edited.primitives.filter((_, i) => keep[i]),
    ...(edited.variants ? { variants: edited.variants.map((v) => ({ ...v, materials: v.materials.filter((_, i) => keep[i]) })) } : {}),
  };
}

// --- Loop cut ------------------------------------------------------------------

/**
 * Cut a new edge loop across the ring of quads an edge runs across (see
 * {@link loopSelect}), `factor` of the way along each crossed edge from the
 * edge's first weld's side. Each quad becomes two; a face where the ring
 * stops takes the new vertex on its side, so the mesh stays closed.
 */
export function loopCut(mesh: MeshAsset, primitive: number, edge: number, factor = 0.5): MeshAsset {
  const p = mesh.primitives[primitive];
  if (!p) return mesh;
  const topo = primitiveTopology(p);
  if (!topo.edges[edge]) return mesh;
  const t = Math.max(0.01, Math.min(0.99, factor));
  const { faces: ring, cuts } = faceRing(topo, edge);
  const r = new Rebuild(p);
  const ringFaces = new Set(ring.map((f) => f.face));
  const drop = new Set<number>();
  // A new vertex on a cut edge, from one face's own vertices at its ends.
  const cutPoint = (e: number, vertexAt: (w: number) => number) => {
    const { left, right } = cuts.get(e)!;
    const at = weldPosition(topo, left).map((v, k) => v * (1 - t) + topo.weldPositions[right * 3 + k]! * t);
    return r.blend([[vertexAt(left), 1 - t], [vertexAt(right), t]], at);
  };
  for (const { face } of ring) {
    const f = topo.faces[face]!;
    for (const tri of f.triangles) drop.add(tri);
    const vertexAt = (w: number) => f.corners[f.loop.indexOf(w)]!;
    // The loop with the two cut points inserted, then split into two quads between them.
    const six: number[] = [];
    const marks: number[] = [];
    for (let k = 0; k < 4; k += 1) {
      const a = f.loop[k]!, b = f.loop[(k + 1) % 4]!;
      six.push(vertexAt(a));
      const e = topo.edgeIndex.get(edgeKey(a, b))!;
      if (cuts.has(e)) {
        marks.push(six.length);
        six.push(cutPoint(e, vertexAt));
      }
    }
    if (marks.length !== 2) {
      // Not crossed side to side (can't happen on a ring): leave the face as it was.
      for (const tri of f.triangles) drop.delete(tri);
      continue;
    }
    const [m1, m2] = marks as [number, number];
    emitPolygon(r, six.slice(m1, m2 + 1));
    emitPolygon(r, [...six.slice(m2), ...six.slice(0, m1 + 1)]);
  }
  // Faces outside the ring that a cut edge borders: split the triangle on that side.
  const splits = new Map<number, (number | undefined)[]>();
  for (const [e, { left, right }] of cuts) {
    for (const face of topo.edges[e]!.faces) {
      if (ringFaces.has(face)) continue;
      for (const tri of topo.faces[face]!.triangles) {
        const corners = [0, 1, 2].map((c) => p.indices[tri * 3 + c]!);
        for (let s = 0; s < 3; s += 1) {
          const wa = topo.weldOf[corners[s]!]!, wb = topo.weldOf[corners[(s + 1) % 3]!]!;
          if (edgeKey(wa, wb) !== edgeKey(left, right)) continue;
          const mids = splits.get(tri) ?? [undefined, undefined, undefined];
          const vertexAt = (w: number) => corners[w === wa ? s : (s + 1) % 3]!;
          mids[s] = cutPoint(e, vertexAt);
          splits.set(tri, mids);
        }
      }
    }
  }
  for (const [tri, mids] of splits) {
    drop.add(tri);
    splitTriangle(r, [p.indices[tri * 3]!, p.indices[tri * 3 + 1]!, p.indices[tri * 3 + 2]!], mids);
  }
  if (ring.length === 0 && splits.size === 0) return mesh;
  // Re-emit the kept triangles first, so untouched geometry keeps its order.
  const added = r.tris.splice(0);
  keepTriangles(r, drop);
  r.tris.push(...added);
  return withPrimitives(mesh, new Map([[primitive, r.build(true)]]));
}

// --- Subdivide -----------------------------------------------------------------

/** Whether a polygon (positions, counter-clockwise about `normal`) is convex. */
function convex(points: readonly Vec3[], normal: Vec3): boolean {
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!, b = points[(i + 1) % points.length]!, c = points[(i + 2) % points.length]!;
    if (dot(cross(sub(b, a), sub(c, b)), normal) < -1e-12) return false;
  }
  return true;
}

/**
 * Subdivide the selected faces (in vertex and edge modes, those whose every
 * corner is selected): each convex face becomes a quad per corner, around a
 * new vertex at its centre, with new vertices halfway along its sides; any
 * other face splits each triangle in four. Neighbouring faces take the new
 * vertices on their shared sides, so the mesh stays closed.
 */
export function subdivideSelection(mesh: MeshAsset, selection: MeshSelection): MeshAsset {
  const faceSets = selectionFaces(mesh, selection);
  const next = new Map<number, MeshPrimitive>();
  mesh.primitives.forEach((p, i) => {
    const selected = faceSets[i]!;
    if (selected.size === 0) return;
    const topo = primitiveTopology(p);
    const r = new Rebuild(p);
    const drop = new Set<number>();
    // Sides to split (by welds), and the faces that subdivide by triangle.
    const splitEdges = new Set<string>();
    const byTriangle = new Set<number>();
    const polygons: number[] = [];
    for (const f of selected) {
      const face = topo.faces[f]!;
      for (const tri of face.triangles) drop.add(tri);
      const points = face.loop.map((w) => weldPosition(topo, w));
      for (const loop of face.loops) for (let k = 0; k < loop.length; k += 1) splitEdges.add(edgeKey(loop[k]!, loop[(k + 1) % loop.length]!));
      if (face.loops.length === 1 && face.loop.length >= 3 && convex(points, face.normal)) polygons.push(f);
      else {
        for (const tri of face.triangles) {
          byTriangle.add(tri);
          for (let c = 0; c < 3; c += 1) splitEdges.add(edgeKey(topo.weldOf[p.indices[tri * 3 + c]!]!, topo.weldOf[p.indices[tri * 3 + ((c + 1) % 3)]!]!));
        }
      }
    }
    const midpoint = (va: number, vb: number) => {
      const wa = topo.weldOf[va]!, wb = topo.weldOf[vb]!;
      // Halfway between the welds' own positions, the same from either side.
      const [lo, hi] = wa < wb ? [wa, wb] : [wb, wa];
      const at = weldPosition(topo, lo).map((v, k) => (v + topo.weldPositions[hi * 3 + k]!) / 2);
      return r.blend([[va, 0.5], [vb, 0.5]], at);
    };
    for (const f of polygons) {
      const face = topo.faces[f]!;
      const n = face.loop.length;
      const c = face.corners;
      const mids = c.map((v, k) => midpoint(v, c[(k + 1) % n]!));
      const centrePos = face.loop.reduce<Vec3>((s, w) => [s[0] + topo.weldPositions[w * 3]! / n, s[1] + topo.weldPositions[w * 3 + 1]! / n, s[2] + topo.weldPositions[w * 3 + 2]! / n], [0, 0, 0]);
      const centre = r.blend(c.map((v) => [v, 1 / n] as const), centrePos);
      for (let k = 0; k < n; k += 1) emitPolygon(r, [c[k]!, mids[k]!, centre, mids[(k + n - 1) % n]!]);
    }
    // Every other triangle with a split side (the faces subdivided by triangle, and the neighbours).
    const midOf = new Map<string, number>(); // per face and side, so a face's triangles share their new vertices
    for (let t = 0; t < p.indices.length / 3; t += 1) {
      if (drop.has(t) && !byTriangle.has(t)) continue;
      const corners = [p.indices[t * 3]!, p.indices[t * 3 + 1]!, p.indices[t * 3 + 2]!] as [number, number, number];
      const mids = [0, 1, 2].map((s) => {
        const key = edgeKey(topo.weldOf[corners[s]!]!, topo.weldOf[corners[(s + 1) % 3]!]!);
        if (!splitEdges.has(key)) return undefined;
        const own = `${topo.faceOfTriangle[t]}:${key}`;
        let m = midOf.get(own);
        if (m === undefined) {
          m = midpoint(corners[s]!, corners[(s + 1) % 3]!);
          midOf.set(own, m);
        }
        return m;
      });
      if (mids.every((m) => m === undefined)) continue;
      drop.add(t);
      splitTriangle(r, corners, mids);
    }
    const added = r.tris.splice(0);
    keepTriangles(r, drop);
    r.tris.push(...added);
    next.set(i, r.build(true));
  });
  return withPrimitives(mesh, next);
}

// --- Mirror --------------------------------------------------------------------

/** The joint a mirrored part rides: `x_l` ↔ `x_r`, `x.L` ↔ `x.R`, `LeftX` ↔ `RightX`; itself when there is none. */
export function mirroredJoints(skin: MeshSkin | null | undefined): number[] {
  const joints = skin?.joints ?? [];
  const byName = new Map(joints.map((j, k) => [j.name, k]));
  const swaps: [RegExp, (m: string) => string][] = [
    [/_l$/, () => "_r"],
    [/_r$/, () => "_l"],
    [/_L$/, () => "_R"],
    [/_R$/, () => "_L"],
    [/\.L$/, () => ".R"],
    [/\.R$/, () => ".L"],
    [/Left/, () => "Right"],
    [/Right/, () => "Left"],
    [/left/, () => "right"],
    [/right/, () => "left"],
  ];
  return joints.map((j, k) => {
    for (const [re, to] of swaps) {
      if (!re.test(j.name)) continue;
      const other = byName.get(j.name.replace(re, to));
      if (other !== undefined) return other;
    }
    return k;
  });
}

/**
 * Mirror the pieces the selection touches (whole connected shells) across the
 * plane where `axis` is `origin` (default 0: the model's centre line). With
 * `duplicate` a mirrored copy is added and the original kept — the other
 * shoulder plate; without, the piece itself flips over. Mirrored triangles
 * turn round, so they still face out; mirrored vertices ride the mirrored
 * joints.
 */
export function mirrorSelection(mesh: MeshAsset, selection: MeshSelection, axis: 0 | 1 | 2, options: { readonly duplicate?: boolean; readonly origin?: number } = {}): MeshAsset {
  const welds = selectionWelds(mesh, selection);
  const origin = options.origin ?? 0;
  const jointMap = mirroredJoints(mesh.skin);
  const next = new Map<number, MeshPrimitive>();
  mesh.primitives.forEach((p, i) => {
    const ws = welds[i]!;
    if (ws.size === 0) return;
    const shells = primitiveShells(p);
    const picked = new Set([...ws].map((w) => shells.shellOfWeld[w]!));
    const r = new Rebuild(p);
    const mirrorVertex = (v: number, target: number) => {
      r.pos[target * 3 + axis] = 2 * origin - r.pos[v * 3 + axis]!;
      if (r.nrm) r.nrm[target * 3 + axis] = -r.nrm[v * 3 + axis]!;
      if (r.jnt && r.wgt) {
        for (let k = 0; k < 4; k += 1) {
          r.jnt[target * 4 + k] = jointMap[r.jnt[v * 4 + k]!] ?? r.jnt[v * 4 + k]!;
          r.wgt[target * 4 + k] = r.wgt[v * 4 + k]!;
        }
      }
    };
    const copyOf = new Map<number, number>();
    const target = (v: number) => {
      if (!options.duplicate) return v;
      let c = copyOf.get(v);
      if (c === undefined) {
        c = r.copy(v);
        r.touched.delete(c);
        copyOf.set(v, c);
      }
      return c;
    };
    const flipped = new Set<number>();
    const added: number[] = [];
    for (let t = 0; t < p.indices.length / 3; t += 1) {
      if (!picked.has(shells.shellOfTriangle[t]!)) continue;
      const [a, b, c] = [0, 1, 2].map((k) => target(p.indices[t * 3 + k]!)) as [number, number, number];
      added.push(a, c, b); // turned round
      flipped.add(t);
    }
    const moved = options.duplicate ? [...copyOf.entries()] : [...new Set([...flipped].flatMap((t) => [0, 1, 2].map((k) => p.indices[t * 3 + k]!)))].map((v) => [v, v] as const);
    for (const [v, to] of moved) mirrorVertex(v, to);
    keepTriangles(r, options.duplicate ? new Set() : flipped);
    r.tris.push(...added);
    next.set(i, r.build(false));
  });
  return withPrimitives(mesh, next);
}

// --- Add primitive ---------------------------------------------------------------

export type ShapeKind = "cube" | "cylinder" | "cone" | "sphere";
export const SHAPE_KINDS: readonly ShapeKind[] = ["cube", "cylinder", "cone", "sphere"];

export interface ShapeSpec {
  readonly kind: ShapeKind;
  readonly center: readonly [number, number, number];
  /** Edge length of a cube; diameter and height of the others. */
  readonly size: number;
  /** Sides round a cylinder, cone or sphere (default 12). */
  readonly segments?: number;
}

/** A shape's faces as polygons of positions, counter-clockwise seen from outside. */
export function shapePolygons(spec: ShapeSpec): Vec3[][] {
  const [cx, cy, cz] = spec.center;
  const h = Math.max(1e-4, spec.size) / 2;
  const n = Math.max(3, Math.min(64, Math.round(spec.segments ?? 12)));
  const ring = (y: number, radius: number) => Array.from({ length: n }, (_, k) => [cx + radius * Math.cos((2 * Math.PI * k) / n), y, cz - radius * Math.sin((2 * Math.PI * k) / n)] as Vec3);
  if (spec.kind === "cube") {
    const c = (x: number, y: number, z: number): Vec3 => [cx + x * h, cy + y * h, cz + z * h];
    return [
      [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)], // +z
      [c(1, -1, -1), c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1)], // −z
      [c(1, -1, 1), c(1, -1, -1), c(1, 1, -1), c(1, 1, 1)], // +x
      [c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1)], // −x
      [c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1), c(-1, 1, -1)], // +y
      [c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)], // −y
    ];
  }
  if (spec.kind === "cylinder" || spec.kind === "cone") {
    const bottom = ring(cy - h, h);
    const out: Vec3[][] = [[...bottom].reverse()];
    if (spec.kind === "cylinder") {
      const top = ring(cy + h, h);
      out.push(top);
      for (let k = 0; k < n; k += 1) out.push([bottom[k]!, bottom[(k + 1) % n]!, top[(k + 1) % n]!, top[k]!]);
    } else {
      const apex: Vec3 = [cx, cy + h, cz];
      for (let k = 0; k < n; k += 1) out.push([bottom[k]!, bottom[(k + 1) % n]!, apex]);
    }
    return out;
  }
  // A UV sphere: n sides, n/2 bands, triangles at the poles.
  const bands = Math.max(2, Math.round(n / 2));
  const at = (band: number, k: number): Vec3 => {
    const phi = (Math.PI * band) / bands;
    const theta = (2 * Math.PI * k) / n;
    return [cx + h * Math.sin(phi) * Math.cos(theta), cy + h * Math.cos(phi), cz - h * Math.sin(phi) * Math.sin(theta)];
  };
  const out: Vec3[][] = [];
  for (let band = 0; band < bands; band += 1) {
    for (let k = 0; k < n; k += 1) {
      const k1 = (k + 1) % n;
      if (band === 0) out.push([at(0, 0), at(1, k), at(1, k1)]);
      else if (band === bands - 1) out.push([at(band, k), at(bands, 0), at(band, k1)]);
      else out.push([at(band, k), at(band + 1, k), at(band + 1, k1), at(band, k1)]);
    }
  }
  return out;
}

/**
 * Add a closed shape to a primitive, as a piece of its own. On a skinned mesh
 * it rides the joints of the three vertices nearest its centre (blended by
 * nearness), or wholly `joint` when given — so a crest added to the helmet
 * turns with the head.
 */
export function addShape(mesh: MeshAsset, primitive: number, spec: ShapeSpec, joint?: number): MeshAsset {
  const p = mesh.primitives[primitive];
  if (!p) return mesh;
  const polygons = shapePolygons(spec);
  const r = new Rebuild(p);
  keepTriangles(r, new Set());
  const base = p.positions.length / 3;
  // The influences every new vertex takes.
  let influence: { joints: number[]; weights: number[] } | null = null;
  if (r.jnt && r.wgt) {
    if (joint !== undefined && mesh.skin && joint >= 0 && joint < mesh.skin.joints.length) influence = { joints: [joint, 0, 0, 0], weights: [1, 0, 0, 0] };
    else {
      const near = Array.from({ length: base }, (_, v) => [v, Math.hypot(p.positions[v * 3]! - spec.center[0], p.positions[v * 3 + 1]! - spec.center[1], p.positions[v * 3 + 2]! - spec.center[2])] as const)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 3);
      const inv = near.map(([v, d]) => [v, 1 / Math.max(1e-6, d)] as const);
      const total = inv.reduce((s, [, w]) => s + w, 0);
      influence = blendInfluences(r.jnt, r.wgt, inv.map(([v, w]) => [v, w / total] as const));
    }
  }
  const size = Math.max(1e-4, spec.size);
  for (const polygon of polygons) {
    const normal = normalize(cross(sub(polygon[1]!, polygon[0]!), sub(polygon[2]!, polygon[0]!)));
    const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
    const corners = polygon.map((pos) => {
      const v = r.pos.length / 3;
      r.pos.push(...pos);
      r.nrm?.push(...normal);
      if (r.uv) {
        // Planar coordinates across the shape, along the face's own axis.
        const d = sub(pos, spec.center);
        const [u, w] = ax >= ay && ax >= az ? [d[2], d[1]] : ay >= az ? [d[0], d[2]] : [d[0], d[1]];
        r.uv.push(0.5 + u / size, 0.5 + w / size);
      }
      r.uv2?.push(0, 0);
      r.blendW?.push(0);
      if (r.jnt && r.wgt) {
        r.jnt.push(...influence!.joints);
        r.wgt.push(...influence!.weights);
      }
      return v;
    });
    for (const [a, b, c] of triangulate(polygon)) r.tri(corners[a]!, corners[b]!, corners[c]!);
  }
  return withPrimitives(mesh, new Map([[primitive, r.build(true)]]));
}

// --- Gizmo -----------------------------------------------------------------------

/**
 * How far a drag along one axis of the gizmo moves, turns or scales: `drag`
 * is the pointer's travel in NDC, `length` the axis handle's length in world
 * units. Moves follow the pointer along the axis as drawn; a turn is a
 * quarter turn for every half-screen dragged across the axis; a scale grows
 * by the handle's length dragged.
 */
export function gizmoDrag(
  viewProj: ArrayLike<number>,
  pivot: readonly number[],
  axis: 0 | 1 | 2,
  tool: "move" | "rotate" | "scale",
  drag: readonly [number, number],
  length: number,
): SelectionTransform | null {
  const tip: Vec3 = [pivot[0]!, pivot[1]!, pivot[2]!];
  tip[axis] += length;
  const a = projectPoint(viewProj, pivot), b = projectPoint(viewProj, tip);
  if (!a || !b) return null;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const screen = Math.hypot(dx, dy);
  if (tool === "rotate") {
    // Across the axis as drawn (or sideways when it points at the eye).
    const [px, py] = screen > 1e-4 ? [-dy / screen, dx / screen] : [1, 0];
    return { kind: "rotate", axis, angle: ((drag[0] * px + drag[1] * py) * Math.PI) / 2 };
  }
  if (screen < 1e-4) return null;
  const along = (drag[0] * dx + drag[1] * dy) / (screen * screen); // in handle lengths
  if (tool === "move") {
    const offset: Vec3 = [0, 0, 0];
    offset[axis] = along * length;
    return { kind: "move", offset };
  }
  const factor: Vec3 = [1, 1, 1];
  factor[axis] = Math.max(0.01, 1 + along);
  return { kind: "scale", factor };
}
