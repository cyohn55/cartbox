/**
 * Spline editing in the Mesh tab (EDITOR_PRO_ROADMAP.md P3): adding,
 * changing and removing splines on the sidecar, placing their points on the
 * ground, and applying them — a river carves its terrain and gets its water
 * and foam, a path levels and paints its terrain, a wall bends a mesh along
 * itself. What a spline makes is an ordinary scene object, tagged with the
 * spline's id in its props, which applying again replaces. Pure: the Splines
 * panel and the scene view share it, and the tests check it.
 */

import {
  MAX_SPLINE_POINTS,
  carveRiver,
  layPath,
  riverFoam,
  riverFoamMaterial,
  riverSurface,
  riverWaterMaterial,
  sampleSpline,
  splineMesh,
  terrainHeight,
  type MeshAsset,
  type MeshPrimitive,
  type Spline,
  type SplineKind,
} from "@cartbox/editor";

import { addMesh, readMeshEntry, setMeshAsset, setMeshProp, type MeshSidecar } from "./meshSidecar";
import { findTerrain, replaceTerrain } from "./terrainEdit";

/** The prop a spline's made object carries: the spline's id. */
export const SPLINE_PROP = "spline";

/** A new spline's id (unique on the sidecar). */
function splineId(sidecar: MeshSidecar, kind: SplineKind): string {
  const taken = new Set((sidecar.splines ?? []).map((s) => s.id));
  for (let k = 1; ; k += 1) if (!taken.has(`${kind}-${k}`)) return `${kind}-${k}`;
}

const KIND_NAMES: Record<SplineKind, string> = { river: "River", path: "Path", wall: "Wall" };

/** Add an empty spline of a kind, on the sidecar's first terrain (rivers and paths). */
export function addSpline(sidecar: MeshSidecar, kind: SplineKind): { sidecar: MeshSidecar; id: string } {
  const id = splineId(sidecar, kind);
  const count = (sidecar.splines ?? []).filter((s) => s.kind === kind).length;
  const terrain = sidecar.terrains?.[0]?.id;
  const spline: Spline = { id, name: count === 0 ? KIND_NAMES[kind] : `${KIND_NAMES[kind]} ${count + 1}`, kind, points: [], ...(terrain && kind !== "wall" ? { terrain } : {}) };
  return { sidecar: { ...sidecar, splines: [...(sidecar.splines ?? []), spline] }, id };
}

/** Store an edited spline in place of the one with its id. */
export function replaceSpline(sidecar: MeshSidecar, spline: Spline): MeshSidecar {
  return { ...sidecar, splines: (sidecar.splines ?? []).map((s) => (s.id === spline.id ? spline : s)) };
}

/** Remove a spline, and the object it made (the ground it shaped stays as it is). */
export function removeSpline(sidecar: MeshSidecar, id: string): MeshSidecar {
  const splines = (sidecar.splines ?? []).filter((s) => s.id !== id);
  const { splines: _gone, ...rest } = sidecar;
  void _gone;
  return { ...rest, meshes: sidecar.meshes.filter((m) => m.props?.[SPLINE_PROP] !== id), ...(splines.length > 0 ? { splines } : {}) };
}

/** A spline on the sidecar, or null. */
export function findSpline(sidecar: MeshSidecar, id: string): Spline | null {
  return (sidecar.splines ?? []).find((s) => s.id === id) ?? null;
}

/** A new point's width when the spline has none yet to copy. */
const DEFAULT_WIDTH: Record<SplineKind, number> = { river: 5, path: 3, wall: 1 };

/**
 * Put a point on the spline at a terrain-space spot of terrain `terrainId`
 * (as a brush stroke gives it): on the ground there (a river's water just
 * below it), as wide as the spline's last point. The end it lands nearer to
 * grows, so a spline extends from either end.
 */
