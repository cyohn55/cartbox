/**
 * Baking reflection probes (HALO2_STYLE_ROADMAP.md, H2): each probe's panorama
 * is the scene rendered from its capture point — six 90° cube faces through the
 * software rasteriser, resampled to an equirectangular strip — with the sky
 * (the environment) wherever no geometry was drawn. The runtime does this when
 * a scene loads, so a probe always shows the scene as it is.
 */

import {
  computeEnvironmentAverage,
  projectionMatrix,
  renderMeshScene,
  sampleEnvironmentDir,
  viewMatrix,
  type EnvironmentLight,
  type MeshSceneInstance,
  type RenderMeshSceneOptions,
  type SceneLight,
  type ShadowInput,
} from "./meshRasterizer";
import { PROBE_RANGE, type ProbeBox, type ReflectionProbeSet } from "./probeSampling";
import type { ReflectionProbe } from "../model/reflectionProbes";

/** The light the probes are captured under (the scene's rig, as the frame uses it). */
export interface ProbeBakeLighting {
  readonly lightDirection?: readonly [number, number, number];
  readonly ambient?: number;
  readonly environment?: EnvironmentLight | null;
  readonly lights?: readonly SceneLight[] | null;
  readonly shadow?: ShadowInput | null;
}

/** Panorama width per probe, texels (height is half). */
export const PROBE_PANORAMA_WIDTH = 128;

type V3 = [number, number, number];

/** The six faces: forward and up for each. */
const FACES: readonly { forward: V3; up: V3 }[] = [
  { forward: [1, 0, 0], up: [0, 1, 0] },
  { forward: [-1, 0, 0], up: [0, 1, 0] },
  { forward: [0, 1, 0], up: [0, 0, -1] },
  { forward: [0, -1, 0], up: [0, 0, 1] },
  { forward: [0, 0, 1], up: [0, 1, 0] },
  { forward: [0, 0, -1], up: [0, 1, 0] },
];

/**
 * Bake every probe (smallest box first) into one {@link ReflectionProbeSet},
 * or null when there are none. `instances` are what the probes see — the
 * scene's still objects, textured as the frame draws them.
 */
