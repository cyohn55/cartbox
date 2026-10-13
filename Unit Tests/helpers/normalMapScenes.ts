/**
 * Normal-map test scenes (EDITOR_PRO_ROADMAP.md P1a), shared by the software
 * tests and the WebGL2 and WebGPU parity tests: raised panels in a normal map
 * on a metal quad, a matte one and a clearcoated one, turned so the light
 * rakes across them.
 */

import { composeModelMatrix, type DecodedTexture, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";

type Material = Partial<MeshAsset["primitives"][number]["material"]>;

/** A 32² tangent-space normal map: a 4×4 grid of raised, bevelled panels (encoded 0..255, +Z out). */
export function panelNormalMap(): DecodedTexture {
  const size = 32;
  const data = new Uint8ClampedArray(size * size * 4);
  const height = (x: number, y: number): number => {
    const fx = (((x % 8) + 8) % 8) / 8;
    const fy = (((y % 8) + 8) % 8) / 8;
    const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
    return Math.min(1, edge * 6);
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (height(x + 1, y) - height(x - 1, y)) * 1.5;
      const dy = (height(x, y + 1) - height(x, y - 1)) * 1.5;
      const l = Math.hypot(dx, dy, 1);
      data.set([Math.round((-dx / l) * 127.5 + 127.5), Math.round((-dy / l) * 127.5 + 127.5), Math.round((1 / l) * 127.5 + 127.5), 255], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

/** The scene: three quads (built by `quad`, a unit quad facing +Z with UVs), each with the panel normal map. */
export function normalMapInstances(quad: (material: Material) => MeshAsset, withMaps = true): MeshSceneInstance[] {
  const map = panelNormalMap();
  const maps = withMaps ? { normalTextures: [map] } : {};
  return [
    { mesh: quad({ baseColorFactor: [0.75, 0.76, 0.8, 1], metallicFactor: 0.9, roughnessFactor: 0.35 }), model: composeModelMatrix([-1.1, 0.5, 0], [-20, 25, 0], [0.8, 0.8, 1]), ...maps },
    { mesh: quad({ baseColorFactor: [0.7, 0.55, 0.4, 1], metallicFactor: 0, roughnessFactor: 0.8 }), model: composeModelMatrix([1.1, 0.5, 0], [-20, -25, 0], [0.8, 0.8, 1]), ...maps },
    { mesh: quad({ baseColorFactor: [0.2, 0.35, 0.6, 1], metallicFactor: 0.3, roughnessFactor: 0.5, clearcoat: 1, clearcoatRoughness: 0.05 }), model: composeModelMatrix([0, -0.75, 0], [35, 0, 10], [0.8, 0.8, 1]), ...maps },
  ];
}

/** Where the light rakes from, and the sky the metal reflects. */
export const NORMAL_LIGHT: [number, number, number] = [0.8, 0.5, 0.6];
export const NORMAL_ENVIRONMENT = { sky: [0.35, 0.55, 0.95] as const, horizon: [0.8, 0.75, 0.7] as const, ground: [0.25, 0.2, 0.15] as const, intensity: 1 };
