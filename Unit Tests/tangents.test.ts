/**
 * Stored MikkTSpace tangents (AAA_FIDELITY_ROADMAP.md F1c): the vendored
 * WebAssembly generator, the unweld and weld around it, the tangents through
 * the sidecar and glTF, and on a real device (Dawn) the AAA tier decoding a
 * normal map in the stored frame, which agrees with the derivative frame on a
 * plain layout and wins where they differ.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  deserializeMeshAsset,
  encodeGlb,
  needsTangents,
  parseGlb,
  projectionMatrix,
  serializeMeshAsset,
  viewMatrix,
  withMeshTangents,
  withMikkTangents,
  type DecodedTexture,
  type MeshAsset,
  type MeshPrimitive,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { WebgpuSceneRenderer, interleaveVerticesWithTangents, TANGENT_VERTEX_FLOATS } from "@cartbox/player";
import { createMikkTSpace } from "@/lib/mikktspace";

const mikk = await createMikkTSpace(readFileSync(new URL("../apps/web/src/vendor/mikktspace/mikktspace.wasm", import.meta.url)));

const PNG_1X1 = { mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) };

/** A quad facing +z, u along +x and v up +y (the engine's convention), normal-mapped. */
function quad(uvs = [0, 0, 1, 0, 1, 1, 0, 1]): MeshPrimitive {
  return {
    positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, normalImage: PNG_1X1 as never, metallicFactor: 0, roughnessFactor: 1 },
  } as MeshPrimitive;
}

const tangentOf = (p: MeshPrimitive, v: number) => Array.from(p.tangents!.subarray(v * 4, v * 4 + 4));

describe("MikkTSpace tangents", () => {
  it("loads the vendored WebAssembly and lays the tangent along U, the bitangent up V", () => {
    const out = withMikkTangents(quad(), mikk);
    // A flat quad keeps its four vertices: every corner agrees.
    expect(out.positions.length).toBe(12);
    expect(Array.from(out.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    for (let v = 0; v < 4; v += 1) {
      const [x, y, z, w] = tangentOf(out, v);
      expect(x).toBeCloseTo(1, 5);
      expect(y).toBeCloseTo(0, 5);
      expect(z).toBeCloseTo(0, 5);
      // w · (n × t) = w · (+y): up V, as the engine samples it.
      expect(w).toBe(1);
    }
  });

  it("splits a vertex only where its corners disagree: a mirrored island flips w", () => {
    // Two quads side by side sharing an edge, the right one's U mirrored.
    const p: MeshPrimitive = {
      ...quad(),
      positions: Float32Array.from([-1, -1, 0, 0, -1, 0, 0, 1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0]),
      normals: Float32Array.from(Array.from({ length: 6 }, () => [0, 0, 1]).flat()),
      uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 1, 4, 5, 1, 5, 2]),
    };
    const out = withMikkTangents(p, mikk);
    // The shared edge's two vertices split (each side its own tangent); the rest stay.
    expect(out.positions.length / 3).toBe(8);
    const ws = new Set<number>();
    for (let c = 0; c < out.indices.length; c += 1) ws.add(out.tangents![out.indices[c]! * 4 + 3]!);
    expect([...ws].sort()).toEqual([-1, 1]);
    // Every stream follows the weld.
    expect(out.normals!.length).toBe(out.positions.length);
    expect(out.uvs!.length / 2).toBe(out.positions.length / 3);
  });

  it("is made only for normal-mapped primitives without tangents", () => {
    const plain = { ...quad(), material: { ...quad().material, normalImage: null } } as MeshPrimitive;
    const mesh: MeshAsset = { name: "m", primitives: [quad(), plain] };
    expect(needsTangents(quad())).toBe(true);
    expect(needsTangents(plain)).toBe(false);
    const out = withMeshTangents(mesh, mikk);
    expect(out.primitives[0]!.tangents).toBeTruthy();
    expect(out.primitives[1]).toBe(plain);
    expect(needsTangents(out.primitives[0]!)).toBe(false);
    expect(withMeshTangents(out, mikk)).toBe(out);
  });

  it("ride the sidecar, and glTF with its own handedness both ways", () => {
    const mesh: MeshAsset = { name: "m", primitives: [{ ...withMikkTangents(quad(), mikk), material: { ...quad().material, normalImage: null } }] };
    const again = deserializeMeshAsset(serializeMeshAsset(mesh));
    expect(Array.from(again.primitives[0]!.tangents!)).toEqual(Array.from(mesh.primitives[0]!.tangents!));
    const glb = encodeGlb(mesh);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
    expect(json.meshes[0].primitives[0].attributes.TANGENT).toBeTypeOf("number");
    const back = parseGlb(glb, "m");
    expect(Array.from(back.primitives[0]!.tangents!)).toEqual(Array.from(mesh.primitives[0]!.tangents!));
  });

  it("interleave after the twelve floats, zeros (w = 0) without one per vertex", () => {
    const p = withMikkTangents(quad(), mikk);
    const v = interleaveVerticesWithTangents(p.positions, p.normals!, p.uvs, null, null, null, p.tangents!);
    expect(v.length).toBe(4 * TANGENT_VERTEX_FLOATS);
    expect(Array.from(v.subarray(12, 16))).toEqual(tangentOf(p, 0));
    const none = interleaveVerticesWithTangents(p.positions, p.normals!, p.uvs, null, null, null, new Float32Array(3));
    expect(none[15]).toBe(0);
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
  } catch {
    return null;
  }
}
const device = await realDevice();

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 400 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

function half(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024);
}

const W = 32;
const H = 32;

/** A normal map of one texel's normal, tilted `tn` in tangent space. */
function flatMap(tn: [number, number, number]): DecodedTexture {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i += 1) data.set([Math.round((tn[0] * 0.5 + 0.5) * 255), Math.round((tn[1] * 0.5 + 0.5) * 255), Math.round((tn[2] * 0.5 + 0.5) * 255), 255], i * 4);
  return { width: 4, height: 4, data };
}

