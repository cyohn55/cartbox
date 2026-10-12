/**
 * Living-terrain test scenes (BEAVER_CREEK_ROADMAP.md B6), shared by the
 * software tests and the WebGL2 parity test: a grass shelf, a cliff and a
 * rock top, textured so a stretched projection shows — a coarse checker on the rock,
 * a fine one on the grass — and blended across the cliff's foot.
 */

import { composeModelMatrix, terrainMesh, type DecodedTexture, type MeshSceneInstance, type Terrain } from "@cartbox/editor";
import { checkerTexture } from "./layerScenes";

/** A 4×4 checker of a light and a dark rock: a stretched projection shows as tall cells. */
export function rockTexture(): DecodedTexture {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) data.set((x + y) % 2 === 0 ? [235, 200, 120, 255] : [60, 70, 130, 255], (y * 4 + x) * 4);
  return { width: 4, height: 4, data };
}

/** The cliff: flat grass, a near-vertical face 2.4 m high, a flat rock top. */
export function cliffTerrain(options: { triplanar?: boolean; sharpness?: number } = {}): Terrain {
  const n = 17;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) heights[j * n + i] = j < 7 ? 0 : j > 9 ? 2.4 : ((j - 7) / 3) * 2.4;
  return {
    id: "cliff",
    name: "Cliff",
    origin: [-2, -0.6, -2],
    size: [4, 4],
    samples: n,
    heights,
    tile: 0.5,
    layers: [
      { material: { name: "grass", baseColorFactor: [0.55, 0.8, 0.4, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.9 }, up: [0.75, 1], height: [-10, 0.5] },
      { material: { name: "rock", baseColorFactor: [0.85, 0.8, 0.75, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.7 } },
    ],
    blend: { up: 0.3, height: 0.4, ...(options.sharpness ? { sharpness: options.sharpness } : {}) },
    ...(options.triplanar ? { triplanar: true } : {}),
  };
}

/** The cliff as scene instances: each primitive's base and blend maps picked by its layers' names. */
export function cliffInstances(options: { triplanar?: boolean; sharpness?: number } = {}): MeshSceneInstance[] {
  const mesh = terrainMesh(cliffTerrain(options));
  const maps: Record<string, DecodedTexture> = { grass: checkerTexture(), rock: rockTexture() };
  const names = mesh.primitives.map((p) => p.material.name.split("+"));
  return [
    {
      mesh,
      model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]),
      textures: names.map(([a]) => maps[a!] ?? null),
      blendTextures: names.map(([, b]) => (b ? (maps[b] ?? null) : null)),
    },
  ];
}

/** Where the cliff is seen from: in front of and above its foot, the face square on. */
export const CLIFF_EYE: [number, number, number] = [0.6, 1.4, -4.2];
export const CLIFF_TARGET: [number, number, number] = [0, 0.4, 0];
