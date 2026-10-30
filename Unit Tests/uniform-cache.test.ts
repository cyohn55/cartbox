/**
 * Per-draw uniforms written only when they change (AAA_FIDELITY_ROADMAP.md
 * F0e): the fields that are the frame's, and the draws that move by
 * themselves, on the CPU; and, on a real device (Dawn), a renderer that
 * keeps its slots stages the same bytes, frame after frame, as one that
 * writes every slot in full.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, type MeshAsset, type MeshMaterial, type MeshSceneInstance } from "@cartbox/editor";
import { MODELS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { UNIFORM_FLOATS, copyFrameUniform, uniformAnimates, writeInstanceUniform, type InstanceUniform } from "../packages/player/src/render/scenePacking";
import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";

const PBR: MeshMaterial = { name: "m", baseColorFactor: [0.8, 0.5, 0.3, 1], baseColorImage: null, metallicFactor: 0.2, roughnessFactor: 0.6 } as MeshMaterial;

/** A draw's uniform with every field set, and the frame's inputs from `seed`. */
function uniformFor(seed: number): InstanceUniform {
  const s = (k: number) => seed * 0.37 + k * 0.11;
  return {
    mvp: composeModelMatrix([1, 2, 3], [10, 20, 30], [1, 1, 1]),
    normalBasis: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    baseColor: [0.8, 0.5, 0.3, 1],
    hasTexture: true,
    light: { direction: [s(1), s(2), s(3)], ambient: s(4) } as InstanceUniform["light"],
    viewDir: [s(5), s(6), s(7)],
    pbr: { isPbr: true, metallic: 0.2, roughness: 0.6, emissive: [0.1, 0.2, 0.3] },
    hasMrMap: true,
    hasOcclusionMap: false,
    hasEmissiveMap: true,
    environment: { sky: [s(8), 0.5, 0.6], horizon: [0.7, s(9), 0.9], ground: [0.1, 0.2, s(10)], intensity: s(11), map: {} as never, average: [s(12), 0.3, 0.2], probes: null } as unknown as InstanceUniform["environment"],
    lightMvp: null,
    shadow: { size: 1024 + seed, bias: s(13), strength: s(14), slopeBias: s(15), pcf: true, soft: seed % 2 === 0 },
    tonemap: { exposure: s(16), authored: seed % 2 === 1 },
    hasSsao: seed % 2 === 0,
    hasLightmap: true,
    model: composeModelMatrix([1, 2, 3], [10, 20, 30], [1, 1, 1]),
    lightCount: 3 + seed,
    fog: {
      color: [s(17), 0.4, 0.5],
      density: s(18),
      start: s(19),
      max: 0.5,
      height: { density: s(20), base: s(21), falloff: s(22) },
      glow: { color: [s(23), 0.2, 0.1], strength: s(24) },
      volumes: [{ min: [0, 0, 0], max: [s(25), 2, 3], density: 0.2, falloff: 0.3 }],
    } as unknown as InstanceUniform["fog"],
    eye: [s(26), s(27), s(28)],
    time: s(29),
    frame: 7,
    camera: { right: [s(30), 0, 0], up: [0, s(31), 0], height: 720 + seed },
    alpha: { mode: 1, cutoff: 0.4 },
    materialId: 3,
    motionBase: 12,
    instanceBase: 40,
    lightChannels: 2,
    probeCount: 1 + seed,
    receivesDecals: true,
    lodLevel: 1,
  };
}

