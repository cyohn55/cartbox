/**
 * Transparency (ENGINE_PARITY_ROADMAP.md EP6): blended, added and cut-out
 * materials in the software rasteriser (drawn after the opaque scene,
 * farthest first, never writing depth), the GPU path's batching and
 * premultiplied composite, and the materials' stored and glTF forms.
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  deserializeMeshAsset,
  encodeGlb,
  parseGlb,
  projectionMatrix,
  renderMeshScene,
  serializeMeshAsset,
  viewMatrix,
  type DecodedTexture,
  type MeshAsset,
  type MeshMaterial,
  type MeshSceneInstance,
} from "@cartbox/editor";

import { batchInstances, compositeFrame } from "../packages/player/src/render/gpuFrame";

const SIZE = 32;
const flat = { metallicFactor: 0, roughnessFactor: 1 } as const;

function quad(material: Partial<MeshMaterial>, z = 0, half = 1): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-half, -half, z, half, -half, z, half, half, z, -half, half, z]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, ...material },
      },
    ],
  };
}
const at = (mesh: MeshAsset, z = 0, textures?: (DecodedTexture | null)[]): MeshSceneInstance => ({ mesh, model: composeModelMatrix([0, 0, z], [0, 0, 0], [1, 1, 1]), ...(textures ? { textures } : {}) });

/** Draw a scene head-on, lit flat (ambient 1), over black; the centre pixel and the depth buffer. */
function draw(instances: MeshSceneInstance[]) {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const depth = new Float32Array(SIZE * SIZE);
  renderMeshScene(instances, {
    width: SIZE,
    height: SIZE,
    out,
    depth,
    view: viewMatrix([0, 0, 3], [0, 0, 0]),
    projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
    lightDirection: [0, 0, 1],
    ambient: 1,
    background: [0, 0, 0, 255],
  });
  const i = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
  return { px: [out[i]!, out[i + 1]!, out[i + 2]!, out[i + 3]!], depth: depth[(SIZE / 2) * SIZE + SIZE / 2]!, out };
}

/** Pixels equal within a couple of levels (the PBR model adds a sliver of specular). */
const near = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThanOrEqual(2));

const wall = quad({ baseColorFactor: [1, 0, 0, 1], ...flat }, 0, 2);
const pane = (a: number) => quad({ baseColorFactor: [0, 0, 1, a], alphaMode: "blend", ...flat });

describe("software rasteriser", () => {
  it("blends a see-through surface over what's behind it, by its alpha, writing no depth", () => {
    const opaque = draw([at(wall)]);
    near(opaque.px.slice(0, 3), [255, 0, 0]);
    expect(opaque.px[3]).toBe(255); // opaque surfaces always cover the pixel
    const glass = draw([at(wall), at(pane(0.25), 1)]);
    expect(glass.px[0]).toBeCloseTo(255 * 0.75, -0.5);
    expect(glass.px[2]).toBeCloseTo(255 * 0.25, -0.5);
    expect(glass.depth).toBe(opaque.depth); // the pane never hid the wall from the depth buffer
  });

  it("draws see-through surfaces after the opaque scene, whatever their order in the list", () => {
    expect(draw([at(pane(0.5), 1), at(wall)]).px).toEqual(draw([at(wall), at(pane(0.5), 1)]).px);
  });

  it("is hidden by opaque geometry in front of it", () => {
    const front = quad({ baseColorFactor: [0, 1, 0, 1], ...flat });
    near(draw([at(front, 1.5), at(pane(0.5), 1)]).px.slice(0, 3), [0, 255, 0]);
  });

  it("layers two panes farthest first", () => {
    const red = quad({ baseColorFactor: [1, 0, 0, 0.5], alphaMode: "blend", ...flat });
    const blue = quad({ baseColorFactor: [0, 0, 1, 0.5], alphaMode: "blend", ...flat });
    // Over black: far red then near blue → blue 0.5, red 0.25 — in either list order.
    for (const order of [[at(red, 0), at(blue, 1)], [at(blue, 1), at(red, 0)]]) {
      const { px } = draw(order);
      expect(px[0]).toBeCloseTo(64, -0.5);
      expect(px[2]).toBeCloseTo(128, -0.5);
    }
  });

  it("adds an additive surface's light to what's behind it", () => {
    const glow = quad({ baseColorFactor: [0, 1, 0, 0.5], alphaMode: "additive", ...flat });
    const { px } = draw([at(wall), at(glow, 1)]);
    expect(px[0]).toBe(255);
    expect(px[1]).toBeCloseTo(128, -0.5);
  });

  it("cuts out texels below a masked surface's threshold, and keeps the rest opaque", () => {
    const tex = (alpha: number): DecodedTexture => ({ width: 1, height: 1, data: Uint8ClampedArray.from([0, 255, 0, alpha]) });
    const mask = quad({ alphaMode: "mask", alphaCutoff: 0.5, ...flat });
    near(draw([at(wall), at(mask, 1, [tex(100)])]).px.slice(0, 3), [255, 0, 0]);
    near(draw([at(wall), at(mask, 1, [tex(200)])]).px, [0, 255, 0, 255]);
  });
});

