/**
 * Constructive solid geometry (EDITOR_PRO_ROADMAP.md P5), after Unreal's BSP
 * brushes and ProBuilder's booleans: add one solid to another, cut one out of
 * another (a doorway, a window, a cave mouth), or keep only where they
 * overlap.
 *
 * The booleans are Evan Wallace's csg.js algorithm: each solid becomes a BSP
 * tree of its polygons, each tree clips away the other's polygons that lie
 * inside (or outside) it, and what's left is gathered into the result. Normals
 * and UVs are carried through every split.
 *
 * Booleans leave T-junctions (a vertex of one face in the middle of a
 * neighbour's edge), which leave cracks a renderer can show and which no
 * closed mesh may have, so the result is mended: every such vertex is put
 * into the edge it lies on, and positions are snapped to the grid the mesh
 * tools weld on. A closed input gives a closed, consistently wound output
 * (see meshClosure). Pure and DOM-free.
 */

import type { MeshAsset, MeshMaterial, MeshPrimitive } from "./MeshAsset";

type V3 = [number, number, number];

/** How close to a plane a point counts as on it. */
const EPSILON = 1e-5;
/** Positions are snapped to this grid (the mesh tools weld at 1e-4). */
const SNAP = 1e-5;

interface Vertex {
  readonly p: V3;
  readonly n: V3;
  readonly uv: readonly [number, number];
}

interface Plane {
  readonly n: V3;
  readonly w: number;
}

interface Polygon {
  readonly vertices: readonly Vertex[];
  readonly plane: Plane;
  /** Which material (an index into the combined material list) it carries. */
  readonly material: number;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerpV = (a: Vertex, b: Vertex, t: number): Vertex => ({
  p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t],
  n: [a.n[0] + (b.n[0] - a.n[0]) * t, a.n[1] + (b.n[1] - a.n[1]) * t, a.n[2] + (b.n[2] - a.n[2]) * t],
  uv: [a.uv[0] + (b.uv[0] - a.uv[0]) * t, a.uv[1] + (b.uv[1] - a.uv[1]) * t],
});
const flipV = (v: Vertex): Vertex => ({ p: v.p, n: [-v.n[0], -v.n[1], -v.n[2]], uv: v.uv });

function planeOf(a: V3, b: V3, c: V3): Plane | null {
  const n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(n[0], n[1], n[2]);
  if (!(l > 1e-12)) return null;
  const u: V3 = [n[0] / l, n[1] / l, n[2] / l];
  return { n: u, w: dot(u, a) };
}

function flipPolygon(p: Polygon): Polygon {
  return { vertices: [...p.vertices].reverse().map(flipV), plane: { n: [-p.plane.n[0], -p.plane.n[1], -p.plane.n[2]], w: -p.plane.w }, material: p.material };
}

const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

/** Split a polygon by a plane into the four lists (csg.js's Plane.splitPolygon). */
function splitPolygon(plane: Plane, polygon: Polygon, coplanarFront: Polygon[], coplanarBack: Polygon[], front: Polygon[], back: Polygon[]): void {
  let type = 0;
  const types: number[] = [];
  for (const v of polygon.vertices) {
    const t = dot(plane.n, v.p) - plane.w;
    const kind = t < -EPSILON ? BACK : t > EPSILON ? FRONT : COPLANAR;
    type |= kind;
    types.push(kind);
  }
  switch (type) {
    case COPLANAR:
      (dot(plane.n, polygon.plane.n) > 0 ? coplanarFront : coplanarBack).push(polygon);
      break;
    case FRONT:
      front.push(polygon);
      break;
    case BACK:
      back.push(polygon);
      break;
    default: {
      const f: Vertex[] = [];
      const b: Vertex[] = [];
      const vs = polygon.vertices;
      for (let i = 0; i < vs.length; i += 1) {
        const j = (i + 1) % vs.length;
        const ti = types[i]!, tj = types[j]!;
        const vi = vs[i]!, vj = vs[j]!;
        if (ti !== BACK) f.push(vi);
        if (ti !== FRONT) b.push(ti !== BACK ? vi : vi);
        if ((ti | tj) === SPANNING) {
          const t = (plane.w - dot(plane.n, vi.p)) / dot(plane.n, sub(vj.p, vi.p));
          const v = lerpV(vi, vj, t);
          f.push(v);
          b.push(v);
        }
      }
      if (f.length >= 3) front.push({ vertices: f, plane: polygon.plane, material: polygon.material });
      if (b.length >= 3) back.push({ vertices: b, plane: polygon.plane, material: polygon.material });
    }
  }
}

