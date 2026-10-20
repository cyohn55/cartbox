/**
 * Contact shadows on the AAA tier (AAA_FIDELITY_ROADMAP.md F2c), on a real
 * device: a short march toward the sun across the depth prepass shades what
 * the cascades never see, right where an object meets the ground.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";
import { contactUniforms } from "../packages/player/src/render/contactShadows";

describe("the contact pass's uniforms", () => {
  it("turn the sun into view space", () => {
    // A camera looking down −z from the origin: view space is world space.
    const identity = viewMatrix([0, 0, 0], [0, 0, -1]);
    const u = contactUniforms(identity, projectionMatrix(1, 1, 0.1, 50), [0, 2, 0], false);
    expect([u[32], u[33], u[34]].map((v) => Math.round(v! * 1e6) / 1e6)).toEqual([0, 1, 0]);
    // Turned to look along +x, the sun from +x points back toward the camera (+z in view space).
    const turned = contactUniforms(viewMatrix([0, 0, 0], [1, 0, 0]), projectionMatrix(1, 1, 0.1, 50), [1, 0, 0], true);
    expect(turned[34]).toBeCloseTo(-1, 6);
    expect(turned[39]).toBe(1); // a CPU occlusion buffer to carry through
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


// The sun low from +x, so a box's contact shadow falls on the floor toward −x.
const SUN: [number, number, number] = [0.894, 0.447, 0];
const ground: MeshSceneInstance = { mesh: floor(), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [6, 1, 6]) };
const box: MeshSceneInstance = { mesh: cube(), model: composeModelMatrix([0, 0.25, 0], [0, 0, 0], [0.25, 0.25, 0.25]) };
const VIEW = viewMatrix([0, 6, 0.01], [0, 0, 0]);
const PROJECTION = projectionMatrix(Math.PI / 3, 1, 0.1, 50);

/** The frame's linear-light green at a world x on the floor's centre line. The cascades cast from the floor alone, so they never shade it. */
async function render(prepass: boolean): Promise<(x: number) => number> {
  const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
  device.pushErrorScope("validation");
  const texture = renderer.renderToTexture!([ground, box], {
    width: W,
    height: H,
    view: VIEW,
    projection: PROJECTION,
    ambient: 0,
    lightDirection: SUN,
    lights: [{ kind: "directional", direction: SUN, color: [1, 1, 1], intensity: 1 }],
    sunShadow: { casters: [ground], toLight: SUN, distance: 30, size: 1024, reach: 20 },
    ...(prepass ? { prepass: true } : {}),
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
  const px = (x: number) => Math.round(W / 2 + (x / (6 * Math.tan(Math.PI / 6))) * (W / 2));
  return (x) => half(halves[(Math.round(H / 2) * bytesPerRow) / 2 + px(x) * 4 + 1]!);
}

describe.skipIf(!device)("contact shadows, on a real device", { timeout: 60_000 }, () => {
  it("shade the floor where a box meets it, away from the sun, and nowhere else", async () => {
    const shaded = await render(true);
    const lit = shaded(2.5);
    expect(lit).toBeGreaterThan(0.2);
    // Beside the box's foot, away from the sun: in its contact shadow.
    expect(shaded(-0.4)).toBeLessThan(0.5 * lit);
    // Toward the sun, and past the march's reach: lit.
    expect(shaded(0.45)).toBeGreaterThan(0.9 * lit);
    expect(shaded(-1.6)).toBeGreaterThan(0.9 * lit);
    // Without the prepass there are no depths to march: the floor by the box stays lit.
    const plain = await render(false);
    expect(plain(-0.4)).toBeGreaterThan(0.9 * plain(2.5));
  });
});
