/**
 * Scene objects: the parent/child hierarchy, tags and custom properties a placed
 * mesh can carry (ENGINE_ROADMAP.md, Phase 1).
 *
 * A mesh sidecar entry may name a `parent` (another entry's id); its transform is
 * then relative to that parent, so its world matrix is the parent's world matrix
 * times its own. `tags` group objects and `props` hold per-object data (numbers,
 * strings, booleans) the cart's code reads. All three are optional: an entry
 * without them is a root with no data, exactly as before.
 *
 * Pure and DOM-free, shared by the editor (viewport, inspector) and the player
 * (runtime scene), so both place a child in the same spot. Bad data never throws:
 * an unknown parent or a parent cycle makes the entry a root.
 */

import { multiplyMat4, type Mat4 } from "../render/meshRasterizer";

/** A custom property value. */
export type ScenePropValue = number | string | boolean;

/** Limits that keep a sidecar (and the Lua table generated from it) small. */
export const SCENE_TAG_MAX = 16;
export const SCENE_PROP_MAX = 32;
export const SCENE_KEY_MAX = 32;
export const SCENE_STRING_MAX = 256;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether `key` is a usable tag or property name (a Lua identifier, ≤ 32 chars). */
export function isSceneKey(key: string): boolean {
  return key.length > 0 && key.length <= SCENE_KEY_MAX && KEY_PATTERN.test(key);
}

/** Read stored tags: unique valid names, in order, capped. */
export function readSceneTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string" || !isSceneKey(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= SCENE_TAG_MAX) break;
  }
  return out;
}

/** Read stored properties: valid keys with finite-number, string or boolean values, capped. */
export function readSceneProps(value: unknown): Record<string, ScenePropValue> {
  const out: Record<string, ScenePropValue> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  let count = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isSceneKey(key)) continue;
    let v: ScenePropValue | null = null;
    if (typeof raw === "number" && Number.isFinite(raw)) v = raw;
    else if (typeof raw === "boolean") v = raw;
    else if (typeof raw === "string") v = raw.slice(0, SCENE_STRING_MAX);
    if (v === null) continue;
    out[key] = v;
    count += 1;
    if (count >= SCENE_PROP_MAX) break;
  }
  return out;
}

/** The minimum an entry needs for hierarchy resolution. */
export interface HierarchyNode {
  readonly id: string;
  readonly parent?: string | null;
}

/**
 * Each node's parent as an index into `nodes`, or -1 for a root. A parent id that
 * names no node, names the node itself, or closes a cycle yields -1 (for the node
 * where the cycle is detected), so the result is always a forest.
 */
export function parentIndices(nodes: readonly HierarchyNode[]): number[] {
  const byId = new Map<string, number>();
  nodes.forEach((node, i) => {
    if (!byId.has(node.id)) byId.set(node.id, i);
  });
  const parents = nodes.map((node, i) => {
    const p = node.parent ? byId.get(node.parent) : undefined;
    return p === undefined || p === i ? -1 : p;
  });
  // Break cycles: walk up from each node; a node reached twice on one walk is cut loose.
  for (let i = 0; i < parents.length; i += 1) {
    const seen = new Set<number>([i]);
    let at = i;
    while (parents[at]! >= 0) {
      const next = parents[at]!;
      if (seen.has(next)) {
        parents[at] = -1;
        break;
      }
      seen.add(next);
      at = next;
    }
  }
  return parents;
}

/** Children of each node, by index (the inverse of {@link parentIndices}). */
export function childIndices(parents: readonly number[]): number[][] {
  const children = parents.map(() => [] as number[]);
  parents.forEach((p, i) => {
    if (p >= 0) children[p]!.push(i);
  });
  return children;
}

/**
 * World matrices from local ones: a root's world is its local matrix, a child's is
 * its parent's world times its own local. `parents` must be a forest (as from
 * {@link parentIndices}); the result is index-aligned with `locals`. Roots return
 * their own local matrix object, so a scene with no hierarchy allocates nothing new.
 */
export function worldMatrices(locals: readonly Mat4[], parents: readonly number[]): Mat4[] {
  const world: (Mat4 | undefined)[] = new Array(locals.length);
  const resolve = (i: number): Mat4 => {
    const done = world[i];
    if (done) return done;
    const p = parents[i] ?? -1;
    const m = p < 0 ? locals[i]! : multiplyMat4(resolve(p), locals[i]!);
    world[i] = m;
    return m;
  };
  for (let i = 0; i < locals.length; i += 1) resolve(i);
  return world as Mat4[];
}

/** Whether `ancestor` is `node` or one of its ancestors. */
export function isAncestor(parents: readonly number[], ancestor: number, node: number): boolean {
  for (let at = node; at >= 0; at = parents[at] ?? -1) if (at === ancestor) return true;
  return false;
}