/** A BSP tree node (csg.js's Node). */
class Node {
  plane: Plane | null = null;
  front: Node | null = null;
  back: Node | null = null;
  polygons: Polygon[] = [];

  constructor(polygons?: readonly Polygon[]) {
    if (polygons) this.build(polygons);
  }

  invert(): void {
    // Iterative, so a deep tree can't overflow the stack.
    const stack: Node[] = [this];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.polygons = node.polygons.map(flipPolygon);
      if (node.plane) node.plane = { n: [-node.plane.n[0], -node.plane.n[1], -node.plane.n[2]], w: -node.plane.w };
      const t = node.front;
      node.front = node.back;
      node.back = t;
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
  }

  /** The polygons of `polygons` outside this tree's solid. */
  clipPolygons(polygons: readonly Polygon[]): Polygon[] {
    if (!this.plane) return [...polygons];
    let front: Polygon[] = [];
    let back: Polygon[] = [];
    for (const p of polygons) splitPolygon(this.plane, p, front, back, front, back);
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  }

  /** Remove from this tree everything inside `bsp`. */
  clipTo(bsp: Node): void {
    const stack: Node[] = [this];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.polygons = bsp.clipPolygons(node.polygons);
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
  }

  allPolygons(): Polygon[] {
    const out: Polygon[] = [];
    const stack: Node[] = [this];
    while (stack.length > 0) {
      const node = stack.pop()!;
      out.push(...node.polygons);
      if (node.front) stack.push(node.front);
      if (node.back) stack.push(node.back);
    }
    return out;
  }

  build(polygons: readonly Polygon[]): void {
    // Iterative: a work list of (node, polygons to place in it).
    const work: [Node, readonly Polygon[]][] = [[this, polygons]];
    while (work.length > 0) {
      const [node, list] = work.pop()!;
      if (list.length === 0) continue;
      if (!node.plane) node.plane = list[0]!.plane;
      const front: Polygon[] = [];
      const back: Polygon[] = [];
      for (const p of list) splitPolygon(node.plane, p, node.polygons, node.polygons, front, back);
      if (front.length > 0) {
        node.front ??= new Node();
        work.push([node.front, front]);
      }
      if (back.length > 0) {
        node.back ??= new Node();
        work.push([node.back, back]);
      }
    }
  }
}

// --- Meshes in and out -------------------------------------------------------------------

export type CsgOp = "union" | "subtract" | "intersect";

/** A column-major 4×4 transform. */
export type CsgMatrix = ArrayLike<number>;

