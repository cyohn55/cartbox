/**
 * Shadows from spot and point lights (ENGINE_PARITY_ROADMAP.md EP8c). A light
 * that casts (`castShadows`) gets depth maps — one perspective view down a
 * spot light's cone, six 90° faces round a point light — of
 * {@link LOCAL_SHADOW_TILE}² texels each, packed as tiles in one atlas
 * ({@link LOCAL_SHADOW_GRID} across). The renderer's caller assigns each light
 * its first tile (`SceneLight.shadowTile`); every fragment that light reaches
 * projects itself into the tile and compares distances.
 *
 * Distances, not depths: the maps store perspective NDC depth, which crowds
 * toward the light, so both sides are read back as distance from the light
 * before comparing, and the bias is in world units — a constant few
 * centimetres near the light and far from it alike.
 */

import { multiplyMat4, projectionMatrix, renderShadowMap, spotCone, viewMatrix, type Mat4, type MeshSceneInstance, type SceneLight } from "./meshRasterizer";

/** A tile's edge in texels, tiles across the atlas, and the most tiles (and so the atlas: 1024² texels). */
export const LOCAL_SHADOW_TILE = 256;
export const LOCAL_SHADOW_GRID = 4;
export const MAX_LOCAL_SHADOW_TILES = LOCAL_SHADOW_GRID * LOCAL_SHADOW_GRID;
/** The light's near plane for its shadow views (world units). */
export const LOCAL_SHADOW_NEAR = 0.05;
/** Default biases, in world units: constant, and per unit of surface slope to the light. */
export const LOCAL_SHADOW_BIAS = 0.03;
export const LOCAL_SHADOW_SLOPE_BIAS = 0.05;

/** One shadow map: a light's world→clip through one face, its depths, and its depth→distance terms. */
export interface LocalShadowTile {
  readonly lightViewProj: Mat4;
  /** `LOCAL_SHADOW_TILE²` NDC depths, nearest-wins; Infinity where nothing was drawn. */
  readonly depth: Float32Array;
  /** Projection terms reading NDC depth back as distance: distance = linear[1] / (z + linear[0]). */
  readonly linear: readonly [number, number];
}

/** A frame's local-light shadows: the tiles, in atlas order, and the biases (world units). */
export interface LocalShadows {
  readonly tiles: readonly LocalShadowTile[];
  readonly bias: number;
  readonly slopeBias: number;
}

/** Whether a light casts shadows (it must be a ranged point or spot light). */
export function castsLocalShadow(light: SceneLight): boolean {
  return light.castShadows === true && light.kind !== "directional" && (light.range ?? 0) > 0;
}

/** The six faces of a point light, in the order {@link localShadowFace} picks them: +X, −X, +Y, −Y, +Z, −Z. */
const CUBE_FACES: readonly { readonly dir: readonly [number, number, number]; readonly up: readonly [number, number, number] }[] = [
  { dir: [1, 0, 0], up: [0, 1, 0] },
  { dir: [-1, 0, 0], up: [0, 1, 0] },
  { dir: [0, 1, 0], up: [0, 0, -1] },
  { dir: [0, -1, 0], up: [0, 0, 1] },
  { dir: [0, 0, 1], up: [0, 1, 0] },
  { dir: [0, 0, -1], up: [0, 1, 0] },
];

/** How many tiles a light's shadow takes: 1 for a spot, 6 for a point light, 0 if it casts none. */
export function localShadowTileCount(light: SceneLight): number {
  return castsLocalShadow(light) ? (light.kind === "spot" ? 1 : 6) : 0;
}

/** The light's shadow views (view and projection per face). */
export function localShadowViews(light: SceneLight): { readonly view: Mat4; readonly projection: Mat4 }[] {
  const p = light.position ?? [0, 0, 0];
  const far = Math.max(LOCAL_SHADOW_NEAR * 2, light.range ?? 1);
  if (light.kind === "spot") {
    const axis = light.direction ?? [0, -1, 0];
    const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    const a: [number, number, number] = [axis[0] / len, axis[1] / len, axis[2] / len];
    const up: [number, number, number] = Math.abs(a[1]) > 0.99 ? [0, 0, -1] : [0, 1, 0];
    // The cone's full angle, plus a little so its rim isn't on the map's edge.
    const fov = Math.min(Math.PI * 0.95, 2 * Math.acos(spotCone(light)[0]) + 0.05);
    return [{ view: viewMatrix(p, [p[0] + a[0], p[1] + a[1], p[2] + a[2]], up), projection: projectionMatrix(fov, 1, LOCAL_SHADOW_NEAR, far) }];
  }
  return CUBE_FACES.map((f) => ({ view: viewMatrix(p, [p[0] + f.dir[0], p[1] + f.dir[1], p[2] + f.dir[2]], f.up), projection: projectionMatrix(Math.PI / 2, 1, LOCAL_SHADOW_NEAR, far) }));
}