export function addSplinePoint(sidecar: MeshSidecar, id: string, terrainId: string, x: number, z: number): MeshSidecar {
  const spline = findSpline(sidecar, id);
  const t = findTerrain(sidecar, terrainId);
  if (!spline || !t || spline.points.length >= MAX_SPLINE_POINTS) return sidecar;
  const ground = terrainHeight({ ...t, origin: [0, 0, 0], holes: undefined }, x, z) ?? 0;
  const lift = spline.kind === "river" ? -0.3 : 0;
  const p: [number, number, number] = [t.origin[0] + x, t.origin[1] + ground + lift, t.origin[2] + z];
  const pts = spline.points;
  const width = pts.length > 0 ? pts[pts.length - 1]!.width : DEFAULT_WIDTH[spline.kind];
  const point = { p, width };
  const nearStart = pts.length >= 2 && Math.hypot(p[0] - pts[0]!.p[0], p[2] - pts[0]!.p[2]) < Math.hypot(p[0] - pts[pts.length - 1]!.p[0], p[2] - pts[pts.length - 1]!.p[2]);
  return replaceSpline(sidecar, { ...spline, ...(spline.terrain ? {} : spline.kind !== "wall" ? { terrain: terrainId } : {}), points: nearStart ? [point, ...pts] : [...pts, point] });
}

/** Put a mesh in as the object a spline made: replacing the one it made before, or a new object tagged with its id. */
function placeMade(sidecar: MeshSidecar, spline: Spline, mesh: MeshAsset): MeshSidecar {
  const made = sidecar.meshes.find((m) => m.props?.[SPLINE_PROP] === spline.id);
  if (made) return setMeshAsset(sidecar, made.id, mesh);
  const added = addMesh(sidecar, mesh, mesh.name);
  return setMeshProp(added.sidecar, added.id, SPLINE_PROP, spline.id);
}

/**
 * Apply a spline: a river carves its terrain and lays its water and foam; a
 * path levels and paints its terrain; a wall bends its mesh along itself.
 * Returns the new sidecar, or why it can't be applied yet.
 */
export function applySpline(sidecar: MeshSidecar, id: string): { sidecar: MeshSidecar } | { problem: string } {
  const spline = findSpline(sidecar, id);
  if (!spline) return { problem: "That spline is gone." };
  if (spline.points.length < 2) return { problem: "Place at least two points first." };
  if (spline.kind === "wall") {
    const source = sidecar.meshes.find((m) => m.id === spline.mesh);
    if (!source) return { problem: "Pick the object to bend along it." };
    const bent = splineMesh(spline, readMeshEntry(source));
    if (!bent) return { problem: "That object has no length to repeat." };
    return { sidecar: placeMade(sidecar, spline, { ...bent, name: spline.name }) };
  }
  const t = spline.terrain ? findTerrain(sidecar, spline.terrain) : null;
  if (!t) return { problem: "Pick the terrain it shapes." };
  if (spline.kind === "path") return { sidecar: replaceTerrain(sidecar, layPath(t, spline)) };
  const carved = replaceTerrain(sidecar, carveRiver(t, spline));
  const primitives = [riverSurface(spline, riverWaterMaterial()), riverFoam(spline, riverFoamMaterial())].filter((p): p is MeshPrimitive => p !== null);
  return { sidecar: placeMade(carved, spline, { name: spline.name, primitives }) };
}

/** What the scene view draws for a spline: its curve and its points, in world space. */
export interface SplineOverlay {
  readonly id: string;
  readonly curve: readonly (readonly [number, number, number])[];
  readonly points: readonly (readonly [number, number, number])[];
}

/** Every spline's overlay (one with a single point shows just the point). */
export function splineOverlays(sidecar: MeshSidecar): SplineOverlay[] {
  return (sidecar.splines ?? []).map((s) => ({ id: s.id, curve: sampleSpline(s, 0.5).map((sample) => sample.p), points: s.points.map((p) => p.p) }));
}