export function bakeReflectionProbes(
  probes: readonly ReflectionProbe[],
  instances: readonly MeshSceneInstance[],
  lighting: ProbeBakeLighting,
  width = PROBE_PANORAMA_WIDTH,
): ReflectionProbeSet | null {
  const steps = probeSteps(probes, instances, lighting, width);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * {@link bakeReflectionProbes}, pausing between probes (`pause` defaults to a
 * macrotask) so a page can keep drawing while its probes bake.
 */
export async function bakeReflectionProbesAsync(
  probes: readonly ReflectionProbe[],
  instances: readonly MeshSceneInstance[],
  lighting: ProbeBakeLighting,
  width = PROBE_PANORAMA_WIDTH,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<ReflectionProbeSet | null> {
  const steps = probeSteps(probes, instances, lighting, width);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await pause();
  }
}

/** The bake, one probe per step. */
function* probeSteps(
  probes: readonly ReflectionProbe[],
  instances: readonly MeshSceneInstance[],
  lighting: ProbeBakeLighting,
  width: number,
): Generator<void, ReflectionProbeSet | null> {
  if (probes.length === 0) return null;
  const volume = (p: ReflectionProbe) => (p.max[0] - p.min[0]) * (p.max[1] - p.min[1]) * (p.max[2] - p.min[2]);
  const ordered = [...probes].sort((a, b) => volume(a) - volume(b));
  const w = Math.max(8, width);
  const h = w >> 1;
  const atlas = new Uint8ClampedArray(w * h * ordered.length * 4);
  const boxes: ProbeBox[] = [];
  for (const [index, probe] of ordered.entries()) {
    const strip = bakePanorama(probe.position, instances, lighting, w);
    atlas.set(strip, index * w * h * 4);
    const [r, g, b] = computeEnvironmentAverage({ width: w, height: h, data: strip });
    boxes.push({ min: probe.min, max: probe.max, position: probe.position, average: [r * PROBE_RANGE, g * PROBE_RANGE, b * PROBE_RANGE] });
    if (index < ordered.length - 1) yield;
  }
  return { atlas: { width: w, height: h * ordered.length, data: atlas }, probes: boxes };
}

/**
 * One panorama (w × w/2 RGBA) of the scene from `eye`, at 1/{@link PROBE_RANGE}
 * of its radiance: every light, the ambient and the sky are scaled down (light
 * adds linearly), so sunlit surfaces don't clip.
 */
export function bakePanorama(eye: readonly [number, number, number], instances: readonly MeshSceneInstance[], full: ProbeBakeLighting, w: number): Uint8ClampedArray {
  const k = 1 / PROBE_RANGE;
  const lighting: ProbeBakeLighting = {
    ...full,
    ambient: (full.ambient ?? 0.35) * k,
    environment: full.environment ? { ...full.environment, intensity: full.environment.intensity * k } : null,
    // With no light list, the single key light: stand it in explicitly so it scales too.
    lights: (full.lights && full.lights.length > 0 ? full.lights : [{ kind: "directional" as const, direction: full.lightDirection ?? [0.4, 0.8, 0.6], color: [1, 1, 1] as const, intensity: 1 }]).map(
      (l) => ({ ...l, intensity: l.intensity * k }),
    ),
  };
  const h = w >> 1;
  const face = Math.max(8, Math.round(w * 0.375));
  const projection = projectionMatrix(Math.PI / 2, 1, 0.05, 500);
  const base: Omit<RenderMeshSceneOptions, "out" | "depth" | "view"> = {
    width: face,
    height: face,
    projection,
    background: [0, 0, 0, 0],
    lightDirection: lighting.lightDirection,
    ambient: lighting.ambient,
    environment: lighting.environment ?? null,
    lights: lighting.lights ?? null,
    shadow: lighting.shadow ?? null,
  };
  const faces = FACES.map(({ forward, up }) => {
    const out = new Uint8ClampedArray(face * face * 4);
    const depth = new Float32Array(face * face);
    const view = viewMatrix(eye, [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]], up);
    renderMeshScene(instances, { ...base, out, depth, view });
    return { out, depth, view };
  });
  const env = lighting.environment ?? null;
  const strip = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const theta = ((y + 0.5) / h) * Math.PI; // 0 at the top
    for (let x = 0; x < w; x += 1) {
      // Inverse of the equirect lookup: u = atan2(z, x)/2π + 0.5, v = acos(y)/π.
      const phi = ((x + 0.5) / w - 0.5) * 2 * Math.PI;
      const dx = Math.sin(theta) * Math.cos(phi);
      const dy = Math.cos(theta);
      const dz = Math.sin(theta) * Math.sin(phi);
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const az = Math.abs(dz);
      const f = ax >= ay && ax >= az ? (dx > 0 ? 0 : 1) : ay >= az ? (dy > 0 ? 2 : 3) : dz > 0 ? 4 : 5;
      const { out, depth, view } = faces[f]!;
      // Into the face camera's view space (it looks down −Z), then to its pixels.
      const vx = view[0]! * dx + view[4]! * dy + view[8]! * dz;
      const vy = view[1]! * dx + view[5]! * dy + view[9]! * dz;
      const vz = view[2]! * dx + view[6]! * dy + view[10]! * dz;
      const px = Math.min(face - 1, Math.max(0, Math.floor(((vx / -vz) * 0.5 + 0.5) * face)));
      const py = Math.min(face - 1, Math.max(0, Math.floor((1 - ((vy / -vz) * 0.5 + 0.5)) * face)));
      const at = (py * face + px) * 4;
      const to = (y * w + x) * 4;
      if (depth[py * face + px] !== Infinity) {
        strip[to] = out[at]!;
        strip[to + 1] = out[at + 1]!;
        strip[to + 2] = out[at + 2]!;
      } else {
        const [r, g, b] = env ? sampleEnvironmentDir(env, dx, dy, dz) : [0.5, 0.5, 0.5];
        strip[to] = r * 255;
        strip[to + 1] = g * 255;
        strip[to + 2] = b * 255;
      }
      strip[to + 3] = 255;
    }
  }
  return strip;
}
