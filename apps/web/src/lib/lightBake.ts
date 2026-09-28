/**
 * Bake a scene's lighting (HALO2_STYLE_ROADMAP.md, H1; see lightmap.ts in
 * @cartbox/editor): every still object gets its own light map — sky
 * visibility and one bounce of the rig's sun — traced against all the still
 * objects, and its mesh gains the second UV set to sample it with. Things that
 * move (skinned characters, physics bodies that move, prefab copies held in
 * reserve) and triggers are neither lit nor block the light, as in the
 * navigation bake.
 */

import {
  bakeLightmap,
  deserializeMeshAsset,
  layoutLightmap,
  sceneLightingKeyDirection,
  withLightmap,
  type MeshAsset,
  type Occluder,
} from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";

import { encodeMeshSidecar, setMeshAsset, type MeshSidecar } from "./meshSidecar";

export interface SceneLightBakeOptions {
  /** Texels per world unit (default 4). */
  readonly density?: number;
  /** Rays per texel (default 48). */
  readonly rays?: number;
  /** How far shade reaches, world units (default 7). */
  readonly distance?: number;
}

/** The still objects of a scene, as the runtime places them: id, mesh and world matrix. */
function stillObjects(sidecar: MeshSidecar): { id: string; mesh: MeshAsset; model: ArrayLike<number> }[] {
  const encoded = encodeMeshSidecar(sidecar);
  const scene = encoded ? parseMeshScene(encoded) : null;
  if (!scene) return [];
  const ids = new Set(sidecar.meshes.map((m) => m.id));
  return scene.instances
    .filter((inst) => {
      if (inst.pooled || inst.terrain || inst.mesh.skin || !ids.has(inst.id)) return false;
      const body = inst.physics?.body;
      return !(body === "dynamic" || body === "kinematic" || body === "character" || inst.physics?.trigger);
    })
    .map((inst) => ({ id: inst.id, mesh: inst.mesh, model: inst.model }));
}

/** How many of the scene's still objects carry a baked light map. */
export function lightingStats(sidecar: MeshSidecar): { baked: number; still: number } {
  const still = stillObjects(sidecar);
  return { still: still.length, baked: still.filter((o) => o.mesh.primitives.some((p) => p.uvs2 && p.material.lightmapImage)).length };
}

/**
 * Bake every still object's light map, yielding between objects so the page
 * stays responsive; `progress` hears the share done (0..1).
 */
export async function bakeSceneLighting(sidecar: MeshSidecar, options: SceneLightBakeOptions = {}, progress?: (done: number) => void): Promise<MeshSidecar> {
  const still = stillObjects(sidecar);
  const occluders: Occluder[] = still.map((o) => ({ mesh: o.mesh, model: o.model }));
  const sun = (sidecar.lighting ? sceneLightingKeyDirection(sidecar.lighting) : undefined) ?? null;
  let next = sidecar;
  for (let i = 0; i < still.length; i += 1) {
    const object = still[i]!;
    const layout = layoutLightmap(object.mesh, object.model, { density: options.density ?? 4 });
    const rgba = bakeLightmap(layout, occluders, { rays: options.rays ?? 48, distance: options.distance ?? 7, sun }, (d) => progress?.((i + d) / still.length));
    next = setMeshAsset(next, object.id, withLightmap(layout, rgba));
    progress?.((i + 1) / still.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return next;
}

/** Take every baked light map off the scene (the second UV sets go too). */
export function clearSceneLighting(sidecar: MeshSidecar): MeshSidecar {
  let next = sidecar;
  for (const entry of sidecar.meshes) {
    let mesh: MeshAsset;
    try {
      mesh = deserializeMeshAsset(entry.mesh);
    } catch {
      continue;
    }
    if (!mesh.primitives.some((p) => p.uvs2 || p.material.lightmapImage)) continue;
    next = setMeshAsset(next, entry.id, {
      ...mesh,
      primitives: mesh.primitives.map(({ uvs2: _uv2, ...p }) => {
        const { lightmapImage: _lm, ...material } = p.material;
        return { ...p, material };
      }),
    });
  }
  return next;
}
