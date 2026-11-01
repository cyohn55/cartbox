/**
 * Baked probe volumes (AAA_FIDELITY_ROADMAP.md F3d-3): their storage, the
 * sampling every shader mirrors (DDGI's visibility stopping light leaking
 * through a wall), the ambient cubes every other tier reads, and on a real
 * device, bakes checked against what can be worked out by hand.
 */

import { describe, expect, it } from "vitest";

import {
  PROBE_DEPTH_SIDE,
  PROBE_SH,
  ambientCubesFromVolume,
  decodeProbeVolume,
  encodeProbeVolume,
  octEncode,
  octTexel,
  planProbeVolume,
  probeIrradiance,
  sampleProbeVolume,
  MAX_PROBE_VOLUME_AXIS,
  composeModelMatrix,
  projectionMatrix,
  viewMatrix,
  type EnvironmentLight,
  type MeshAsset,
  type MeshSceneInstance,
  type ProbeVolume,
} from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";
import { defaultSceneLighting, parseSceneLighting, sceneLightingEnvironment } from "@cartbox/editor";
import { bakeSceneLighting, clearSceneLighting } from "../apps/web/src/lib/lightBake";
import { addMesh, emptyMeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { bakeProbeVolumeGpu } from "../packages/player/src/render/gpuLightmapper";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DEPTH = PROBE_DEPTH_SIDE * PROBE_DEPTH_SIDE;

/** An octahedral depth texel's centre direction (the inverse of octEncode). */
function octDirection(t: number): [number, number, number] {
  const u = (((t % PROBE_DEPTH_SIDE) + 0.5) / PROBE_DEPTH_SIDE) * 2 - 1;
  const v = ((Math.floor(t / PROBE_DEPTH_SIDE) + 0.5) / PROBE_DEPTH_SIDE) * 2 - 1;
  const y = 1 - Math.abs(u) - Math.abs(v);
  const [x, z] = y >= 0 ? [u, v] : [(1 - Math.abs(v)) * Math.sign(u), (1 - Math.abs(u)) * Math.sign(v)];
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/** Put a wall 1 m from every bright (x = 0) probe in a 2³ volume, in the directions that head toward +x. */
function wallBrightProbes(volume: ProbeVolume): ProbeVolume {
  for (let p = 0; p < 8; p += 2) for (let t = 0; t < DEPTH; t += 1) if (octDirection(t)[0] > 0) volume.depth.set([1, 1.0001], (p * DEPTH + t) * 2);
  return volume;
}

/** A volume whose probes each give a uniform irradiance `level(probe)` and see `far` metres every way. */
function uniformVolume(counts: [number, number, number], min: [number, number, number], max: [number, number, number], level: (x: number, y: number, z: number) => number, far = 10): ProbeVolume {
  const n = counts[0] * counts[1] * counts[2];
  const sh = new Float32Array(n * PROBE_SH * 3);
  for (let z = 0; z < counts[2]; z += 1) for (let y = 0; y < counts[1]; y += 1) for (let x = 0; x < counts[0]; x += 1) {
    const p = (z * counts[1] + y) * counts[0] + x;
    sh.fill(level(x, y, z) / 0.282095, p * PROBE_SH * 3, p * PROBE_SH * 3 + 3);
  }
  const depth = new Float32Array(n * DEPTH * 2);
  for (let i = 0; i < n * DEPTH; i += 1) depth.set([far, far * far], i * 2);
  return { min, max, counts, sh, visibility: new Float32Array(n).fill(1), valid: new Uint8Array(n).fill(1), depth };
}

describe("probe volumes", () => {
  it("plan at most MAX_PROBE_VOLUME_AXIS a side, so the volume texture stays within a 3D texture's width", () => {
    const counts = planProbeVolume([0, 0, 0], [400, 4, 4], 1);
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_PROBE_VOLUME_AXIS);
    expect(planProbeVolume([0, 0, 0], [5, 5, 5], 2.5)).toEqual([3, 3, 3]);
  });

  it("map directions octahedrally, every texel a direction's", () => {
    expect(octEncode([0, 1, 0])).toEqual([0.5, 0.5]);
    for (let t = 0; t < DEPTH; t += 1) expect(octTexel(octDirection(t))).toBe(t);
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i += 1) {
      const y = 1 - (2 * i + 1) / 4000;
      const r = Math.sqrt(1 - y * y);
      seen.add(octTexel([r * Math.cos(i * 2.4), y, r * Math.sin(i * 2.4)]));
    }
    expect(seen.size).toBe(DEPTH);
  });

  it("round-trip through storage as half floats", () => {
    const volume = uniformVolume([2, 3, 2], [0, 0, 0], [1, 2, 1], (x, y) => 0.25 + x * 0.5 + y * 0.125, 3.5);
    volume.valid[4] = 0;
    volume.visibility[2] = 0.375;
    const back = decodeProbeVolume(JSON.parse(JSON.stringify(encodeProbeVolume(volume))))!;
    expect(back.counts).toEqual([2, 3, 2]);
    expect([...back.valid]).toEqual([...volume.valid]);
    back.sh.forEach((v, i) => expect(Math.abs(v - volume.sh[i]!)).toBeLessThan(Math.abs(volume.sh[i]!) * 1e-3 + 1e-6));
    expect(back.visibility[2]).toBe(0.375);
    expect(back.depth[0]).toBe(3.5);
    expect(decodeProbeVolume({ ...encodeProbeVolume(volume), counts: [2, 3, 3] })).toBeNull();
  });

  it("give the probes' irradiance between them, trilinearly, where every probe sees the point", () => {
    const volume = uniformVolume([2, 2, 2], [0, 0, 0], [2, 2, 2], (x) => (x === 0 ? 1 : 0));
    const at = (x: number) => sampleProbeVolume(volume, [x, 1, 1], [0, 1, 0])![0];
    expect(at(0)).toBeCloseTo(1, 3);
    expect(at(2)).toBeCloseTo(0, 3);
    expect(at(1)).toBeGreaterThan(0.3);
    expect(at(1)).toBeLessThan(0.7);
  });

  it("keep a bright probe's light from leaking through a wall it can see, to a point behind it", () => {
    // Bright probes at x = 0, dark ones at x = 2; a wall at x = 1 that the bright ones see 1 m away in +x.
    const volume = uniformVolume([2, 2, 2], [0, 0, 0], [2, 2, 2], (x) => (x === 0 ? 1 : 0));
    const open = sampleProbeVolume(volume, [1.4, 1, 1], [-1, 0, 0])![0];
    wallBrightProbes(volume);
    const walled = sampleProbeVolume(volume, [1.4, 1, 1], [-1, 0, 0])![0];
    expect(open).toBeGreaterThan(0.3);
    expect(walled).toBeLessThan(0.05);
  });

  it("skip invalid probes, and give nothing where no probe is valid", () => {
    const volume = uniformVolume([2, 2, 2], [0, 0, 0], [2, 2, 2], (x) => (x === 0 ? 1 : 0));
    for (let p = 0; p < 8; p += 2) volume.valid[p] = 0;
    expect(sampleProbeVolume(volume, [0.2, 1, 1], [0, 1, 0])![0]).toBeCloseTo(0, 5);
    volume.valid.fill(0);
    expect(sampleProbeVolume(volume, [0.2, 1, 1], [0, 1, 0])).toBeNull();
  });

  it("derive the other tiers' ambient cubes: the irradiance over the open sky's, invalid probes from their neighbours", () => {
    const volume = uniformVolume([2, 2, 2], [0, 0, 0], [2, 2, 2], (x) => (x === 0 ? 0.5 : 1));
    volume.valid[1] = 0;
    const cubes = ambientCubesFromVolume(volume, () => [1, 1, 1], 1.5);
    expect(cubes.values[0]).toBeCloseTo(0.5, 3);
    expect(cubes.values[3 * 18]).toBeCloseTo(1, 3);
    // Probe 1 (x = 1, invalid) from its valid neighbours: probe 0 (0.5) and probes 3 and 5 (1).
    expect(cubes.values[18]).toBeGreaterThan(0.5);
    expect(cubes.values[18]).toBeLessThan(1);
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
  for (let i = 0; i < 40_000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    device.tick?.();
  }
  return promise;
}

const uniformSky = (l: number) => ({ width: 4, height: 2, data: new Float32Array(32).map((_, i) => (i % 4 === 3 ? 1 : l)) });

function quads(list: readonly { corner: number[]; u: number[]; v: number[]; normal: number[] }[], colour = [0.5, 0.5, 0.5]): MeshAsset {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (const { corner, u, v, normal } of list) {
    const base = positions.length / 3;
    for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      positions.push(...corner.map((c, i) => c + u[i]! * a! + v[i]! * b!));
      normals.push(...normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    name: "quads",
    primitives: [{ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: null, indices: Uint32Array.from(indices), material: { name: "m", baseColorImage: null, baseColorFactor: [colour[0]!, colour[1]!, colour[2]!, 1] } }],
  } as unknown as MeshAsset;
}

describe.skipIf(!device)("baking a probe volume, on a real device", { timeout: 300_000 }, () => {
  async function bake(meshes: readonly MeshAsset[], min: [number, number, number], max: [number, number, number], counts: [number, number, number], options: Parameters<typeof bakeProbeVolumeGpu>[5]) {
    device.pushErrorScope("validation");
    const volume = await settled(bakeProbeVolumeGpu(device, min, max, counts, meshes.map((mesh) => ({ mesh, model: IDENTITY })), options));
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    return volume;
  }

  it("under a uniform sky with nothing round it: the sky's radiance every way, all of the sky, open to the cap", async () => {
    const volume = await bake([], [0, 0, 0], [2, 2, 2], [2, 2, 2], { rays: 256, sky: uniformSky(0.7) });
    expect([...volume.valid]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    for (const n of [[0, 1, 0], [1, 0, 0], [0, -1, 0], [0.6, 0, -0.8]] as const) for (const c of probeIrradiance(volume, 0, n)) expect(c).toBeCloseTo(0.7, 2);
    expect(volume.visibility[0]).toBeCloseTo(1, 5);
    expect(volume.depth[0]).toBeCloseTo(3, 5); // 1.5 × the 2 m spacing
  });

  it("a metre over a wide grey floor: the sky above, the floor's bounce below, and the floor a metre down", async () => {
    const floor = quads([{ corner: [-20, 0, -20], u: [40, 0, 0], v: [0, 0, 40], normal: [0, 1, 0] }]);
    const volume = await bake([floor], [-1, 1, -1], [1, 3, 1], [2, 2, 2], { rays: 2048, bounces: 2, sky: uniformSky(1) });
    const up = probeIrradiance(volume, 0, [0, 1, 0])[1];
    const down = probeIrradiance(volume, 0, [0, -1, 0])[1];
    // Facing down, the floor's radiance: its linear albedo (0.214) under the sky's irradiance of 1.
    const albedo = ((0.5 + 0.055) / 1.055) ** 2.4;
    expect(up).toBeGreaterThan(0.93);
    expect(up).toBeLessThan(1.07);
    expect(down / albedo).toBeGreaterThan(0.85);
    expect(down / albedo).toBeLessThan(1.15);
    expect(volume.visibility[0]).toBeGreaterThan(0.45);
    expect(volume.visibility[0]).toBeLessThan(0.55);
    const below = volume.depth[(0 * DEPTH + octTexel([0, -1, 0])) * 2]!;
    expect(below).toBeGreaterThan(0.95);
    expect(below).toBeLessThan(1.15);
  });

  it("drops a probe inside a closed box", async () => {
    const d = 0.5;
    const box = quads([
      { corner: [-d, d, -d], u: [2 * d, 0, 0], v: [0, 0, 2 * d], normal: [0, 1, 0] },
      { corner: [-d, -d, -d], u: [2 * d, 0, 0], v: [0, 0, 2 * d], normal: [0, -1, 0] },
      { corner: [d, -d, -d], u: [0, 2 * d, 0], v: [0, 0, 2 * d], normal: [1, 0, 0] },
      { corner: [-d, -d, -d], u: [0, 2 * d, 0], v: [0, 0, 2 * d], normal: [-1, 0, 0] },
      { corner: [-d, -d, d], u: [2 * d, 0, 0], v: [0, 2 * d, 0], normal: [0, 0, 1] },
      { corner: [-d, -d, -d], u: [2 * d, 0, 0], v: [0, 2 * d, 0], normal: [0, 0, -1] },
    ]);
    // Probes at x = 0 (inside the box) and x = 3 (outside).
    const volume = await bake([box], [0, 0, 0], [3, 3, 3], [2, 2, 2], { rays: 128, sky: uniformSky(1) });
    expect(volume.valid[0]).toBe(0);
    expect(volume.valid[1]).toBe(1);
  });
});

function half(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024);
}

describe.skipIf(!device)("the AAA tier lit by a probe volume, on a real device", { timeout: 120_000 }, () => {
  const W = 32;
  const H = 32;
  const SKY: EnvironmentLight = { sky: [0.6, 0.7, 0.9], horizon: [0.8, 0.8, 0.8], ground: [0.3, 0.3, 0.3], intensity: 1 } as EnvironmentLight;
  // A rough white floor at y = 1 across the volume, with no light map: what moves is lit like this.
  const floor = {
    name: "floor",
    primitives: [
      {
        positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
      },
    ],
  } as unknown as MeshAsset;

  /** The floor's linear green at the frame's centre, looking straight down at (x, 1, 1). */
  async function shade(volume: ProbeVolume | null, x: number, hdr = true): Promise<number> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr }))!;
    const instances: MeshSceneInstance[] = [{ mesh: floor, model: composeModelMatrix([1, 1, 1], [0, 0, 0], [1, 1, 1]) }];
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, {
      width: W,
      height: H,
      view: viewMatrix([x, 3, 1.001], [x, 1, 1]),
      projection: projectionMatrix(Math.PI / 6, 1, 0.1, 50),
      ambient: 0,
      lightDirection: [0, -1, 0],
      environment: { ...SKY, ...(volume ? { probeVolume: volume } : {}) },
    } as any);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const bytesPerRow = 256;
    const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const mapped = buffer.getMappedRange().slice(0);
    buffer.unmap();
    buffer.destroy();
    renderer.dispose();
    if (!hdr) return new Uint8Array(mapped)[(H >> 1) * bytesPerRow + (W >> 1) * 4 + 1]! / 255;
    return half(new Uint16Array(mapped)[((H >> 1) * bytesPerRow) / 2 + (W >> 1) * 4 + 1]!);
  }

  // Bright probes at x = 0, dark at x = 2; no sky visible, so the reflection is gone and the diffuse alone is measured.
  const lit = () => {
    const volume = uniformVolume([2, 2, 2], [0, 0, 0], [2, 2, 2], (x) => (x === 0 ? 1 : 0));
    volume.visibility.fill(0);
    return volume;
  };

  it("lights a surface without a light map by the volume, as sampleProbeVolume says", async () => {
    for (const x of [0.5, 1, 1.5]) {
      const want = sampleProbeVolume(lit(), [x, 1, 1], [0, 1, 0])![1];
      const got = await shade(lit(), x);
      // The diffuse of a rough white dielectric: the irradiance, less the few % the reflection takes.
      expect(got).toBeGreaterThan(want * 0.9);
      expect(got).toBeLessThan(want * 1.01 + 0.002);
    }
    // Without a volume, the sky's irradiance lights it instead (about 0.5 here).
    expect(await shade(null, 1.5)).toBeGreaterThan(0.3);
  });

  it("keeps the bright probes' light behind a wall they see, as the mirror does", async () => {
    const walled = wallBrightProbes(lit());
    const open = await shade(lit(), 1.4);
    const behind = await shade(walled, 1.4);
    expect(open).toBeGreaterThan(0.2);
    expect(behind).toBeLessThan(0.05);
    expect(Math.abs(behind - sampleProbeVolume(walled, [1.4, 1, 1], [0, 1, 0])![1])).toBeLessThan(0.02);
  });

  it("leaves the byte path to the ambient cubes", async () => {
    expect(await shade(lit(), 1, false)).toBe(await shade(null, 1, false));
  });
});

