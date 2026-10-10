/**
 * Blockout mesh editing (HALO_INFINITE_STYLE_ROADMAP.md I14): extrude, inset
 * and bevel a face of a mesh, in the editor, for blockouts and quick fixes.
 *
 * A "face" is a polygon as a modelling tool shows it: the triangles that
 * share vertices edge to edge and lie in one plane. (Triangles that only meet
 * by position, with their vertices split, are separate faces: that is how a
 * hard edge, or the new faces an edit makes, are told apart even when they
 * are coplanar.) Its boundary is the loop of edges only one of its triangles
 * uses, wound counter-clockwise about the face's normal.
 * - **Extrude** moves the face along its normal and builds walls from the old
 *   boundary to the new one (a negative distance cuts a recess).
 * - **Inset** shrinks the face within its plane, leaving a ring of quads
 *   between the old boundary and the new one.
 * - **Bevel** is an inset whose inner face is also lifted (or sunk), so the
 *   ring slopes: a chamfered edge, or with a negative depth a sunken channel.
 *
 * Edited geometry is flat-shaded with explicit normals (untouched triangles
 * keep theirs). New walls take planar texture coordinates at the face's own
 * texel density, and rings take the face's coordinates. A light map no longer
 * fits an edited mesh, so it is dropped. Skinned primitives aren't edited.
 * Pure and DOM-free.
 */

import type { MeshAsset, MeshPrimitive } from "./MeshAsset";

type Vec3 = [number, number, number];

/** A planar region of a primitive: its triangles (by index), unit normal, centroid and area. */
export interface MeshFace {
  readonly triangles: readonly number[];
  readonly normal: Vec3;
  readonly centroid: Vec3;
  readonly area: number;
}

export type FaceEdit =
  | { readonly kind: "extrude"; readonly distance: number }
  | { readonly kind: "inset"; readonly amount: number }
  | { readonly kind: "bevel"; readonly width: number; readonly depth: number };

/** Two triangles are one face when their normals agree this closely (cosine). */
const COPLANAR_COS = 0.9995;
/** A miter is never longer than this many times the inset (very sharp corners). */
const MAX_MITER = 4;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3) => Math.sqrt(dot(a, a));
const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
};

const vertex = (p: MeshPrimitive, i: number): Vec3 => [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!];
const corners = (p: MeshPrimitive, t: number) => [p.indices[t * 3]!, p.indices[t * 3 + 1]!, p.indices[t * 3 + 2]!] as const;
/** A position's identity, so vertices split for shading still meet. */
const keyOf = (v: Vec3) => `${Math.round(v[0] * 1e4)},${Math.round(v[1] * 1e4)},${Math.round(v[2] * 1e4)}`;

/** A triangle's area-weighted normal (twice its area in length). */
function triangleCross(p: MeshPrimitive, t: number): Vec3 {
  const [a, b, c] = corners(p, t).map((i) => vertex(p, i)) as [Vec3, Vec3, Vec3];
  return cross(sub(b, a), sub(c, a));
}

