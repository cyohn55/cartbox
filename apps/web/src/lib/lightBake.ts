/**
 * Bake a scene's lighting (HALO2_STYLE_ROADMAP.md, H1; see lightmap.ts in
 * @cartbox/editor): every still object gets its own light map — sky
 * visibility and one bounce of the rig's sun — traced against all the still
 * objects, and its mesh gains the second UV set to sample it with. Things that
 * move (skinned characters, physics bodies that move, prefab copies held in
 * reserve) and triggers are neither lit nor block the light, as in the
 * navigation bake.
 *
 * Where the browser has WebGPU, the GPU lightmapper bakes instead
 * (AAA_FIDELITY_ROADMAP.md F3d; gpuLightmapper.ts in @cartbox/player): a path
 * tracer that takes the rig's sky and directional lights, emissive surfaces
 * and up to eight bounces, in seconds. Each object then carries the same
 * 8-bit map as before, for every tier, and an HDR directional one the AAA
 * tier lights by.
 */

import {
  applyLightmapImage,
  bakeLightProbes,
  bakeLightmap,
  encodeHdrLightmap,
  encodeLightProbes,
  encodeRgbaPng,
  lightColor,
  sceneLightingEnvironment,
  planProbeGrid,
  deserializeMeshAsset,
  layoutLightmap,
  sceneLightingKeyDirection,
  withLightmap,
  type MeshAsset,
  type Occluder,
  type SceneLighting,
} from "@cartbox/editor";
import { LIGHTMAP_MAX_BOUNCES, LIGHTMAP_MAX_LIGHTS, bakeLightmapGpu, environmentPanorama, parseMeshScene, type BakeLight } from "@cartbox/player";

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
  /** Light bounces, 1..3 on the CPU (default 1), up to 8 on the GPU: more fill shade with the light around it, at several times the bake. */
  readonly bounces?: number;
  /** Bake on this WebGPU device (F3d) rather than the CPU; see {@link lightBakeDevice}. */
  readonly device?: unknown;
}

/** Whether this browser can bake on the GPU (F3d). */
export function gpuLightBakeAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/** A WebGPU device to bake on, or null where there is none (the CPU bake then runs). The caller destroys it. */
export async function lightBakeDevice(): Promise<unknown | null> {
  if (!gpuLightBakeAvailable()) return null;
  try {
    const adapter = await (navigator as unknown as { gpu: { requestAdapter(): Promise<{ requestDevice(): Promise<unknown> } | null> } }).gpu.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
  } catch {
    return null;
  }
}

/** Authored colour into linear light, as the AAA shader decodes it. */
const toLinear = (c: number) => (c <= 0.04045 ? Math.max(0, c) / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The rig's directional lights as the GPU bake lights bounces with them: toward each, its linear colour × intensity. */
function bakeLights(lighting: SceneLighting): BakeLight[] {
  return lighting.lights
    .filter((l) => l.kind === "directional" && l.direction)
    .slice(0, LIGHTMAP_MAX_LIGHTS)
    .map((l) => {
      const c = lightColor(l);
      return { direction: [...l.direction!] as [number, number, number], radiance: [toLinear(c[0]) * l.intensity, toLinear(c[1]) * l.intensity, toLinear(c[2]) * l.intensity] as [number, number, number] };
    });
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
  // The GPU bake's sky and lights (F3d): the rig's environment in linear light, as the AAA tier's IBL sees it.
  const gpu = options.device && sidecar.lighting ? { sky: environmentPanorama(sceneLightingEnvironment(sidecar.lighting)), lights: bakeLights(sidecar.lighting) } : null;
  for (let i = 0; i < still.length; i += 1) {
    const object = still[i]!;
    const layout = layoutLightmap(object.mesh, object.model, { density: options.density ?? 4 });
    const step = (d: number) => progress?.(((i + d) / still.length) * share);
    if (gpu) {
      // Paths are cheap on the GPU: four for each of the CPU's rays.
      const baked = await bakeLightmapGpu(options.device, layout, occluders, { samples: (options.rays ?? 48) * 4, bounces: Math.min(LIGHTMAP_MAX_BOUNCES, options.bounces ?? 3), sky: gpu.sky, lights: gpu.lights }, step);
      const ambient = { mime: "image/png", bytes: encodeRgbaPng(baked.ambient, layout.size, layout.size, { compress: true }) };
      next = setMeshAsset(next, object.id, applyLightmapImage(layout.mesh, ambient, encodeHdrLightmap(baked.hdr)));
    } else {
      const rgba = bakeLightmap(layout, occluders, { rays: options.rays ?? 48, distance: options.distance ?? 7, sun, bounces: options.bounces ?? 1 }, step);
      next = setMeshAsset(next, object.id, withLightmap(layout, rgba));
    }
    progress?.(((i + 1) / still.length) * share);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (probes && next.lighting) {
    // Light probes (EP9) over the still objects, a little beyond them, so what moves among them is lit by the bake too.
    const box = boundsOf(still);
    const min: [number, number, number] = [box.min[0] - 1, box.min[1], box.min[2] - 1];
    const max: [number, number, number] = [box.max[0] + 1, box.max[1] + 2, box.max[2] + 1];
    const counts = planProbeGrid(min, max, options.probeSpacing ?? 2.5);
    const grid = bakeLightProbes(min, max, counts, occluders, { rays: options.rays ?? 48, distance: options.distance ?? 7, sun, bounces: options.bounces ?? 1 }, (d) => progress?.(share + d * (1 - share)));
    // With the sun it was baked under, so the player can relight the bounce as lights move (I17).
    const bake = sun ? { sun, distance: options.distance ?? 7, bounce: 0.9 } : undefined;
    next = { ...next, lighting: { ...next.lighting, lightProbes: encodeLightProbes(grid, bake) } };
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
    if (!mesh.primitives.some((p) => p.uvs2 || p.material.lightmapImage || p.material.lightmapHdrImage)) continue;
    next = setMeshAsset(next, entry.id, {
      ...mesh,
      primitives: mesh.primitives.map(({ uvs2: _uv2, ...p }) => {
        const { lightmapImage: _lm, lightmapHdrImage: _hdr, ...material } = p.material;
        return { ...p, material };
      }),
    });
  }
  return next;
}