describe.skipIf(!device)("the editor's probe bake on the GPU", { timeout: 300_000 }, () => {
  it("stores a probe volume the environment hands the AAA tier, with the ambient cubes beside it; a CPU rebake or a clear takes it away", async () => {
    let sidecar = { ...emptyMeshSidecar(), lighting: defaultSceneLighting() };
    sidecar = addMesh(sidecar, quads([{ corner: [-3, 0, -3], u: [6, 0, 0], v: [0, 0, 6], normal: [0, 1, 0] }]), "floor").sidecar;
    const baked = await settled(bakeSceneLighting(sidecar, { density: 2, rays: 4, bounces: 2, probeSpacing: 2, device }));
    const lighting = parseSceneLighting(JSON.parse(JSON.stringify(baked.lighting)))!;
    expect(lighting.probeVolume).toBeTruthy();
    expect(lighting.lightProbes).toBeTruthy();
    const env = sceneLightingEnvironment(lighting);
    expect(env.probeVolume!.counts).toEqual(lighting.probeVolume!.counts);
    expect(env.lightProbes!.counts).toEqual(lighting.probeVolume!.counts);
    // Above open floor under the rig's sky, every probe is valid and lit from above.
    expect([...env.probeVolume!.valid].every((v) => v === 1)).toBe(true);
    expect(probeIrradiance(env.probeVolume!, env.probeVolume!.valid.length - 1, [0, 1, 0])[1]).toBeGreaterThan(0.05);
    const cpu = await bakeSceneLighting(baked, { density: 2, rays: 4, probeSpacing: 2 });
    expect(cpu.lighting!.probeVolume).toBeUndefined();
    expect(cpu.lighting!.lightProbes).toBeTruthy();
    const cleared = clearSceneLighting(baked);
    expect(cleared.lighting!.probeVolume).toBeUndefined();
    expect(cleared.lighting!.lightProbes).toBeUndefined();
  });
});