/** The face a triangle belongs to: it and the coplanar triangles that share its vertices edge to edge. */
export function faceAt(p: MeshPrimitive, triangle: number): MeshFace {
  const count = p.indices.length / 3;
  if (!Number.isInteger(triangle) || triangle < 0 || triangle >= count) return { triangles: [], normal: [0, 1, 0], centroid: [0, 0, 0], area: 0 };
  // Triangles by the edges (vertex pairs, either way round) they use.
  const byEdge = new Map<string, number[]>();
  const edgeKeys = (t: number) => {
    const k = corners(p, t);
    return [0, 1, 2].map((e) => (k[e]! < k[(e + 1) % 3]! ? `${k[e]}|${k[(e + 1) % 3]}` : `${k[(e + 1) % 3]}|${k[e]}`));
  };
  for (let t = 0; t < count; t += 1) for (const e of edgeKeys(t)) byEdge.set(e, [...(byEdge.get(e) ?? []), t]);
  const seedCross = triangleCross(p, triangle);
  const normal = normalize(seedCross);
  const origin = vertex(p, p.indices[triangle * 3]!);
  const extent = Math.max(1e-6, ...corners(p, triangle).map((i) => length(sub(vertex(p, i), origin))));
  const inPlane = (t: number) => {
    const n = normalize(triangleCross(p, t));
    if (dot(n, normal) < COPLANAR_COS) return false;
    return corners(p, t).every((i) => Math.abs(dot(sub(vertex(p, i), origin), normal)) < 1e-4 * Math.max(1, extent));
  };
  const seen = new Set([triangle]);
  const queue = [triangle];
  while (queue.length > 0) {
    const t = queue.pop()!;
    for (const e of edgeKeys(t)) {
      for (const n of byEdge.get(e) ?? []) {
        if (!seen.has(n) && inPlane(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
  }
  const triangles = [...seen].sort((a, b) => a - b);
  let area = 0;
  let centroid: Vec3 = [0, 0, 0];
  for (const t of triangles) {
    const a = length(triangleCross(p, t)) / 2;
    const mid = corners(p, t).reduce<Vec3>((s, i) => add(s, vertex(p, i)), [0, 0, 0]);
    centroid = add(centroid, scale(mid, a / 3));
    area += a;
  }
  return { triangles, normal, centroid: area > 0 ? scale(centroid, 1 / area) : origin, area };
}

/** Every planar face of a primitive. */
export function primitiveFaces(p: MeshPrimitive): MeshFace[] {
  const done = new Set<number>();
  const faces: MeshFace[] = [];
  for (let t = 0; t < p.indices.length / 3; t += 1) {
    if (done.has(t)) continue;
    const face = faceAt(p, t);
    for (const f of face.triangles) done.add(f);
    faces.push(face);
  }
  return faces;
}

/** A face's boundary as loops of positions, counter-clockwise about its normal (for drawing a selection). */
export function faceBoundary(p: MeshPrimitive, triangles: readonly number[]): Vec3[][] {
  const { next, position } = boundaryOf(p, triangles);
  const loops: Vec3[][] = [];
  const used = new Set<string>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop: Vec3[] = [];
    let at: string | undefined = start;
    while (at !== undefined && !used.has(at)) {
      used.add(at);
      loop.push(position.get(at)!);
      at = next.get(at);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** The directed boundary edges of a set of triangles, by position key, with each key's position. */
function boundaryOf(p: MeshPrimitive, triangles: readonly number[]) {
  const directed = new Set<string>();
  const position = new Map<string, Vec3>();
  const edges: [string, string][] = [];
  for (const t of triangles) {
    const k = corners(p, t).map((i) => {
      const v = vertex(p, i);
      const key = keyOf(v);
      position.set(key, v);
      return key;
    });
    for (let e = 0; e < 3; e += 1) {
      const a = k[e]!, b = k[(e + 1) % 3]!;
      directed.add(`${a}>${b}`);
      edges.push([a, b]);
    }
  }
  const next = new Map<string, string>();
  const prev = new Map<string, string>();
  const boundary: [string, string][] = [];
  for (const [a, b] of edges) {
    if (directed.has(`${b}>${a}`)) continue;
    boundary.push([a, b]);
    if (!next.has(a)) next.set(a, b);
    if (!prev.has(b)) prev.set(b, a);
  }
  return { boundary, next, prev, position };
}

/**
 * One face of a primitive edited. `triangles` is the face (see {@link faceAt});
 * the rest of the primitive is kept as it is. Throws for a skinned primitive.
 */
export function editFace(p: MeshPrimitive, triangles: readonly number[], edit: FaceEdit): MeshPrimitive {
  if (p.joints || p.weights) throw new Error("A skinned mesh can't be edited here: edit it in a modelling tool and re-import it.");
  const region = new Set(triangles.filter((t) => Number.isInteger(t) && t >= 0 && t < p.indices.length / 3));
  if (region.size === 0) return p;
  let n: Vec3 = [0, 0, 0];
  for (const t of region) n = add(n, triangleCross(p, t));
  const normal = normalize(n);
  if (length(normal) === 0) return p;

  const inset = edit.kind === "inset" ? edit.amount : edit.kind === "bevel" ? edit.width : 0;
  const lift = edit.kind === "extrude" ? edit.distance : edit.kind === "bevel" ? edit.depth : 0;
  const { boundary, next, prev, position } = boundaryOf(p, [...region]);

  // Where each boundary vertex goes: inward along the miter of its two edges' inward directions.
  const moved = new Map<string, Vec3>();
  for (const [key, v] of position) {
    const before = prev.get(key), after = next.get(key);
    if (inset === 0 || before === undefined || after === undefined) continue;
    const n1 = normalize(cross(normal, normalize(sub(v, position.get(before)!))));
    const n2 = normalize(cross(normal, normalize(sub(position.get(after)!, v))));
    let miter = scale(add(n1, n2), 1 / Math.max(1e-6, 1 + dot(n1, n2)));
    if (length(miter) > MAX_MITER) miter = scale(normalize(miter), MAX_MITER);
    moved.set(key, add(v, scale(miter, inset)));
  }
  const raise = scale(normal, lift);
  const inner = (v: Vec3): Vec3 => add(moved.get(keyOf(v)) ?? v, raise);

  // The output, triangle by triangle, then welded where every attribute agrees.
  const hasUv = p.uvs !== null;
  // Each corner carries its face's tag: corners weld only within a face, so the faces an edit makes stay separate.
  const out: { pos: Vec3; nrm: Vec3; uv: [number, number]; blend: number; group: string }[] = [];
  const attrs = (i: number) => ({
    uv: (hasUv ? [p.uvs![i * 2]!, p.uvs![i * 2 + 1]!] : [0, 0]) as [number, number],
    blend: p.blend ? p.blend[i]! : 0,
  });
  // The face's own attributes at each boundary vertex: a ring's quads take them.
  const atKey = new Map<string, { uv: [number, number]; blend: number }>();
  for (const t of region) for (const i of corners(p, t)) atKey.set(keyOf(vertex(p, i)), attrs(i));
  // Texel density (UV units per unit of length) of the face, for walls' planar coordinates.
  let density = 0;
  let samples = 0;
  if (hasUv) {
    for (const t of region) {
      const [a, b] = corners(p, t);
      const d = length(sub(vertex(p, b), vertex(p, a)));
      if (d > 1e-6) {
        density += Math.hypot(p.uvs![b * 2]! - p.uvs![a * 2]!, p.uvs![b * 2 + 1]! - p.uvs![a * 2 + 1]!) / d;
        samples += 1;
      }
    }
  }
  density = samples > 0 && density > 0 ? density / samples : 1;
  const planarUv = (v: Vec3, faceNormal: Vec3): [number, number] => {
    const ax = Math.abs(faceNormal[0]), ay = Math.abs(faceNormal[1]), az = Math.abs(faceNormal[2]);
    const [u, w] = ax >= ay && ax >= az ? [v[2], v[1]] : ay >= az ? [v[0], v[2]] : [v[0], v[1]];
    return [u * density, w * density];
  };
  const flat = (a: Vec3, b: Vec3, c: Vec3) => normalize(cross(sub(b, a), sub(c, a)));
  const emit = (group: string, tri: [Vec3, Vec3, Vec3], rest: { uv: [number, number]; blend: number }[], nrm?: Vec3) => {
    const facing = nrm ?? flat(...tri);
    if (length(facing) === 0) return; // a collapsed triangle (a zero-width ring)
    tri.forEach((pos, k) => out.push({ pos, nrm: facing, uv: rest[k]!.uv, blend: rest[k]!.blend, group }));
  };

  for (let t = 0; t < p.indices.length / 3; t += 1) {
    const idx = corners(p, t);
    const pos = idx.map((i) => vertex(p, i)) as [Vec3, Vec3, Vec3];
    if (!region.has(t)) {
      // Untouched: its own normals where it has them, else flat.
      const own = p.normals ? idx.map((i) => [p.normals![i * 3]!, p.normals![i * 3 + 1]!, p.normals![i * 3 + 2]!] as Vec3) : null;
      const facing = flat(...pos);
      // Welded only where it was: by its own vertex.
      idx.forEach((i, k) => out.push({ pos: pos[k]!, nrm: own ? own[k]! : facing, ...attrs(i), group: `v${i}` }));
      continue;
    }
    emit("face", pos.map(inner) as [Vec3, Vec3, Vec3], idx.map(attrs), normal);
  }
  for (const [e, [ka, kb]] of boundary.entries()) {
    const a = position.get(ka)!, b = position.get(kb)!;
    const a2 = inner(a), b2 = inner(b);
    if (edit.kind === "extrude") {
      // A wall from the old boundary up (or down) to the moved face.
      const wall = flat(a, b, b2);
      emit(`side${e}`, [a, b, b2], [a, b, b2].map((v) => ({ uv: planarUv(v, wall), blend: atKey.get(ka)!.blend })), wall);
      emit(`side${e}`, [a, b2, a2], [a, b2, a2].map((v) => ({ uv: planarUv(v, wall), blend: atKey.get(ka)!.blend })), wall);
    } else {
      // A ring quad from the old boundary in to the inset (and, for a bevel, lifted) one.
      const ua = atKey.get(ka)!, ub = atKey.get(kb)!;
      // One flat normal per quad, so its two triangles weld into one face.
      const facing = flat(a, b, b2);
      emit(`side${e}`, [a, b, b2], [ua, ub, ub], length(facing) > 0 ? facing : undefined);
      emit(`side${e}`, [a, b2, a2], [ua, ub, ua], length(facing) > 0 ? facing : undefined);
    }
  }

  // Weld corners whose every attribute agrees.
  const index = new Map<string, number>();
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], blend: number[] = [], indices: number[] = [];
  for (const c of out) {
    const key = `${c.group}|${c.pos.join(",")}|${c.nrm.map((v) => v.toFixed(5)).join(",")}|${c.uv.join(",")}|${c.blend}`;
    let i = index.get(key);
    if (i === undefined) {
      i = positions.length / 3;
      index.set(key, i);
      positions.push(...c.pos);
      normals.push(...c.nrm);
      uvs.push(...c.uv);
      blend.push(c.blend);
    }
    indices.push(i);
  }
  const { lightmapImage: _lightmap, ...material } = p.material;
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: hasUv ? Float32Array.from(uvs) : null,
    indices: Uint32Array.from(indices),
    material,
    ...(p.blend ? { blend: Float32Array.from(blend) } : {}),
  };
}

/** A mesh with the face under one of its triangles edited (see {@link editFace}). */
export function editMeshFace(mesh: MeshAsset, primitive: number, triangle: number, edit: FaceEdit): MeshAsset {
  const p = mesh.primitives[primitive];
  if (!p) return mesh;
  const face = faceAt(p, triangle);
  if (face.triangles.length === 0) return mesh;
  return { ...mesh, primitives: mesh.primitives.map((q, i) => (i === primitive ? editFace(q, face.triangles, edit) : q)) };
}