/** Which of a point light's six faces sees a point offset (dx, dy, dz) from it: its dominant axis. */
export function localShadowFace(dx: number, dy: number, dz: number): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  if (ax >= ay && ax >= az) return dx >= 0 ? 0 : 1;
  if (ay >= az) return dy >= 0 ? 2 : 3;
  return dz >= 0 ? 4 : 5;
}

/** Render a light's shadow tiles of the given instances (into `depths`, one array per face when given, so they can be reused). */
export function renderLocalShadow(light: SceneLight, instances: readonly MeshSceneInstance[], depths?: Float32Array[], clear = true): LocalShadowTile[] {
  return localShadowViews(light).map(({ view, projection }, i) => {
    const depth = depths?.[i] ?? new Float32Array(LOCAL_SHADOW_TILE * LOCAL_SHADOW_TILE);
    renderShadowMap(instances, { lightView: view, lightProjection: projection, size: LOCAL_SHADOW_TILE, depth, clear });
    return { lightViewProj: multiplyMat4(projection, view), depth, linear: [projection[10]!, projection[14]!] as const };
  });
}

/**
 * How lit a world point is by a shadowed light (1 lit … 0 in shadow), from its
 * tiles starting at `first`: the face that sees it, a 2×2 PCF of distance
 * compares with a slope-scaled world bias (`cosToLight` = N·L). Mirrors
 * `localShadow` in both GPU shaders.
 */
export function localShadowVisibility(shadows: LocalShadows, first: number, light: SceneLight, wx: number, wy: number, wz: number, cosToLight: number): number {
  let tile = first;
  if (light.kind !== "spot") {
    const p = light.position ?? [0, 0, 0];
    tile += localShadowFace(wx - p[0], wy - p[1], wz - p[2]);
  }
  const t = shadows.tiles[tile];
  if (!t) return 1;
  const m = t.lightViewProj;
  const w = m[3]! * wx + m[7]! * wy + m[11]! * wz + m[15]!;
  if (w <= 0) return 1;
  const nx = (m[0]! * wx + m[4]! * wy + m[8]! * wz + m[12]!) / w;
  const ny = (m[1]! * wx + m[5]! * wy + m[9]! * wz + m[13]!) / w;
  const nz = (m[2]! * wx + m[6]! * wy + m[10]! * wz + m[14]!) / w;
  if (nx < -1 || nx > 1 || ny < -1 || ny > 1 || nz < -1 || nz > 1) return 1;
  const size = LOCAL_SHADOW_TILE;
  const sx = (nx * 0.5 + 0.5) * size;
  const sy = (1 - (ny * 0.5 + 0.5)) * size;
  const [a, b] = t.linear;
  const c = Math.min(1, Math.max(0.05, cosToLight));
  const own = b / (nz + a) - shadows.bias - shadows.slopeBias * Math.min(10, Math.sqrt(1 - c * c) / c);
  const tap = (fx: number, fy: number): number => {
    const tx = Math.min(size - 1, Math.max(0, Math.floor(fx)));
    const ty = Math.min(size - 1, Math.max(0, Math.floor(fy)));
    // An empty texel (Infinity) reads as the far plane.
    return own > b / (Math.min(1, t.depth[ty * size + tx]!) + a) ? 0 : 1;
  };
  return (tap(sx - 0.5, sy - 0.5) + tap(sx + 0.5, sy - 0.5) + tap(sx - 0.5, sy + 0.5) + tap(sx + 0.5, sy + 0.5)) / 4;
}

/**
 * Give every casting light its tiles, in order, until the atlas is full:
 * returns the lights with `shadowTile` set (others unchanged) and how many tiles they take.
 */
export function assignLocalShadowTiles(lights: readonly SceneLight[]): { readonly lights: readonly SceneLight[]; readonly tiles: number } {
  let next = 0;
  const out = lights.map((light) => {
    const n = localShadowTileCount(light);
    if (n === 0 || next + n > MAX_LOCAL_SHADOW_TILES) return light.shadowTile === undefined ? light : { ...light, shadowTile: undefined };
    const assigned = { ...light, shadowTile: next };
    next += n;
    return assigned;
  });
  return { lights: out, tiles: next };
}
