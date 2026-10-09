/**
 * Refraction test scenes (HALO_INFINITE_STYLE_ROADMAP.md I5), shared by the
 * software tests and the WebGL2 and WebGPU parity tests: a striped wall behind
 * a glass lens, a heat-haze glow, an Active Camo quad and a flaring shield,
 * with a red block in front that a refraction must never pull in.
 */

import { composeModelMatrix, shieldEffect, type DecodedTexture, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";

type Material = Partial<MeshAsset["primitives"][number]["material"]>;

/** A unit quad facing +Z whose normals lean outward from its centre, like a lens (so its bend varies across it). */
export function lensQuad(material: Material, lean = 0.7): MeshAsset {
  const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
  const normals: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const x = corners[i * 2]! * lean;
    const y = corners[i * 2 + 1]! * lean;
    const l = Math.hypot(x, y, 1);
    normals.push(x / l, y / l, 1 / l);
  }
  return {
    name: "lens",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from(normals),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "lens", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, ...material },
      },
    ],
  };
}

/** Vertical stripes, 16 texels wide: any sideways bend shows as a step in them. */
export function stripeTexture(): DecodedTexture {
  const size = 16;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) data.set(x % 4 < 2 ? [235, 225, 90, 255] : [30, 60, 140, 255], (y * size + x) * 4);
  }
  return { width: size, height: size, data };
}

/** The refraction scene, with quads built by `quad` (a unit quad facing +Z with the given material). */
export function refractionInstances(quad: (material: Material) => MeshAsset): MeshSceneInstance[] {
  return [
    // The striped wall behind everything.
    { mesh: quad({ baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }), model: composeModelMatrix([0, 0, -1.5], [0, 0, 0], [4, 3, 1]), textures: [stripeTexture()] },
    // A red block nearer than the glass, beside it: no refraction may pull it in.
    { mesh: quad({ baseColorFactor: [1, 0, 0, 1], metallicFactor: 0, roughnessFactor: 1 }), model: composeModelMatrix([-1.75, 0.8, 1.2], [0, 0, 0], [0.35, 0.35, 1]) },
    // Glass: a faint blue lens bending the stripes.
    { mesh: lensQuad({ baseColorFactor: [0.6, 0.8, 1, 0.25], metallicFactor: 0, roughnessFactor: 0.05, alphaMode: "blend", refraction: 0.8 }), model: composeModelMatrix([-1.2, 0.8, 0], [0, 0, 0], [0.75, 0.75, 1]) },
    // Heat haze: a faint added glow whose noise shimmers the stripes.
    { mesh: quad({ baseColorFactor: [0.3, 0.12, 0.02, 1], metallicFactor: 0, roughnessFactor: 1, alphaMode: "additive", distortion: 0.6 }), model: composeModelMatrix([1.2, 0.8, 0], [0, 0, 0], [0.75, 0.75, 1]) },
    // Active Camo: most of the quad's pixels show the bent stripes.
    { mesh: lensQuad({ baseColorFactor: [0.4, 0.45, 0.5, 1], metallicFactor: 0.5, roughnessFactor: 0.4 }), model: composeModelMatrix([-1.2, -0.85, 0], [0, 0, 0], [0.75, 0.75, 1]), effect: shieldEffect(0, 0, 0.8) },
    // A flaring shield: the stripes warp at its silhouette.
    { mesh: lensQuad({ baseColorFactor: [0.4, 0.45, 0.5, 1], metallicFactor: 0.5, roughnessFactor: 0.4 }, 1.6), model: composeModelMatrix([1.2, -0.85, 0], [0, 0, 0], [0.75, 0.75, 1]), effect: shieldEffect(1, 0, 0) },
  ];
}

/** The same scene with every refraction removed (for "what did refraction change"). */
export function straightInstances(quad: (material: Material) => MeshAsset): MeshSceneInstance[] {
  return refractionInstances(quad).map((instance) => ({
    ...instance,
    mesh: {
      ...instance.mesh,
      primitives: instance.mesh.primitives.map((p) => ({ ...p, material: { ...p.material, refraction: undefined, distortion: undefined } })),
    },
    effect: instance.effect ? { ...instance.effect, distort: undefined } : instance.effect,
  }));
}

/** The time the scene is drawn at (the warp drifts with it). */
export const REFRACTION_TIME = 0.4;