/** A mesh's triangles as polygons, transformed by `model`, each primitive's material numbered by `slots`. */
function polygonsOf(mesh: MeshAsset, slots: readonly number[], model?: CsgMatrix): Polygon[] {
  const out: Polygon[] = [];
  const m = model;
  const point = (x: number, y: number, z: number): V3 =>
    m ? [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!] : [x, y, z];
  const dir = (x: number, y: number, z: number): V3 => {
    // Normals by the inverse-transpose; for the rotations and scales kit pieces use, the linear part's cofactors.
    if (!m) return [x, y, z];
    const a = [m[0]!, m[1]!, m[2]!], b = [m[4]!, m[5]!, m[6]!], c = [m[8]!, m[9]!, m[10]!];
    const r0 = cross(b as V3, c as V3), r1 = cross(c as V3, a as V3), r2 = cross(a as V3, b as V3);
    const n: V3 = [r0[0] * x + r1[0] * y + r2[0] * z, r0[1] * x + r1[1] * y + r2[1] * z, r0[2] * x + r1[2] * y + r2[2] * z];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  mesh.primitives.forEach((prim, k) => {
    const P = prim.positions, N = prim.normals, U = prim.uvs;
    const vertex = (i: number): Vertex => ({
      p: point(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!),
      n: N ? dir(N[i * 3]!, N[i * 3 + 1]!, N[i * 3 + 2]!) : [0, 1, 0],
      uv: U ? [U[i * 2]!, U[i * 2 + 1]!] : [0, 0],
    });
    for (let t = 0; t < prim.indices.length; t += 3) {
      const vs = [vertex(prim.indices[t]!), vertex(prim.indices[t + 1]!), vertex(prim.indices[t + 2]!)];
      const plane = planeOf(vs[0]!.p, vs[1]!.p, vs[2]!.p);
      if (plane) out.push({ vertices: vs, plane, material: slots[k]! });
    }
  });
  return out;
}

const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const keyOf = (p: V3) => `${Math.round(p[0] / SNAP)},${Math.round(p[1] / SNAP)},${Math.round(p[2] / SNAP)}`;

/**
 * Mend T-junctions: every vertex lying inside another polygon's edge is put
 * into that edge, so both sides of every edge share the same vertices.
 */
function mendJunctions(polygons: readonly Polygon[]): Polygon[] {
  // The distinct points, bucketed on a coarse grid so each edge only checks its neighbourhood.
  const points = new Map<string, V3>();
  for (const poly of polygons) for (const v of poly.vertices) points.set(keyOf(v.p), v.p);
  const cell = 0.5;
  const grid = new Map<string, V3[]>();
  const cellKey = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (const p of points.values()) {
    const k = cellKey(p[0], p[1], p[2]);
    const list = grid.get(k);
    if (list) list.push(p);
    else grid.set(k, [p]);
  }
  const near = (a: V3, b: V3): V3[] => {
    const out: V3[] = [];
    const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])].map((v) => Math.floor((v - EPSILON) / cell));
    const hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])].map((v) => Math.floor((v + EPSILON) / cell));
    for (let x = lo[0]!; x <= hi[0]!; x += 1) for (let y = lo[1]!; y <= hi[1]!; y += 1) for (let z = lo[2]!; z <= hi[2]!; z += 1) out.push(...(grid.get(`${x},${y},${z}`) ?? []));
    return out;
  };
  return polygons.map((poly) => {
    const vs = poly.vertices;
    const mended: Vertex[] = [];
    for (let i = 0; i < vs.length; i += 1) {
      const a = vs[i]!, b = vs[(i + 1) % vs.length]!;
      mended.push(a);
      const d = sub(b.p, a.p);
      const len2 = dot(d, d);
      if (!(len2 > 0)) continue;
      const inside: { t: number; p: V3 }[] = [];
      for (const p of near(a.p, b.p)) {
        const t = dot(sub(p, a.p), d) / len2;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        const q: V3 = [a.p[0] + d[0] * t, a.p[1] + d[1] * t, a.p[2] + d[2] * t];
        if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < EPSILON * 10) inside.push({ t, p });
      }
      inside.sort((x, y) => x.t - y.t);
      for (const { t, p } of inside) mended.push({ ...lerpV(a, b, t), p });
    }
    return { ...poly, vertices: mended };
  });
}

/**
 * Fan-triangulate a convex polygon that may carry extra vertices along its
 * edges (the mended T-junctions). The fan starts at a true corner — and, of
 * those, the one with the fewest such vertices on its two edges — so as few
 * triangles as possible are slivers of no area (which a later boolean would
 * drop). Every edge of the ring is still used exactly once.
 */
function fan(ring: readonly number[], positions: readonly number[]): [number, number, number][] {
  const at = (i: number): V3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
  const n = ring.length;
  const corner = (k: number) => {
    const c = cross(sub(at(ring[k]!), at(ring[(k + n - 1) % n]!)), sub(at(ring[(k + 1) % n]!), at(ring[k]!)));
    return Math.hypot(c[0], c[1], c[2]) > 1e-12;
  };
  const corners = Array.from({ length: n }, (_, k) => k).filter(corner);
  // How many edge vertices lie along the run from corner k to the next corner, and from the previous one.
  const run = (k: number, step: number) => {
    let count = 0;
    for (let j = (k + step + n) % n; !corners.includes(j) && count < n; j = (j + step + n) % n) count += 1;
    return count;
  };
  const start = corners.length > 0 ? corners.reduce((best, k) => (run(k, 1) + run(k, -1) < run(best, 1) + run(best, -1) ? k : best), corners[0]!) : 0;
  const out: [number, number, number][] = [];
  for (let i = 1; i + 1 < n; i += 1) out.push([ring[start]!, ring[(start + i) % n]!, ring[(start + i + 1) % n]!]);
  return out;
}

