/**
 * glTF's texture coordinates, the right way up: glTF puts V = 0 at an image's
 * top row, the engine (as OBJ, and every renderer here) at its bottom, so the
 * importer flips V. A quad written the way Blender writes one, its texture red
 * on top and blue below, shows red at its top edge.
 */

import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { composeModelMatrix, encodeGlb, parseGltf, projectionMatrix, readGlb, renderMeshScene, viewMatrix, type DecodedTexture } from "@cartbox/editor";

/** A 2×2 PNG: the top row red, the bottom blue. */
function redOverBlue(): { png: Uint8Array; decoded: DecodedTexture } {
  const png = new PNG({ width: 2, height: 2 });
  png.data.set([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]);
  const bytes = new Uint8Array(PNG.sync.write(png));
  return { png: bytes, decoded: { width: 2, height: 2, data: new Uint8ClampedArray(png.data) } };
}

/** A quad facing +z in glTF's convention: V = 0 along its top edge (y = +1), as the image's top row. */
function quadFile(png: Uint8Array) {
  const positions = Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
  const normals = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = Float32Array.from([0, 1, 1, 1, 1, 0, 0, 0]);
  const indices = Uint16Array.from([0, 1, 2, 0, 2, 3]);
  const parts = [positions, normals, uvs, indices, png].map((a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  const padded = parts.map((p) => Math.ceil(p.byteLength / 4) * 4);
  const bin = new Uint8Array(padded.reduce((s, n) => s + n, 0));
  const offsets: number[] = [];
  parts.reduce((at, p, i) => (offsets.push(at), bin.set(p, at), at + padded[i]!), 0);
  const json = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: parts.map((p, i) => ({ buffer: 0, byteOffset: offsets[i]!, byteLength: p.byteLength })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 4, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 6, type: "SCALAR" },
    ],
    images: [{ bufferView: 4, mimeType: "image/png" }],
    textures: [{ source: 0 }],
    materials: [{ name: "m", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return { json, bin };
}

describe("glTF texture coordinates", () => {
  const { png, decoded } = redOverBlue();

  it("show an imported texture the right way up: its top row at the top", () => {
    const { json, bin } = quadFile(png);
    const mesh = parseGltf(json as never, [bin], "quad");
    const W = 32;
    const H = 32;
    const out = new Uint8ClampedArray(W * H * 4);
    renderMeshScene([{ mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), textures: [decoded] }], {
      width: W,
      height: H,
      out,
      depth: new Float32Array(W * H),
      view: viewMatrix([0, 0, 3], [0, 0, 0]),
      projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
      background: [0, 0, 0, 255],
      ambient: 1,
    });
    const at = (x: number, y: number) => [out[(y * W + x) * 4]!, out[(y * W + x) * 4 + 2]!];
    // A quarter down (the image's top row): red. Three quarters down (its bottom row): blue.
    const [topRed, topBlue] = at(16, 11);
    const [bottomRed, bottomBlue] = at(16, 21);
    expect(topRed).toBeGreaterThan(200);
    expect(topBlue).toBeLessThan(50);
    expect(bottomBlue).toBeGreaterThan(200);
    expect(bottomRed).toBeLessThan(50);
  });

  it("go back out in glTF's convention: V = 0 at the top edge again", () => {
    const { json, bin } = quadFile(png);
    const mesh = parseGltf(json as never, [bin], "quad");
    // In the engine's convention the top edge (y = +1) is V = 1.
    expect(mesh.primitives[0]!.uvs![5]).toBeCloseTo(1, 6);
    const glb = encodeGlb(mesh);
    const { json: out, buffers } = readGlb(glb);
    const accessor = out.accessors![out.meshes![0]!.primitives[0]!.attributes.TEXCOORD_0!]!;
    const view = out.bufferViews![accessor.bufferView!]!;
    const stored = new Float32Array(buffers[0]!.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength).buffer);
    expect(Array.from(stored)).toEqual([0, 1, 1, 1, 1, 0, 0, 0]);
  });
});