describe.skipIf(!device)("on a real device, on the AAA tier", { timeout: 60_000 }, () => {
  /** The linear red at the centre: the quad lit from `light` alone, its map tilted `tn`. */
  async function lit(primitive: MeshPrimitive, tn: [number, number, number], light: [number, number, number]): Promise<number> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
    const instances: MeshSceneInstance[] = [{ mesh: { name: "q", primitives: [primitive] }, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [2, 2, 1]), normalTextures: [flatMap(tn)] }];
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, { width: W, height: H, view: viewMatrix([0, 0, 3], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50), ambient: 0, lightDirection: light } as any);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const bytesPerRow = 256;
    const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const halves = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    renderer.dispose();
    return half(halves[((H >> 1) * bytesPerRow) / 2 + (W >> 1) * 4]!);
  }

  it("decodes a map in the generated frame as the derivative frame does on a plain layout, along U and up V", async () => {
    const stored = withMikkTangents(quad(), mikk);
    for (const [tn, light] of [
      [[0.6, 0, 0.8], [0.6, 0, 0.8]],
      [[0, 0.6, 0.8], [0, 0.6, 0.8]],
    ] as [[number, number, number], [number, number, number]][]) {
      const derived = await lit(quad(), tn, light);
      const mikkLit = await lit(stored, tn, light);
      expect(derived).toBeGreaterThan(0.1);
      expect(Math.abs(mikkLit - derived) / derived).toBeLessThan(0.02);
    }
  });

  it("uses the stored frame where it differs from the derivative one", async () => {
    // Tangents stored along +y: a map tilted along T now leans up, not right.
    const along = (w: number) => ({ ...quad(), tangents: Float32Array.from(Array.from({ length: 4 }, () => [0, 1, 0, w]).flat()) }) as MeshPrimitive;
    const right = await lit(along(1), [0.6, 0, 0.8], [0.6, 0, 0.8]);
    const up = await lit(along(1), [0.6, 0, 0.8], [0, 0.6, 0.8]);
    expect(up).toBeGreaterThan(right * 1.3);
    // And w flips the bitangent: with T up +y, w = 1 puts B along −x (n × t), w = −1 along +x.
    const leanPlus = await lit(along(-1), [0, 0.6, 0.8], [0.6, 0, 0.8]);
    const leanMinus = await lit(along(1), [0, 0.6, 0.8], [0.6, 0, 0.8]);
    expect(leanPlus).toBeGreaterThan(leanMinus * 1.3);
  });
});