describe("a draw's uniform, from frame to frame", () => {
  it("takes every change in the frame's inputs from the frame's fields alone", () => {
    for (const seed of [1, 2, 3]) {
      const kept = new Float32Array(UNIFORM_FLOATS * 2);
      writeInstanceUniform(kept, 1, uniformFor(0));
      const frame = new Float32Array(UNIFORM_FLOATS);
      writeInstanceUniform(frame, 0, uniformFor(seed));
      copyFrameUniform(kept, 1, frame);
      const full = new Float32Array(UNIFORM_FLOATS * 2);
      writeInstanceUniform(full, 1, uniformFor(seed));
      expect([...kept]).toEqual([...full]);
    }
  });

  it("knows the draws that move by themselves", () => {
    expect(uniformAnimates(PBR, 0, false, false, null)).toBe(false);
    expect(uniformAnimates(PBR, 2, false, false, null)).toBe(false); // blended, but no soft edge
    expect(uniformAnimates({ ...PBR, softDepth: 0.5 } as MeshMaterial, 2, false, false, null)).toBe(true);
    expect(uniformAnimates(PBR, 0, true, false, null)).toBe(true); // sways
    expect(uniformAnimates(PBR, 0, false, true, null)).toBe(true); // refracts
    expect(uniformAnimates({ ...PBR, water: { strength: 1, scale: 2, speed: 1, flow: 0 } } as MeshMaterial, 0, false, false, null)).toBe(true);
    expect(uniformAnimates({ ...PBR, water: { strength: 0, scale: 2, speed: 1, flow: 0 } } as MeshMaterial, 0, false, false, null)).toBe(false);
    expect(uniformAnimates({ ...PBR, emissiveScroll: [0.3, 0] } as MeshMaterial, 0, false, false, null)).toBe(true);
    expect(uniformAnimates({ ...PBR, emissivePulse: { rate: 1, depth: 0.5 } } as MeshMaterial, 0, false, false, null)).toBe(true);
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
  for (let i = 0; i < 4000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

function box(name: string, material: Partial<MeshMaterial>, sway = false): MeshAsset {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const [n, u, v] of [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ] as [number[], number[], number[]][]) {
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      positions.push(...[0, 1, 2].map((k) => 0.5 * (n[k]! + a * u[k]! + b * v[k]!)));
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from(positions),
        normals: Float32Array.from(normals),
        uvs: new Float32Array((positions.length / 3) * 2),
        indices: Uint32Array.from(indices),
        ...(sway ? { sway: Float32Array.from({ length: positions.length / 3 }, (_, i) => (i % 2) * 0.3) } : {}),
        material: { ...PBR, name, ...material },
      },
    ],
  } as unknown as MeshAsset;
}

describe.skipIf(!device)("kept uniforms on a real device", { timeout: 300_000 }, () => {
  it("stages the bytes a full write would, as the camera, the time and the scene change", async () => {
    const W = 64;
    const H = 64;
    const meshes = [
      box("plain", {}),
      box("metal", { metallicFactor: 1, roughnessFactor: 0.2 }),
      box("water", { water: { strength: 1, scale: 2, speed: 1, flow: 0.5 } } as Partial<MeshMaterial>),
      box("scroll", { emissiveFactor: [1, 0.5, 0], emissiveScroll: [0.3, 0.1] } as Partial<MeshMaterial>),
      box("sway", {}, true),
      box("glass", { baseColorFactor: [0.6, 0.7, 0.9, 0.4], alphaMode: "BLEND", softDepth: 0.5 } as Partial<MeshMaterial>),
    ];
    const moving = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) as unknown as Float32Array;
    const instances = (frame: number): MeshSceneInstance[] => {
      // The first copy's model changes in place from frame 2; from frame 3 the draws come in another order.
      if (frame >= 2) moving.set(composeModelMatrix([frame * 0.3, 0, 0], [0, frame * 10, 0], [1, 1, 1]), 0);
      const list = meshes.map((mesh, i) => ({ mesh, model: i === 0 ? moving : composeModelMatrix([(i % 3) * 2 - 2, Math.floor(i / 3) * 2 - 1, -i], [i * 15, i * 25, 0], [0.8, 0.8, 0.8]) }));
      return (frame >= 3 ? list.reverse() : list) as unknown as MeshSceneInstance[];
    };
    const draw = (frame: number) =>
      ({
        width: W,
        height: H,
        view: viewMatrix([Math.sin(frame * 0.2) * 3, 1, 9], [0, 0, 0]),
        projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
        environment: null,
        lights: [],
        ambient: 0.3,
        lightDirection: [0.3, 1, 0.6 + frame * 0.01],
        prepass: true,
        gpuCull: true,
        lod: true,
        time: frame * 0.25,
        wind: { direction: frame * 0.1, strength: 0.5, gust: 0.2 },
        fog: { color: [0.5, 0.6, 0.7], density: 0.02, start: 2, max: 0.6 },
      }) as any;
    const kept = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    const full = (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    let copied = 0;
    for (let frame = 0; frame < 6; frame += 1) {
      const before = (kept as any).uniformKeys.map((k: unknown) => k);
      await readLinearTexture(device, kept.renderToTexture(instances(frame), draw(frame)), W, H, settled);
      // Forget what the slots held, so every one is written in full.
      (full as any).uniformKeysFor = null;
      await readLinearTexture(device, full.renderToTexture(instances(frame), draw(frame)), W, H, settled);
      const slots = meshes.length;
      const a = (kept as any).uniformData.subarray(0, slots * UNIFORM_FLOATS);
      const b = (full as any).uniformData.subarray(0, slots * UNIFORM_FLOATS);
      expect([...a]).toEqual([...b]);
      copied += (kept as any).uniformKeys.slice(0, slots).filter((k: unknown, i: number) => k === before[i]).length;
    }
    // The still draws kept their slots on the frames nothing about them changed.
    expect(copied).toBeGreaterThan(4);
    kept.dispose();
    full.dispose();
  });
});