/** Polygons back into primitives, one per material, fan-triangulated, positions snapped and shared vertices welded. */
function meshOf(polygons: readonly Polygon[], materials: readonly MeshMaterial[], name: string): MeshAsset {
  const groups = new Map<number, Polygon[]>();
  for (const p of polygons) {
    const list = groups.get(p.material);
    if (list) list.push(p);
    else groups.set(p.material, [p]);
  }
  const primitives: MeshPrimitive[] = [];
  for (const [material, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const weld = new Map<string, number>();
    const index = (v: Vertex): number => {
      const p: V3 = [snap(v.p[0]), snap(v.p[1]), snap(v.p[2])];
      const l = Math.hypot(v.n[0], v.n[1], v.n[2]) || 1;
      const key = `${keyOf(p)}|${Math.round((v.n[0] / l) * 1e3)},${Math.round((v.n[1] / l) * 1e3)},${Math.round((v.n[2] / l) * 1e3)}|${Math.round(v.uv[0] * 1e4)},${Math.round(v.uv[1] * 1e4)}`;
      let k = weld.get(key);
      if (k === undefined) {
        k = positions.length / 3;
        weld.set(key, k);
        positions.push(...p);
        normals.push(v.n[0] / l, v.n[1] / l, v.n[2] / l);
        uvs.push(v.uv[0], v.uv[1]);
      }
      return k;
    };
    for (const poly of list) {
      const ids = poly.vertices.map(index);
      // Drop repeats the snapping made (a sliver's two ends on one grid point).
      const ring = ids.filter((id, i) => keyOf(positions.slice(id * 3, id * 3 + 3) as V3) !== keyOf(positions.slice(ids[(i + 1) % ids.length]! * 3, ids[(i + 1) % ids.length]! * 3 + 3) as V3));
      for (const tri of fan(ring, positions)) indices.push(...tri);
    }
    if (indices.length === 0) continue;
    primitives.push({ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material: materials[material]! });
  }
  return { name, primitives };
}

/**
 * A boolean of two solids: `b` (placed in `a`'s space by `bModel`) added to,
 * cut out of, or intersected with `a`. Each face keeps its own material —
 * except, when `cutMaterial` is "a", the faces a cut leaves inside `a` take
 * `a`'s first material, so a doorway looks carved from the wall.
 */
export function csg(a: MeshAsset, b: MeshAsset, op: CsgOp, options: { readonly bModel?: CsgMatrix; readonly cutMaterial?: "a" | "b" } = {}): MeshAsset {
  // One list of materials, the same material (by identity) once, so pieces of one material stay one primitive.
  const materials: MeshMaterial[] = [];
  const indexOf = (m: MeshMaterial): number => {
    const k = materials.indexOf(m);
    if (k >= 0) return k;
    materials.push(m);
    return materials.length - 1;
  };
  const slotsA = a.primitives.map((p) => indexOf(p.material));
  const cutWithA = op === "subtract" && (options.cutMaterial ?? "a") === "a" && slotsA.length > 0;
  const slotsB = b.primitives.map((p) => (cutWithA ? slotsA[0]! : indexOf(p.material)));
  const polysA = polygonsOf(a, slotsA, undefined);
  const polysB = polygonsOf(b, slotsB, options.bModel);
  const A = new Node(polysA);
  const B = new Node(polysB);
  if (op === "union") {
    A.clipTo(B);
    B.clipTo(A);
    B.invert();
    B.clipTo(A);
    B.invert();
    A.build(B.allPolygons());
  } else if (op === "subtract") {
    A.invert();
    A.clipTo(B);
    B.clipTo(A);
    B.invert();
    B.clipTo(A);
    B.invert();
    A.build(B.allPolygons());
    A.invert();
  } else {
    A.invert();
    B.clipTo(A);
    B.invert();
    A.clipTo(B);
    B.clipTo(A);
    A.build(B.allPolygons());
    A.invert();
  }
  return meshOf(mendJunctions(A.allPolygons()), materials, a.name);
}

/**
 * A closed solid from its faces, each a convex polygon given in any winding
 * with the direction it faces out: oriented, UV-projected (on the face's
 * dominant plane, in metres), mended where one face's corner meets the middle
 * of another's edge, and triangulated. For solids that aren't convex
 * (stairs) built straight from their faces rather than by booleans.
 */
export function solidFromFaces(name: string, material: MeshMaterial, faces: readonly { readonly points: readonly (readonly [number, number, number])[]; readonly out: readonly [number, number, number] }[]): MeshAsset {
  const polygons: Polygon[] = [];
  for (const face of faces) {
    let pts = face.points.map((q) => [q[0], q[1], q[2]] as V3);
    let plane = planeOf(pts[0]!, pts[1]!, pts[2]!);
    if (!plane) continue;
    if (dot(plane.n, face.out as V3) < 0) {
      pts = pts.reverse();
      plane = { n: [-plane.n[0], -plane.n[1], -plane.n[2]], w: -plane.w };
    }
    const n = plane.n;
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    polygons.push({ vertices: pts.map((q) => ({ p: q, n, uv: ay >= ax && ay >= az ? [q[0], q[2]] : ax >= az ? [q[2], -q[1]] : [q[0], -q[1]] })), plane, material: 0 });
  }
  return meshOf(mendJunctions(polygons), [material], name);
}

// --- Brushes -----------------------------------------------------------------------------

export type BrushShape = "box" | "cylinder" | "wedge";

/** Faces from corner lists (each counter-clockwise from outside), flat normals, UVs projected on the face's dominant plane in metres. */
function solid(name: string, material: MeshMaterial, faces: readonly (readonly V3[])[]): MeshAsset {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const plane = planeOf(face[0]!, face[1]!, face[2]!);
    if (!plane) continue;
    const ax = Math.abs(plane.n[0]), ay = Math.abs(plane.n[1]), az = Math.abs(plane.n[2]);
    const o = positions.length / 3;
    for (const p of face) {
      positions.push(...p);
      normals.push(...plane.n);
      uvs.push(...(ay >= ax && ay >= az ? [p[0], p[2]] : ax >= az ? [p[2], -p[1]] : [p[0], -p[1]]));
    }
    for (let i = 1; i + 1 < face.length; i += 1) indices.push(o, o + i, o + i + 1);
  }
  return { name, primitives: [{ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material }] };
}

