/**
 * Screen-space GI on the AAA tier (AAA_FIDELITY_ROADMAP.md F3e-2): the rig's
 * settings, the passes' uniforms, and on a real device a glowing red wall
 * bleeding its colour onto the grey floor beside it over the frames, which the
 * floor far from it doesn't take, and which turning it off takes away.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, parseSceneLighting, parseScreenSpaceGi, projectionMatrix, resolveScreenSpaceGi, viewMatrix, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";
import { SSGI_RAYS, SSGI_UNIFORM_FLOATS, ssgiUniforms } from "../packages/player/src/render/ssgi";

describe("screen-space GI's settings", () => {
  it("are on by default, turn off, and read in range", () => {
    expect(resolveScreenSpaceGi(null)).toEqual({ radius: 4, intensity: 1 });
    expect(resolveScreenSpaceGi({ enabled: false })).toBeNull();
    expect(parseScreenSpaceGi({ radius: 99, intensity: -1, enabled: true })).toEqual({ enabled: true, radius: 16, intensity: 0 });
    expect(parseScreenSpaceGi("on")).toBeNull();
  });

  it("survive a save", () => {
    const lighting = parseSceneLighting({ screenSpaceGi: { enabled: false, radius: 2 } });
    expect(lighting.screenSpaceGi).toEqual({ enabled: false, radius: 2 });
    expect(parseSceneLighting(JSON.parse(JSON.stringify(lighting))).screenSpaceGi).toEqual({ enabled: false, radius: 2 });
    expect(parseSceneLighting({}).screenSpaceGi).toBeUndefined();
  });

  it("carry the radius, the rays, the frame, the history and the strength in the uniforms", () => {
    const u = ssgiUniforms(viewMatrix([0, 0, 5], [0, 0, 0]), projectionMatrix(1, 1, 0.1, 50), 1030, true, { radius: 3, intensity: 0.5 });
    expect(u).toHaveLength(SSGI_UNIFORM_FLOATS);
    expect([u[48], u[49], u[51]]).toEqual([3, SSGI_RAYS, 1030 % 1024]);
    expect([u[54], u[55]]).toEqual([1, 0.5]);
    expect(ssgiUniforms(viewMatrix([0, 0, 5], [0, 0, 0]), projectionMatrix(1, 1, 0.1, 50), 0, false, { radius: 3, intensity: 1 })[54]).toBe(0);
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

const material = (colour: [number, number, number], glow: [number, number, number] = [0, 0, 0]) => ({ name: "m", baseColorImage: null, baseColorFactor: [...colour, 1], metallicFactor: 0, roughnessFactor: 1, emissiveFactor: glow });
/** A unit square in XZ facing up. */
const quad = (m: object): MeshAsset =>
  ({
    name: "floor",
    primitives: [
      {
        positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
        material: m,
      },
    ],
  }) as unknown as MeshAsset;
/** A unit square in YZ facing +x (a wall). */
const wallQuad = (m: object): MeshAsset =>
  ({
    name: "wall",
    primitives: [
      {
        positions: Float32Array.from([0, -1, -1, 0, -1, 1, 0, 1, 1, 0, 1, -1]),
        normals: Float32Array.from([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
        material: m,
      },
    ],
  }) as unknown as MeshAsset;

const ground: MeshSceneInstance = { mesh: quad(material([0.6, 0.6, 0.6])), model: composeModelMatrix([1, 0, 0], [0, 0, 0], [3, 1, 3]) };
// A glowing red wall at x = −1, two metres tall, facing the floor it stands on.
const wall: MeshSceneInstance = { mesh: wallQuad(material([0, 0, 0], [1, 0, 0])), model: composeModelMatrix([-1, 1, 0], [0, 0, 0], [1, 1, 3]) };
const VIEW = viewMatrix([4, 3, 0.01], [-0.2, 0, 0]);
const PROJECTION = projectionMatrix(Math.PI / 3, 1, 0.1, 50);

/** The frame's linear light after `frames` frames, as [r, g] averaged over a 5×5 patch of floor at a world x on the centre line. */
async function render(ssgi: boolean, frames: number): Promise<(x: number) => [number, number]> {
  const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
  device.pushErrorScope("validation");
  let texture: any = null;
  for (let f = 0; f < frames; f += 1) {
    texture = renderer.renderToTexture!([ground, wall], {
      width: W,
      height: H,
      view: VIEW,
      projection: PROJECTION,
      ambient: 0.3,
      // The key light from below the floor: the floor shows its ambient light and what the wall gives it alone.
      lightDirection: [0, -1, 0],
      lights: [],
      prepass: true,
      temporal: true,
      ambientOcclusion: false,
      ...(ssgi ? { screenSpaceGi: { radius: 4, intensity: 1 } } : {}),
    } as any);
  }
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
  const vp = (x: number) => {
    const m = (a: Float64Array, v: number[]) => [0, 1, 2, 3].map((r) => a[r]! * v[0]! + a[4 + r]! * v[1]! + a[8 + r]! * v[2]! + a[12 + r]! * v[3]!);
    const c = m(PROJECTION, m(VIEW, [x, 0, 0, 1]));
    return [Math.round((c[0]! / c[3]! * 0.5 + 0.5) * W), Math.round((0.5 - (c[1]! / c[3]!) * 0.5) * H)] as const;
  };
  return (x) => {
    const [cx, cy] = vp(x);
    let r = 0;
    let g = 0;
    for (let y = -2; y <= 2; y += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const at = ((cy + y) * bytesPerRow) / 2 + (cx + dx) * 4;
        r += half(halves[at]!);
        g += half(halves[at + 1]!);
      }
    }
    return [r / 25, g / 25];
  };
}

describe.skipIf(!device)("SSGI, on a real device", { timeout: 120_000 }, () => {
  it("bleeds a glowing wall's red onto the floor beside it, and not onto the floor far from it", async () => {
    const plain = await render(false, 12);
    const [pr, pg] = plain(-0.6);
    expect(pg).toBeGreaterThan(0.01);
    // Without it the floor by the wall is as grey as the rest.
    expect(pr / pg).toBeLessThan(1.05);
    const lit = await render(true, 24);
    const [nr, ng] = lit(-0.6);
    // With it, the floor beside the wall takes its red, and gains light.
    expect(nr / ng).toBeGreaterThan(1.3);
    expect(nr).toBeGreaterThan(pr * 1.3);
    // The floor three metres away barely sees the wall on screen: it stays near grey.
    const [fr, fg] = lit(2.2);
    expect(fr / fg).toBeLessThan(nr / ng);
    expect(fg / plain(2.2)[1]).toBeGreaterThan(0.85);
  });

  it("does nothing on the first frame, before there is a frame to light by", async () => {
    const plain = await render(false, 1);
    const first = await render(true, 1);
    const [a] = plain(-0.6);
    const [b] = first(-0.6);
    expect(Math.abs(a - b) / a).toBeLessThan(0.02);
  });
});
