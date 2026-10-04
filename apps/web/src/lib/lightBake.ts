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
  bakeLightProbes,
  bakeLightmap,
  encodeLightProbes,
  planProbeGrid,
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
  /** Light probes about this far apart (world units, default 2.5); 0 skips them. */
  readonly probeSpacing?: number;
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

/** How many of the scene's still objects carry a baked light map, and how many light probes it has. */
export function lightingStats(sidecar: MeshSidecar): { baked: number; still: number; probes: number } {
  const still = stillObjects(sidecar);
  const c = sidecar.lighting?.lightProbes?.counts;
  return { still: still.length, baked: still.filter((o) => o.mesh.primitives.some((p) => p.uvs2 && p.material.lightmapImage)).length, probes: c ? c[0] * c[1] * c[2] : 0 };
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
  // The light maps take most of the time; the probe grid the last tenth.
  const probes = (options.probeSpacing ?? 2.5) > 0 && still.length > 0 && sidecar.lighting;
  const share = probes ? 0.9 : 1;
  for (let i = 0; i < still.length; i += 1) {
    const object = still[i]!;
    const layout = layoutLightmap(object.mesh, object.model, { density: options.density ?? 4 });
    const rgba = bakeLightmap(layout, occluders, { rays: options.rays ?? 48, distance: options.distance ?? 7, sun }, (d) => progress?.(((i + d) / still.length) * share));
    next = setMeshAsset(next, object.id, withLightmap(layout, rgba));
    progress?.(((i + 1) / still.length) * share);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (probes && next.lighting) {
    // Light probes (EP9) over the still objects, a little beyond them, so what moves among them is lit by the bake too.
    const box = boundsOf(still);
    const min: [number, number, number] = [box.min[0] - 1, box.min[1], box.min[2] - 1];
    const max: [number, number, number] = [box.max[0] + 1, box.max[1] + 2, box.max[2] + 1];
    const counts = planProbeGrid(min, max, options.probeSpacing ?? 2.5);
    const grid = bakeLightProbes(min, max, counts, occluders, { rays: options.rays ?? 48, distance: options.distance ?? 7, sun }, (d) => progress?.(share + d * (1 - share)));
    next = { ...next, lighting: { ...next.lighting, lightProbes: encodeLightProbes(grid) } };
  }
  progress?.(1);
  return next;
}

/** The world-space box round some placed meshes. */
function boundsOf(objects: readonly { mesh: MeshAsset; model: ArrayLike<number> }[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const { mesh, model: m } of objects) {
    for (const p of mesh.primitives) {
      for (let i = 0; i < p.positions.length; i += 3) {
        const x = p.positions[i]!, y = p.positions[i + 1]!, z = p.positions[i + 2]!;
        const w = [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
        for (let a = 0; a < 3; a += 1) {
          min[a] = Math.min(min[a]!, w[a]!);
          max[a] = Math.max(max[a]!, w[a]!);
        }
      }
    }
  }
  return { min, max };
}

/** Take every baked light map off the scene (the second UV sets go too), and its light probes. */
export function clearSceneLighting(sidecar: MeshSidecar): MeshSidecar {
  let next = sidecar;
  if (sidecar.lighting?.lightProbes) {
    const { lightProbes: _probes, ...lighting } = sidecar.lighting;
    next = { ...next, lighting };
  }
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