/** `roots` and every node below them, as a set of indices. */
export function withDescendants(roots: Iterable<number>, children: readonly (readonly number[])[]): Set<number> {
  const out = new Set<number>();
  const stack = [...roots];
  while (stack.length > 0) {
    const i = stack.pop()!;
    if (out.has(i)) continue;
    out.add(i);
    for (const c of children[i] ?? []) stack.push(c);
  }
  return out;
}

/**
 * A world-space direction (a drag delta) expressed in the local space of an
 * object whose parent has world matrix `parentWorld`, so moving a child by that
 * much in its own transform moves it by `v` in the world. Uses the inverse of the
 * matrix's 3×3 part; a degenerate (zero-scale) parent passes `v` through.
 */
export function localDirection(parentWorld: Mat4, v: readonly [number, number, number]): [number, number, number] {
  const m = parentWorld;
  // Column-major: column j is m[4j..4j+2].
  const a = m[0]!, b = m[4]!, c = m[8]!;
  const d = m[1]!, e = m[5]!, f = m[9]!;
  const g = m[2]!, h = m[6]!, k = m[10]!;
  const A = e * k - f * h;
  const B = -(d * k - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return [v[0], v[1], v[2]];
  const inv = [
    A, -(b * k - c * h), b * f - c * e,
    B, a * k - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ].map((x) => x / det);
  return [
    inv[0]! * v[0] + inv[1]! * v[1] + inv[2]! * v[2],
    inv[3]! * v[0] + inv[4]! * v[1] + inv[5]! * v[2],
    inv[6]! * v[0] + inv[7]! * v[1] + inv[8]! * v[2],
  ];
}

/** Inverse of an affine (rotation · scale · translation) column-major matrix, or null if singular. */
export function invertAffine(m: Mat4): Mat4 | null {
  const a = m[0]!, b = m[4]!, c = m[8]!;
  const d = m[1]!, e = m[5]!, f = m[9]!;
  const g = m[2]!, h = m[6]!, k = m[10]!;
  const A = e * k - f * h;
  const B = -(d * k - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  // Rows of the 3×3 inverse.
  const i00 = A / det, i01 = -(b * k - c * h) / det, i02 = (b * f - c * e) / det;
  const i10 = B / det, i11 = (a * k - c * g) / det, i12 = -(a * f - c * d) / det;
  const i20 = C / det, i21 = -(a * h - b * g) / det, i22 = (a * e - b * d) / det;
  const tx = m[12]!, ty = m[13]!, tz = m[14]!;
  const out = new Float64Array(16);
  out[0] = i00; out[4] = i01; out[8] = i02;
  out[1] = i10; out[5] = i11; out[9] = i12;
  out[2] = i20; out[6] = i21; out[10] = i22;
  out[12] = -(i00 * tx + i01 * ty + i02 * tz);
  out[13] = -(i10 * tx + i11 * ty + i12 * tz);
  out[14] = -(i20 * tx + i21 * ty + i22 * tz);
  out[15] = 1;
  return out;
}

/**
 * Split a model matrix back into the editor's transform: position, Euler angles
 * in degrees (the X→Y→Z order `composeModelMatrix` uses, R = Rz·Ry·Rx) and scale.
 * Exact for rotation · scale matrices; a matrix with shear (a non-uniformly scaled
 * parent that is also rotated) comes back as the nearest such transform.
 */
export function decomposeModelMatrix(m: Mat4): {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
} {
  const len = (x: number, y: number, z: number) => Math.hypot(x, y, z);
  let sx = len(m[0]!, m[1]!, m[2]!);
  const sy = len(m[4]!, m[5]!, m[6]!);
  const sz = len(m[8]!, m[9]!, m[10]!);
  // A mirrored matrix (negative determinant) keeps the flip on X.
  const det =
    m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  if (det < 0) sx = -sx;
  const safe = (s: number) => (Math.abs(s) < 1e-12 ? 1 : s);
  const r00 = m[0]! / safe(sx), r10 = m[1]! / safe(sx), r20 = m[2]! / safe(sx);
  const r21 = m[6]! / safe(sy), r22 = m[10]! / safe(sz);
  const r01 = m[4]! / safe(sy), r11 = m[5]! / safe(sy);
  const deg = 180 / Math.PI;
  let rx: number, rz: number;
  const sinY = Math.max(-1, Math.min(1, -r20));
  const ry = Math.asin(sinY);
  if (Math.abs(sinY) < 0.999999) {
    rx = Math.atan2(r21, r22);
    rz = Math.atan2(r10, r00);
  } else {
    // Gimbal lock: X and Z turn about the same axis; put it all on Z.
    rx = 0;
    rz = Math.atan2(-r01, r11);
  }
  const clean = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Number(v.toFixed(6)));
  return {
    position: [clean(m[12]!), clean(m[13]!), clean(m[14]!)],
    rotation: [clean(rx * deg), clean(ry * deg), clean(rz * deg)],
    scale: [clean(sx), clean(sy), clean(sz)],
  };
}
