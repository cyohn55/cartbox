/**
 * Terrain editing in the Mesh tab (ENGINE_PARITY_ROADMAP.md EP10): adding and
 * removing terrains on the sidecar, the tools a brush stroke applies (see
 * terrainBrush.ts in @cartbox/editor), spacing a stroke's dabs evenly along
 * the cursor's path, and finding where the cursor's ray meets the ground. Pure:
 * the Terrain panel and the scene view share it, and the tests check it.
 */

import {
  cutTerrainHoles,
  invertAffine,
  newTerrain,
  paintTerrain,
  raycastTerrain,
  readTerrain,
  sculptTerrain,
  serializeTerrain,
  terrainHeight,
  type Mat4,
  type SculptTool,
  type Terrain,
  type TerrainBrush,
} from "@cartbox/editor";

import type { MeshSidecar } from "./meshSidecar";

/** What a stroke does: sculpt the ground, paint a layer, or cut (or fill) holes. */
export type TerrainTool =
  | { readonly kind: "sculpt"; readonly op: SculptTool }
  | { readonly kind: "paint"; readonly layer: number }
  | { readonly kind: "hole"; readonly fill: boolean };

/** The brush settings: radius in world units, strength 0..1. */
export interface TerrainBrushSettings {
  readonly radius: number;
  readonly strength: number;
}

/** A new terrain's id (unique on the sidecar). */
function terrainId(sidecar: MeshSidecar): string {
  const taken = new Set((sidecar.terrains ?? []).map((t) => t.id));
  for (let k = 1; ; k += 1) if (!taken.has(`terrain-${k}`)) return `terrain-${k}`;
}

/** Add a new flat terrain (`size` across, `samples` heights a side) centred on the origin. */
export function addTerrain(sidecar: MeshSidecar, options: { size?: number; samples?: number } = {}): { sidecar: MeshSidecar; id: string } {
  const id = terrainId(sidecar);
  const count = (sidecar.terrains ?? []).length;
  const terrain = newTerrain(id, { ...options, name: count === 0 ? "Terrain" : `Terrain ${count + 1}` });
  return { sidecar: { ...sidecar, terrains: [...(sidecar.terrains ?? []), serializeTerrain(terrain)] }, id };
}

/** Store an edited terrain in place of the one with its id. */
export function replaceTerrain(sidecar: MeshSidecar, terrain: Terrain): MeshSidecar {
  const stored = serializeTerrain(terrain);
  return { ...sidecar, terrains: (sidecar.terrains ?? []).map((t) => (t.id === terrain.id ? stored : t)) };
}

export function removeTerrain(sidecar: MeshSidecar, id: string): MeshSidecar {
  const terrains = (sidecar.terrains ?? []).filter((t) => t.id !== id);
  if (terrains.length > 0) return { ...sidecar, terrains };
  const { terrains: _gone, ...rest } = sidecar;
  void _gone;
  return rest;
}

/** A terrain on the sidecar, decoded, or null. */
export function findTerrain(sidecar: MeshSidecar, id: string): Terrain | null {
  const stored = (sidecar.terrains ?? []).find((t) => t.id === id);
  return stored ? readTerrain(stored) : null;
}

/** One dab of a tool. `level` is the flatten height (terrain space) the stroke holds. */
export function applyTerrainTool(t: Terrain, tool: TerrainTool, brush: TerrainBrush, level?: number): Terrain {
  if (tool.kind === "sculpt") return sculptTerrain(t, tool.op, brush, level);
  if (tool.kind === "paint") return paintTerrain(t, tool.layer, brush);
  return cutTerrainHoles(t, brush, tool.fill);
}

/** A stroke's dabs land a quarter of the brush apart, so a fast drag lays as much as a slow one. */
export const DAB_SPACING = 0.25;

/**
 * The dabs between the last one (`from`, null at a stroke's start) and the
 * cursor (`to`), in terrain space: evenly spaced along the path. Returns the
 * points and where the next stretch starts from (the last dab laid).
 */
export function strokeDabs(from: readonly [number, number] | null, to: readonly [number, number], radius: number): { dabs: [number, number][]; last: readonly [number, number] | null } {
  if (!from) return { dabs: [[to[0], to[1]]], last: to };
  const step = Math.max(1e-3, radius * DAB_SPACING);
  const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const count = Math.floor(d / step);
  if (count === 0) return { dabs: [], last: from };
  const dabs: [number, number][] = [];
  for (let k = 1; k <= count; k += 1) {
    const f = (k * step) / d;
    dabs.push([from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f]);
  }
  return { dabs, last: dabs[dabs.length - 1]! };
}

const apply = (m: Mat4, p: readonly number[], w: number): [number, number, number] => [
  m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]! * w,
  m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]! * w,
  m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]! * w,
];

/**
 * Where a world-space ray meets a terrain drawn with world matrix `model`: the
 * terrain-space point (x and z from the grid's corner, y above its origin) and
 * the world point. Null when it misses (or passes through a hole).
 */
export function terrainRayHit(t: Terrain, model: Mat4, ray: { origin: readonly number[]; dir: readonly number[] }): { local: [number, number, number]; world: [number, number, number] } | null {
  const inverse = invertAffine(model);
  if (!inverse) return null;
  const o = apply(inverse, ray.origin, 1);
  const d = apply(inverse, ray.dir, 0);
  const hit = raycastTerrain(t, [o[0] - t.origin[0], o[1] - t.origin[1], o[2] - t.origin[2]], d);
  if (!hit) return null;
  return { local: hit, world: apply(model, [hit[0] + t.origin[0], hit[1] + t.origin[1], hit[2] + t.origin[2]], 1) };
}

/** The brush's rim laid over the ground (world points), for drawing where a dab will land. */
export function brushRing(t: Terrain, model: Mat4, x: number, z: number, radius: number, segments = 48): [number, number, number][] {
  const local: Terrain = { ...t, origin: [0, 0, 0], holes: undefined };
  const out: [number, number, number][] = [];
  for (let k = 0; k <= segments; k += 1) {
    const a = (k / segments) * Math.PI * 2;
    const px = Math.min(t.size[0], Math.max(0, x + Math.cos(a) * radius));
    const pz = Math.min(t.size[1], Math.max(0, z + Math.sin(a) * radius));
    const y = terrainHeight(local, px, pz) ?? 0;
    out.push(apply(model, [px + t.origin[0], y + t.origin[1] + 0.05, pz + t.origin[2]], 1));
  }
  return out;
}
