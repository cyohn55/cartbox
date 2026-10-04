/**
 * Material-graph test scenes (ENGINE_PARITY_ROADMAP.md EP7), shared by the
 * WebGL2 and WebGPU parity tests: every node kind that reads the surface, the
 * noise, fresnel and texture nodes, and maths, wired into all five outputs.
 */

import { composeModelMatrix, type DecodedTexture, type MaterialGraph, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";

/** Swirled marble: noise mixes two colours, roughness follows U, metal steps on V, a fresnel rim glows. */
export const MARBLE: MaterialGraph = {
  nodes: [
    { id: "pos", op: "position" },
    { id: "n", op: "noise", inputs: { position: "pos" }, params: { scale: 2.5, octaves: 3 } },
    { id: "a", op: "constant", params: { value: [0.85, 0.8, 0.7] } },
    { id: "b", op: "constant", params: { value: [0.2, 0.25, 0.4] } },
    { id: "col", op: "mix", inputs: { a: "a", b: "b", t: "n" } },
    { id: "uv", op: "uv" },
    { id: "u", op: "split", inputs: { x: "uv" }, params: { component: 0 } },
    { id: "v", op: "split", inputs: { x: "uv" }, params: { component: 1 } },
    { id: "rough", op: "mix", inputs: { a: "lo", b: "hi", t: "u" } },
    { id: "lo", op: "constant", params: { value: 0.2 } },
    { id: "hi", op: "constant", params: { value: 0.9 } },
    { id: "metal", op: "step", inputs: { x: "v" } },
    { id: "f", op: "fresnel", params: { power: 3 } },
    { id: "tint", op: "constant", params: { value: [0.2, 0.5, 1] } },
    { id: "glow", op: "multiply", inputs: { a: "f", b: "tint" } },
  ],
  outputs: { baseColor: "col", roughness: "rough", metallic: "metal", emissive: "glow" },
};

/** A scrolling, tiled texture whose alpha cuts the surface's coverage, tinted by the material colour. */
export const SCROLL: MaterialGraph = {
  nodes: [
    { id: "uv", op: "uv" },
    { id: "two", op: "constant", params: { value: 2 } },
    { id: "tiled", op: "multiply", inputs: { a: "uv", b: "two" } },
    { id: "t", op: "time" },
    { id: "speed", op: "constant", params: { value: [0.25, 0.1, 0] } },
    { id: "shift", op: "multiply", inputs: { a: "t", b: "speed" } },
    { id: "pan", op: "add", inputs: { a: "tiled", b: "shift" } },
    { id: "tex", op: "texture", inputs: { uv: "pan" } },
    { id: "texA", op: "texture", inputs: { uv: "pan" }, params: { channel: "a" } },
    { id: "base", op: "baseColor" },
    { id: "col", op: "multiply", inputs: { a: "tex", b: "base" } },
    { id: "s", op: "sin", inputs: { x: "t" } },
    { id: "alpha", op: "saturate", inputs: { x: "texA" } },
  ],
  outputs: { baseColor: "col", alpha: "alpha" },
};

/** A 4×4 texture with a gradient in colour and alternating alpha. */
export function graphTexture(): DecodedTexture {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) data.set([40 + i * 13, 200 - i * 9, 90 + (i % 4) * 40, i % 3 === 0 ? 60 : 230], i * 4);
  return { width: 4, height: 4, data };
}

/** The graph scene: a marble quad behind a scrolling, see-through one. */
export function graphInstances(quad: (material: Partial<MeshAsset["primitives"][number]["material"]>) => MeshAsset): MeshSceneInstance[] {
  return [
    { mesh: quad({ baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1, graph: MARBLE }), model: composeModelMatrix([-0.4, 0.05, -0.5], [-18, 25, 0], [1.4, 1.2, 1]) },
    { mesh: quad({ baseColorFactor: [1, 0.85, 0.6, 1], alphaMode: "blend", graph: SCROLL }), model: composeModelMatrix([0.7, -0.1, 0.4], [0, -20, 0], [0.8, 0.8, 1]), textures: [graphTexture()] },
  ];
}
