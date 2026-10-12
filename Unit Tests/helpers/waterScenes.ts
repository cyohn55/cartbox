/**
 * Water test scenes (BEAVER_CREEK_ROADMAP.md B5), shared by the software tests
 * and the WebGL2 parity test: a striped creek bed under a see-through,
 * refracting water surface, and a still-looking opaque pool beside it whose
 * reflections the ripples break up.
 */

import { composeModelMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { stripeTexture } from "./refractionScenes";

type Material = Partial<MeshAsset["primitives"][number]["material"]>;

/** Ripples for the test scenes: steep enough to see, three per metre, drifting along +X. */
export const WATER = { strength: 0.6, scale: 3, speed: 1, flow: 0 } as const;

/** The water scene, with quads built by `quad` (a unit quad facing +Z with the given material); `ripples` overrides the ripples (null: still water). */
export function waterInstances(quad: (material: Material) => MeshAsset, ripples: Material["water"] | null = WATER): MeshSceneInstance[] {
  const water = ripples ?? undefined;
  const flat = [-90, 0, 0] as [number, number, number];
  return [
    // The creek bed: stripes, which the water bends.
    { mesh: quad({ baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }), model: composeModelMatrix([-0.9, -0.4, 0], flat, [0.85, 1.2, 1]), textures: [stripeTexture()] },
    // The creek: a faint green, see-through surface just above the bed.
    {
      mesh: quad({ baseColorFactor: [0.5, 0.75, 0.7, 0.3], metallicFactor: 0, roughnessFactor: 0.05, reflectivity: 1.4, alphaMode: "blend", refraction: 0.5, water }),
      model: composeModelMatrix([-0.9, -0.2, 0], flat, [0.85, 1.2, 1]),
    },
    // A pool: opaque, glossy, mirroring the sky — the ripples break the mirror up.
    { mesh: quad({ baseColorFactor: [0.1, 0.2, 0.25, 1], metallicFactor: 0, roughnessFactor: 0.08, reflectivity: 1.6, water }), model: composeModelMatrix([0.9, -0.3, 0], flat, [0.85, 1.2, 1]) },
  ];
}

/** The environment the water reflects. */
export const WATER_ENVIRONMENT = {
  sky: [0.3, 0.55, 0.95] as const,
  horizon: [0.85, 0.8, 0.7] as const,
  ground: [0.2, 0.18, 0.12] as const,
  intensity: 1,
};

/** The time the scene is drawn at (the ripples drift with it). */
export const WATER_TIME = 0.6;
