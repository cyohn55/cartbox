/**
 * Ground-truth ambient occlusion on the AAA tier (AAA_FIDELITY_ROADMAP.md
 * F3c), on a real device: from the depth prepass, the floor round a box's foot
 * takes less of the ambient light than open floor does, and turning it off
 * gives the floor back its light.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";
import { GTAO_SLICES, GTAO_UNIFORM_FLOATS, gtaoUniforms } from "../packages/player/src/render/gtao";

describe("GTAO's uniforms", () => {
  it("carry the radius, the slices, the frame and whether there is a history", () => {
    const u = gtaoUniforms(viewMatrix([0, 0, 5], [0, 0, 0]), projectionMatrix(1, 1, 0.1, 50), 70, true);
    expect(u).toHaveLength(GTAO_UNIFORM_FLOATS);
    expect(u[49]).toBe(GTAO_SLICES);
    expect(u[51]).toBe(70 % 64);
    expect(u[53]).toBe(1);
    expect(gtaoUniforms(viewMatrix([0, 0, 5], [0, 0, 0]), projectionMatrix(1, 1, 0.1, 50), 0, false)[53]).toBe(0);
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
  for (let i = 0; i < 800 && !done; i += 1) {
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

const W = 128;
const H = 128;

/** A unit square in XZ facing up (a floor; a cut-out card with `mask`), or a unit cube. */
const floor = (mask = false): MeshAsset =>
  ({
    name: mask ? "card" : "floor",
    primitives: [
      {
        positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
        material: { name: "floor", baseColorImage: null, baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 1, ...(mask ? { alphaMode: "mask", alphaCutoff: 0.5 } : {}) },
      },
    ],
  }) as unknown as MeshAsset;
const cube = (): MeshAsset => {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [f, a, b] of faces) {
    const base = p.length / 3;
    for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      p.push(f[0]! + a[0]! * s! + b[0]! * t!, f[1]! + a[1]! * s! + b[1]! * t!, f[2]! + a[2]! * s! + b[2]! * t!);
      n.push(...f);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    name: "cube",
    primitives: [
      {
        positions: Float32Array.from(p),
        normals: Float32Array.from(n),
        uvs: new Float32Array((p.length / 3) * 2),
        indices: Uint32Array.from(idx),
        material: { name: "cube", baseColorImage: null, baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 1 },
      },
    ],
  } as unknown as MeshAsset;
};



// A dark floor, so the light bouncing between it and the box (gtaoBounce) gives little of the occlusion back.
const darkFloor = floor();
const ground: MeshSceneInstance = {
  mesh: { ...darkFloor, primitives: darkFloor.primitives.map((p) => ({ ...p, material: { ...p.material, baseColorFactor: [0.25, 0.25, 0.25, 1] } })) } as MeshAsset,
  model: composeModelMatrix([0, 0, 0], [0, 0, 0], [6, 1, 6]),
};
// A box a metre on a side, standing on the floor.
const box: MeshSceneInstance = { mesh: cube(), model: composeModelMatrix([0, 0.5, 0], [0, 0, 0], [0.5, 0.5, 0.5]) };
// Looking at the box's +x face, so the face is on screen beside its foot.
const VIEW = viewMatrix([4, 2.5, 0.01], [0.6, 0.2, 0]);
const PROJECTION = projectionMatrix(Math.PI / 3, 1, 0.1, 50);

/** The frame's linear-light green, averaged over the floor in a band at a world x on the centre line. Ambient light alone. */
async function render(ambientOcclusion: boolean): Promise<(x: number) => number> {
  const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
  device.pushErrorScope("validation");
  const texture = renderer.renderToTexture!([ground, box], {
    width: W,
    height: H,
    view: VIEW,
    projection: PROJECTION,
    ambient: 0.6,
    // The key light from below the floor: it lights none of what's measured, so the floor shows its ambient light alone.
    lightDirection: [0, -1, 0],
    lights: [],
    prepass: true,
    ambientOcclusion,
  } as any);
  const error = await settled(device.popErrorScope());
  expect(error ? String((error as any).message ?? error) : null).toBeNull();
  const bytesPerRow = Math.ceil((W * 8) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const halves = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  renderer.dispose();
  // Where a floor point (x, 0, 0) lands on screen.
  const vp = (x: number) => {
    const m = (a: Float64Array, v: number[]) => [0, 1, 2, 3].map((r) => a[r]! * v[0]! + a[4 + r]! * v[1]! + a[8 + r]! * v[2]! + a[12 + r]! * v[3]!);
    const c = m(PROJECTION, m(VIEW, [x, 0, 0, 1]));
    return [Math.round((c[0]! / c[3]! * 0.5 + 0.5) * W), Math.round((0.5 - (c[1]! / c[3]!) * 0.5) * H)] as const;
  };
  // A 3×3 patch, to average the slices' per-pixel noise away.
  return (x) => {
    const [cx, cy] = vp(x);
    let sum = 0;
    for (let y = -1; y <= 1; y += 1) for (let dx = -1; dx <= 1; dx += 1) sum += half(halves[((cy + y) * bytesPerRow) / 2 + (cx + dx) * 4 + 1]!);
    return sum / 9;
  };
}

describe.skipIf(!device)("GTAO, on a real device", { timeout: 60_000 }, () => {
  it("darkens the floor round a box's foot, and leaves open floor lit", async () => {
    const occluded = await render(true);
    const open = occluded(2.4);
    expect(open).toBeGreaterThan(0.01);
    // Just off the box's side: the box takes a share of the sky.
    expect(occluded(0.6) / open).toBeLessThan(0.85);
    // Without it, the floor by the box is as lit as open floor.
    const plain = await render(false);
    expect(plain(0.6) / plain(2.4)).toBeGreaterThan(0.97);
    // And open floor is not darkened by it.
    expect(open / plain(2.4)).toBeGreaterThan(0.93);
  });
});
