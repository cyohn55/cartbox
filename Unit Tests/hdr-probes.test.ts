/**
 * HDR reflection probes on the AAA tier (AAA_FIDELITY_ROADMAP.md F3b): probes
 * captured on the GPU as cubes in linear light and prefiltered by roughness,
 * box- or sphere-projected, blended in priority order, and captured again when
 * their key changes.
 *
 * On a real device (Dawn): a room of six coloured glowing walls round a probe.
 * Its captured cube shows each wall on the face WebGPU looks up for that
 * direction, a mirror in the room reflects the wall it faces, and a rough one
 * the room's blur.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, parseReflectionProbes, probeOrder, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance, type ReflectionProbe } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";

import { PROBE_FACE, packCapturedProbes } from "../packages/player/src/render/probeCapture";

describe("the probes' order and records", () => {
  it("takes higher priority first, then the smaller volume", () => {
    const box = (name: string, half: number, priority?: number): ReflectionProbe => ({ name, position: [0, 0, 0], min: [-half, -half, -half], max: [half, half, half], ...(priority !== undefined ? { priority } : {}) });
    expect(probeOrder([box("hall", 10), box("room", 2), box("cupboard", 1)]).map((p) => p.name)).toEqual(["cupboard", "room", "hall"]);
    expect(probeOrder([box("hall", 10, 5), box("room", 2)]).map((p) => p.name)).toEqual(["hall", "room"]);
  });

  it("reads a sphere probe as its radius round the capture point, and keeps a priority", () => {
    const [sphere, box] = parseReflectionProbes([
      { name: "plaza", shape: "sphere", radius: 6, position: [1, 2, 3], min: [0, 0, 0], max: [10, 10, 10], priority: 3 },
      { name: "room", position: [0, 1, 0], min: [-2, 0, -2], max: [2, 3, 2], priority: 0 },
    ]);
    expect(sphere).toMatchObject({ shape: "sphere", radius: 6, position: [1, 2, 3], min: [-5, -4, -3], max: [7, 8, 9], priority: 3 });
    expect(box!.priority).toBeUndefined();
    const packed = packCapturedProbes([
      { probe: sphere!, ready: true },
      { probe: box!, ready: false },
    ]);
    expect(Array.from(packed.subarray(8, 16))).toEqual([1, 2, 3, 6, 0, 0, 0, 1]);
    expect(packed[16 + 11]).toBe(0);
    expect(packed[16 + 15]).toBe(0);
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
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

/** A square of side `size` at `centre`, facing along `axis` (0 x, 1 y, 2 z), glowing `glow` or PBR `metallic`/`roughness`. */
function square(centre: readonly [number, number, number], axis: number, size: number, material: { glow?: readonly [number, number, number]; metallic?: number; roughness?: number }): MeshAsset {
  const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
  const corner = (a: number, b: number) => {
    const p = [...centre];
    p[u] = p[u]! + a * size / 2;
    p[v] = p[v]! + b * size / 2;
    return p;
  };
  const n = [0, 0, 0];
  n[axis] = 1;
  return {
    name: "sq",
    primitives: [
      {
        positions: Float32Array.from([...corner(-1, -1), ...corner(1, -1), ...corner(1, 1), ...corner(-1, 1)]),
        normals: Float32Array.from([...n, ...n, ...n, ...n]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: material.glow
          ? { name: "glow", baseColorFactor: [0, 0, 0, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1, emissiveFactor: material.glow }
          : { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: material.metallic ?? 1, roughnessFactor: material.roughness ?? 0.05 },
      },
    ],
  } as unknown as MeshAsset;
}

const IDENTITY = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
/** The room's walls, ±3 on each axis: +x red, −x green, +y blue, −y yellow, +z cyan, −z magenta. */
const WALLS: [axis: number, side: number, glow: [number, number, number]][] = [
  [0, 1, [1, 0, 0]],
  [0, -1, [0, 1, 0]],
  [1, 1, [0, 0, 1]],
  [1, -1, [1, 1, 0]],
  [2, 1, [0, 1, 1]],
  [2, -1, [1, 0, 1]],
];
const room: MeshSceneInstance[] = WALLS.map(([axis, side, glow]) => {
  const c: [number, number, number] = [0, 0, 0];
  c[axis] = 3 * side;
  return { mesh: square(c, axis, 6.2, { glow }), model: IDENTITY };
});
const PROBE: ReflectionProbe = { name: "room", position: [0, 0, 0], min: [-3, -3, -3], max: [3, 3, 3] };

const W = 32;
const H = 32;

describe.skipIf(!device)("on a real device, in linear light", { timeout: 120_000 }, () => {
  /** Draw the room (and `extra`) from the camera until the probe is captured; the renderer, and the last frame's texture. */
  async function frames(extra: MeshSceneInstance[], eye: [number, number, number], target: [number, number, number], probes: readonly ReflectionProbe[] = [PROBE]) {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
    const draw = () =>
      ({
        width: W,
        height: H,
        view: viewMatrix(eye, target),
        projection: projectionMatrix(Math.PI / 4, 1, 0.05, 50),
        ambient: 0,
        lightDirection: [0, 1, 0],
        environment: { sky: [0, 0, 0], horizon: [0, 0, 0], ground: [0, 0, 0], intensity: 1 },
        lights: [],
        reflectionCapture: { probes, instances: room, key: "k" },
      }) as any;
    device.pushErrorScope("validation");
    for (let i = 0; i < 40; i += 1) {
      renderer.renderToTexture!([...room, ...extra], draw());
      await new Promise((resolve) => setTimeout(resolve, 10));
      device.tick?.();
      if ((renderer as any).probeCapture?.settled && i > 2) break;
    }
    const texture = renderer.renderToTexture!([...room, ...extra], draw());
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    return { renderer, texture };
  }

  async function readCentre(texture: any, width: number, height: number, layer = 0, level = 0): Promise<[number, number, number]> {
    const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture, mipLevel: level, origin: { x: 0, y: 0, z: layer } }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const halves = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    const i = ((height >> 1) * bytesPerRow) / 2 + (width >> 1) * 4;
    return [half(halves[i]!), half(halves[i + 1]!), half(halves[i + 2]!)];
  }

  it("captures each wall onto the face WebGPU reads for its direction", async () => {
    const { renderer } = await frames([], [0, 0, 2], [0, 0, 0]);
    const capture = (renderer as any).probeCapture;
    expect(capture.settled).toBe(true);
    // WebGPU's face order: +x, −x, +y, −y, +z, −z — the walls' order.
    for (let face = 0; face < 6; face += 1) {
      const c = await readCentre(capture.cubes, PROBE_FACE, PROBE_FACE, face);
      const want = WALLS[face]![2];
      for (let k = 0; k < 3; k += 1) expect(Math.abs(c[k]! - want[k]!)).toBeLessThan(0.05);
    }
    // The roughest level is the room blurred: every face a mixture of its neighbours, no channel black.
    const rough = await readCentre(capture.cubes, PROBE_FACE >> 5, PROBE_FACE >> 5, 4, 5);
    for (const c of rough) expect(c).toBeGreaterThan(0.05);
    renderer.dispose();
  });

  it("reflects the wall a mirror faces, box-projected, and the sky outside the probe", async () => {
    // A mirror facing +z at the origin, seen head-on from +z: it reflects the +z wall (cyan).
    const mirror = { mesh: square([0, 0, 0], 2, 1, { metallic: 1, roughness: 0.05 }), model: IDENTITY };
    const inside = await frames([mirror], [0, 0, 2], [0, 0, 0]);
    const c = await readCentre(inside.texture, W, H);
    expect(c[1]).toBeGreaterThan(0.6);
    expect(c[2]).toBeGreaterThan(0.6);
    expect(c[0]).toBeLessThan(0.15);
    inside.renderer.dispose();
    // A sphere probe round the same point (F3b) projects the ray onto its sphere: the same wall, seen head-on.
    const ball: ReflectionProbe = { name: "ball", position: [0, 0, 0], min: [-3, -3, -3], max: [3, 3, 3], shape: "sphere", radius: 2.9 };
    const sphere = await frames([mirror], [0, 0, 2], [0, 0, 0], [ball]);
    const b = await readCentre(sphere.texture, W, H);
    expect(b[1]).toBeGreaterThan(0.6);
    expect(b[2]).toBeGreaterThan(0.6);
    expect(b[0]).toBeLessThan(0.15);
    sphere.renderer.dispose();
    // With the probe elsewhere, the mirror shows the black sky.
    const away: ReflectionProbe = { name: "elsewhere", position: [40, 0, 0], min: [37, -3, -3], max: [43, 3, 3] };
    const outside = await frames([mirror], [0, 0, 2], [0, 0, 0], [away]);
    const d = await readCentre(outside.texture, W, H);
    expect(Math.max(...d)).toBeLessThan(0.05);
    outside.renderer.dispose();
  });

  it("captures again when the key changes, a probe a frame, keeping an unmoved probe's cube meanwhile", async () => {
    const small: ReflectionProbe = { name: "nook", position: [1, 0, 0], min: [0, -1, -1], max: [2, 1, 1] };
    const { renderer } = await frames([], [0, 0, 2], [0, 0, 0], [PROBE, small]);
    const capture = (renderer as any).probeCapture;
    expect(capture.current.map((p: { probe: ReflectionProbe; ready: boolean }) => [p.probe.name, p.ready])).toEqual([
      ["nook", true],
      ["room", true],
    ]);
    // The sun moves and the room's probe moves: the nook (first) is captured again this frame and stays ready
    // throughout; the room isn't, until its turn next frame.
    const moved = { ...PROBE, position: [0, 0.5, 0] as [number, number, number] };
    const draw = (key: string) =>
      ({
        width: W,
        height: H,
        view: viewMatrix([0, 0, 2], [0, 0, 0]),
        projection: projectionMatrix(Math.PI / 4, 1, 0.05, 50),
        ambient: 0,
        lightDirection: [0, 1, 0],
        environment: { sky: [0, 0, 0], horizon: [0, 0, 0], ground: [0, 0, 0], intensity: 1 },
        lights: [],
        reflectionCapture: { probes: [moved, small], instances: room, key },
      }) as any;
    renderer.renderToTexture!(room, draw("sun moved"));
    expect(capture.current.map((p: { ready: boolean }) => p.ready)).toEqual([true, false]);
    expect(capture.settled).toBe(false);
    renderer.renderToTexture!(room, draw("sun moved"));
    expect(capture.current.map((p: { ready: boolean }) => p.ready)).toEqual([true, true]);
    expect(capture.settled).toBe(true);
    renderer.dispose();
  });
});
