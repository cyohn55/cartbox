/**
 * Material-layer test scenes (HALO_INFINITE_STYLE_ROADMAP.md I4), shared by the
 * WebGL2 and WebGPU parity tests and the software tests: a clearcoated paint,
 * brushed (anisotropic) metal, a parallax-relief panel and a wear-masked
 * panel, lit by an environment and a key light (or a list of lights).
 */

import { composeModelMatrix, panelReliefRgba, PANEL_RELIEF_SIZE, type DecodedTexture, type MaterialGraph, type MeshAsset, type MeshSceneInstance, type SceneLight } from "@cartbox/editor";

type Material = Partial<MeshAsset["primitives"][number]["material"]>;

/** The built-in relief tile, decoded. */
export function reliefTexture(): DecodedTexture {
  return { width: PANEL_RELIEF_SIZE, height: PANEL_RELIEF_SIZE, data: panelReliefRgba() };
}

/** An 8×8 checker of two greys, so a parallax shift moves visible edges. */
export function checkerTexture(): DecodedTexture {
  const data = new Uint8ClampedArray(8 * 8 * 4);
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) data.set((x + y) % 2 === 0 ? [220, 210, 190, 255] : [70, 80, 95, 255], (y * 8 + x) * 4);
  return { width: 8, height: 8, data };
}

/** Painted armour worn to bare metal on its edges, broken up by noise; grime in the cavities darkens it. */
export const WORN_PAINT: MaterialGraph = {
  nodes: [
    { id: "pos", op: "position" },
    { id: "noise", op: "noise", inputs: { position: "pos" }, params: { scale: 6, octaves: 2 } },
    { id: "breakup", op: "mix", inputs: { a: "half", b: "one", t: "noise" } },
    { id: "half", op: "constant", params: { value: 0.6 } },
    { id: "one", op: "constant", params: { value: 1.4 } },
    { id: "edge", op: "wear", inputs: { breakup: "breakup" }, params: { side: "edge", amount: 0.75, sharpness: 6 } },
    { id: "cavity", op: "wear", params: { side: "cavity", amount: 0.7, sharpness: 4 } },
    { id: "paint", op: "constant", params: { value: [0.2, 0.35, 0.15] } },
    { id: "metal", op: "constant", params: { value: [0.75, 0.75, 0.78] } },
    { id: "worn", op: "mix", inputs: { a: "paint", b: "metal", t: "edge" } },
    { id: "grime", op: "constant", params: { value: 0.45 } },
    { id: "dirt", op: "mix", inputs: { a: "one1", b: "grime", t: "cavity" } },
    { id: "one1", op: "constant", params: { value: 1 } },
    { id: "colour", op: "multiply", inputs: { a: "worn", b: "dirt" } },
    { id: "rough", op: "mix", inputs: { a: "r0", b: "r1", t: "edge" } },
    { id: "r0", op: "constant", params: { value: 0.6 } },
    { id: "r1", op: "constant", params: { value: 0.3 } },
  ],
  outputs: { baseColor: "colour", metallic: "edge", roughness: "rough" },
};

/** The four layered surfaces, on quads built by `quad` (a unit quad facing +Z with the given material). */
export function layerInstances(quad: (material: Material) => MeshAsset): MeshSceneInstance[] {
  const relief = reliefTexture();
  return [
    // Lacquered paint: a rough red base under a glossy coat.
    { mesh: quad({ baseColorFactor: [0.7, 0.12, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.7, clearcoat: 1, clearcoatRoughness: 0.1 }), model: composeModelMatrix([-1.3, 0.95, 0], [0, 25, 0], [0.85, 0.85, 0.85]) },
    // Brushed metal, the grain turned a little off U.
    { mesh: quad({ baseColorFactor: [0.85, 0.85, 0.88, 1], metallicFactor: 1, roughnessFactor: 0.4, anisotropy: 0.8, anisotropyRotation: 0.4 }), model: composeModelMatrix([1.3, 0.95, 0], [-10, -25, 0], [0.85, 0.85, 0.85]) },
    // Panels with depth: the checker parallax-shifted by the relief, seen at a slant.
    {
      mesh: quad({ baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.6, parallaxDepth: 0.15 }),
      model: composeModelMatrix([-1.3, -0.95, 0], [-45, 30, 0], [0.85, 0.85, 0.85]),
      textures: [checkerTexture()],
      reliefTextures: [relief],
    },
    // Worn paint: the graph's wear masks over the relief's curvature.
    { mesh: quad({ baseColorFactor: [1, 1, 1, 1], graph: WORN_PAINT }), model: composeModelMatrix([1.3, -0.95, 0], [0, -20, 0], [0.85, 0.85, 0.85]), reliefTextures: [relief] },
  ];
}

/** The environment the layer scenes are lit by. */
export const LAYER_ENVIRONMENT = {
  sky: [0.35, 0.55, 0.95] as const,
  horizon: [0.75, 0.72, 0.68] as const,
  ground: [0.25, 0.2, 0.15] as const,
  intensity: 1,
};

/** The lights for the multi-light variant: a sun and a warm point light near the coat. */
export const LAYER_LIGHTS: SceneLight[] = [
  { kind: "directional", direction: [0.4, 0.8, 0.6], color: [1, 0.95, 0.9], intensity: 1.2 },
  { kind: "point", position: [-0.6, 1.2, 1.4], color: [1, 0.7, 0.4], intensity: 3, range: 6 },
];