const BRUSH_MATERIAL: MeshMaterial = { name: "brush", baseColorFactor: [0.7, 0.72, 0.75, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 };

/** A box `size` across (x, y, z), centred on the origin. */
export function boxSolid(size: readonly [number, number, number], material: MeshMaterial = BRUSH_MATERIAL): MeshAsset {
  const [x, y, z] = [size[0] / 2, size[1] / 2, size[2] / 2];
  const c = (sx: number, sy: number, sz: number): V3 => [sx * x, sy * y, sz * z];
  return solid("box", material, [
    [c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1)],
    [c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1), c(-1, -1, -1)],
    [c(-1, 1, -1), c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1)],
    [c(-1, -1, 1), c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1)],
    [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)],
    [c(1, -1, -1), c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1)],
  ]);
}

/** A cylinder standing on Y, `size` across (its x and z the ellipse's axes), `sides` around, centred on the origin. */
export function cylinderSolid(size: readonly [number, number, number], sides = 16, material: MeshMaterial = BRUSH_MATERIAL): MeshAsset {
  const n = Math.max(3, Math.min(64, Math.round(sides)));
  const ring = (y: number): V3[] => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * size[0] / 2, y, Math.sin((i / n) * Math.PI * 2) * size[2] / 2] as V3);
  const top = ring(size[1] / 2), bottom = ring(-size[1] / 2);
  const faces: V3[][] = [];
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    faces.push([bottom[i]!, top[i]!, top[j]!, bottom[j]!]);
  }
  faces.push([...top].reverse(), bottom);
  return solid("cylinder", material, faces);
}

/** A wedge: a box's footprint, full height at −X sloping to nothing at +X (a ramp's solid), centred on the origin. */
export function wedgeSolid(size: readonly [number, number, number], material: MeshMaterial = BRUSH_MATERIAL): MeshAsset {
  const [x, y, z] = [size[0] / 2, size[1] / 2, size[2] / 2];
  return solid("wedge", material, [
    [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]],
    [[-x, -y, z], [-x, y, z], [-x, y, -z], [-x, -y, -z]],
    [[-x, y, -z], [-x, y, z], [x, -y, z], [x, -y, -z]],
    [[-x, -y, z], [x, -y, z], [-x, y, z]],
    [[x, -y, -z], [-x, -y, -z], [-x, y, -z]],
  ]);
}

/** A brush solid of a shape and size. */
export function brushSolid(shape: BrushShape, size: readonly [number, number, number], material?: MeshMaterial): MeshAsset {
  return shape === "box" ? boxSolid(size, material) : shape === "cylinder" ? cylinderSolid(size, 16, material) : wedgeSolid(size, material);
}
