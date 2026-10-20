/**
 * The sun's shadow in GPU cascades on the AAA tier (AAA_FIDELITY_ROADMAP.md
 * F2a), on a real device: casters drawn into a depth array from the sun, the
 * linear-light shader testing each point in the cascade that holds it.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";

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

const W = 64;
const H = 64;

/** A unit square in XZ facing up (a floor), or a unit cube. */
const floor = (): MeshAsset =>
  ({
    name: "floor",
    primitives: [
      {
        positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
        material: { name: "floor", baseColorImage: null, baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 1 },
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

const SUN: [number, number, number] = [0, 1, 0.0001];
const ground: MeshSceneInstance = { mesh: floor(), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [6, 1, 6]) };
const box: MeshSceneInstance = { mesh: cube(), model: composeModelMatrix([0, 1.5, 0], [0, 0, 0], [0.5, 0.5, 0.5]) };
const VIEW = viewMatrix([0, 6, 0.01], [0, 0, 0]);
const PROJECTION = projectionMatrix(Math.PI / 3, 1, 0.1, 50);

/** The frame (linear light), as a lookup of luminance at a pixel. */
async function render(sunShadow: object | null, instances: MeshSceneInstance[] = [ground, box]): Promise<(x: number, y: number) => number> {
  const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
  device.pushErrorScope("validation");
  const texture = renderer.renderToTexture!(instances, {
    width: W,
    height: H,
    view: VIEW,
    projection: PROJECTION,
    ambient: 0,
    lightDirection: SUN,
    lights: [{ kind: "directional", direction: SUN, color: [1, 1, 1], intensity: 1 }],
    ...(sunShadow ? { sunShadow } : {}),
  } as any);
  const error = await settled(device.popErrorScope());
  expect(error ? String((error as any).message ?? error) : null).toBeNull();
  const bytesPerRow = 512;
  const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const halves = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  renderer.dispose();
  return (x, y) => half(halves[(y * bytesPerRow) / 2 + x * 4 + 1]!);
}

const sun = (casters: MeshSceneInstance[]) => ({ casters, toLight: SUN, distance: 30, size: 1024, reach: 20 });

describe.skipIf(!device)("the sun's GPU cascades, on a real device", { timeout: 60_000 }, () => {
  it("leaves the floor away from the box as lit as without the cascades", async () => {
    const lit = await render(null);
    const shadowed = await render(sun([ground, box]));
    // The floor round the box, far from it: as lit with the cascades as without.
    expect(shadowed(4, 4)).toBeGreaterThan(0.3);
    expect(Math.abs(shadowed(4, 4) - lit(4, 4))).toBeLessThan(0.02);
  });

  it("shades the floor under a caster the camera never draws", async () => {
    const px = Math.round(W / 2 + (1.6 / (6 * Math.tan(Math.PI / 6))) * (W / 2));
    const bare = await render(null, [ground]);
    expect(bare(px, H / 2)).toBeGreaterThan(0.3);
    // The box is a caster only (not drawn), straight between the sun and that patch: no ambient, so dark.
    const beside = await render(sun([ground, { ...box, model: composeModelMatrix([1.6, 1.5, 0], [0, 0, 0], [0.5, 0.5, 0.5]) }]), [ground]);
    expect(beside(px, H / 2)).toBeLessThan(0.05);
    expect(beside(4, 4)).toBeGreaterThan(0.3);
  });
});