describe("GPU path", () => {
  it("batches see-through copies one each, after the opaque batches, farthest first", () => {
    const glass = pane(0.5);
    const geometryOf = (m: MeshAsset) => m.primitives.map(() => ({ indexCount: 6 }));
    const { batches, instanceCount } = batchInstances([at(glass, 1), at(wall), at(glass, -2), at(wall, 0.5)], geometryOf, [0, 0, 5]);
    expect(instanceCount).toBe(4);
    expect(batches.map((b) => [b.alpha, b.models.length, b.models[0]![14]])).toEqual([
      [0, 2, 0],
      [2, 1, -2],
      [2, 1, 1],
    ]);
  });

  it("composites premultiplied colour over the cart's pixels, adds light with no coverage, copies opaque pixels and skips empty ones", () => {
    const frame = new Uint8Array([
      200, 100, 50, 255, // opaque
      0, 0, 0, 0, // nothing drawn
      50, 25, 0, 128, // blended, half covered (premultiplied)
      40, 0, 0, 0, // added light
    ]);
    const out = new Uint8ClampedArray([10, 10, 10, 255, 10, 20, 30, 255, 100, 100, 100, 255, 100, 100, 100, 255]);
    compositeFrame(frame, { width: 4, height: 1, out, depth: new Float32Array(4), view: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), projection: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), background: null });
    expect(Array.from(out.subarray(0, 4))).toEqual([200, 100, 50, 255]);
    expect(Array.from(out.subarray(4, 8))).toEqual([10, 20, 30, 255]);
    expect(Array.from(out.subarray(8, 12))).toEqual([100, 75, 50, 255]);
    expect(Array.from(out.subarray(12, 16))).toEqual([140, 100, 100, 255]);
  });
});

describe("stored and glTF forms", () => {
  it("keeps a material's transparency through serialization, clamping the cutoff", () => {
    const mesh = quad({ alphaMode: "mask", alphaCutoff: 3 });
    expect(deserializeMeshAsset(serializeMeshAsset(mesh)).primitives[0]!.material).toMatchObject({ alphaMode: "mask", alphaCutoff: 1 });
    expect(deserializeMeshAsset(serializeMeshAsset(quad({}))).primitives[0]!.material.alphaMode).toBeUndefined();
  });

  it("exports and imports glTF's alpha modes (additive exports as blended)", () => {
    expect(parseGlb(encodeGlb(quad({ alphaMode: "mask", alphaCutoff: 0.3 }))).primitives[0]!.material).toMatchObject({ alphaMode: "mask", alphaCutoff: expect.closeTo(0.3, 5) });
    expect(parseGlb(encodeGlb(quad({ alphaMode: "blend" }))).primitives[0]!.material.alphaMode).toBe("blend");
    expect(parseGlb(encodeGlb(quad({ alphaMode: "additive" }))).primitives[0]!.material.alphaMode).toBe("blend");
    expect(parseGlb(encodeGlb(quad({}))).primitives[0]!.material.alphaMode).toBeUndefined();
  });
});
