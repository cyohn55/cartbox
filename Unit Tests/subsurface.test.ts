/**
 * Subsurface scattering and thin-surface transmission (AAA_FIDELITY_ROADMAP.md
 * F1d-2): the fields and their glTF form, the profiles and checkerboard the
 * pass reads, and, on a real device (Dawn), the blur conserving light,
 * spreading it across an edge (red farthest), and a back-lit leaf against the
 * path-traced reference (F10b).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_SUBSURFACE_COLOR, DEFAULT_SUBSURFACE_RADIUS, composeModelMatrix, encodeGlb, parseGlb, projectionMatrix, readGlb, readMaterialExtensions, resolveExtensions, viewMatrix, type DecodedTexture, type MeshAsset, type MeshMaterial, type MeshSceneInstance } from "@cartbox/editor";
import { MODELS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { PathTracer } from "../packages/player/src/render/pathTracer";
import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";
import { SSS_MAX_PROFILES, burleyWeight, holdsDiffuse, packSssProfiles } from "../packages/player/src/render/subsurface";

function quad(name: string, material: Partial<MeshMaterial> = {}): MeshAsset {
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name, baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1, ...material },
      },
    ],
  } as unknown as MeshAsset;
}

describe("the scattering fields", () => {
  it("reads and resolves subsurface and thin transmission, skin's profile by default", () => {
    expect(readMaterialExtensions({ subsurface: 2, subsurfaceRadius: 5, diffuseTransmission: 0.5, diffuseTransmissionColor: [1, 1, 1] })).toEqual({ subsurface: 1, subsurfaceRadius: 1, diffuseTransmission: 0.5 });
    expect(readMaterialExtensions({ subsurfaceColor: [1, 0, 0] })).toEqual({});
    const e = resolveExtensions({ name: "s", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, subsurface: 0.7 });
    expect(e.subsurface).toBe(0.7);
    expect(e.subsurfaceColor).toEqual(DEFAULT_SUBSURFACE_COLOR);
    expect(e.subsurfaceRadius).toBe(DEFAULT_SUBSURFACE_RADIUS);
  });

  it("writes thin transmission as KHR_materials_diffuse_transmission and scattering in the extras", () => {
    const bytes = encodeGlb(quad("g", { subsurface: 0.8, subsurfaceColor: [1, 0.5, 0.2], subsurfaceRadius: 0.02, diffuseTransmission: 0.4, diffuseTransmissionColor: [0.5, 1, 0.5] }));
    const { json } = readGlb(bytes);
    expect(json.extensionsUsed).toContain("KHR_materials_diffuse_transmission");
    expect((json.materials![0] as any).extras.cartboxSubsurface).toEqual({ factor: 0.8, color: [1, 0.5, 0.2], radius: 0.02 });
    const back = parseGlb(bytes).primitives[0]!.material;
    expect(back.subsurface).toBeCloseTo(0.8, 6);
    expect(back.subsurfaceRadius).toBeCloseTo(0.02, 6);
    expect(back.diffuseTransmission).toBeCloseTo(0.4, 6);
    expect(Array.from(back.diffuseTransmissionColor!)).toEqual([0.5, 1, 0.5]);
  });
});

describe("the SSS pass's inputs", () => {
  it("packs each material's scatter distances by its ID", () => {
    const packed = packSssProfiles([{ id: 3, color: [1, 0.5, 0.25], radius: 0.02 }, { id: 0, color: [1, 1, 1], radius: 1 }, { id: SSS_MAX_PROFILES, color: [1, 1, 1], radius: 1 }]);
    expect(Array.from(packed.slice(12, 16))).toEqual([0.02, 0.01, 0.005, 1].map(Math.fround));
    expect(packed.slice(0, 12).every((v) => v === 0)).toBe(true);
    expect(packed.length).toBe(SSS_MAX_PROFILES * 4);
  });

  it("falls off by Burley's profile and splits in a checkerboard", () => {
    expect(burleyWeight(0, 1)).toBe(2);
    expect(burleyWeight(1, 1)).toBeCloseTo(Math.exp(-1) + Math.exp(-1 / 3), 9);
    expect(burleyWeight(2, 1)).toBeLessThan(burleyWeight(1, 1));
    expect(holdsDiffuse(0, 0)).toBe(true);
    expect(holdsDiffuse(1, 0)).toBe(false);
    expect(holdsDiffuse(1, 1)).toBe(true);
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

const W = 48;
const H = 48;

describe.skipIf(!device)("scattering on a real device", { timeout: 300_000 }, () => {
  const camera = { view: viewMatrix([0, 0, 3], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50) };
  let renderer: WebgpuSceneRenderer;
  async function frame(instances: MeshSceneInstance[], draw: Record<string, unknown>): Promise<Float32Array> {
    renderer ??= (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, { width: W, height: H, ...camera, environment: null, lights: [], prepass: true, ambientOcclusion: false, ...draw } as any);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    return (await readLinearTexture(device, texture, W, H, settled)).data;
  }
  const at = (data: Float32Array, x: number, y: number) => [0, 1, 2].map((c) => data[(y * W + x) * 4 + c]!);
  const plane = (material: Partial<MeshMaterial>, extra: Partial<MeshSceneInstance> = {}) => [{ mesh: quad("p", material), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [2, 2, 1]), ...extra }] as unknown as MeshSceneInstance[];

  it("spreads light without gaining or losing it, and leaves no checkerboard", async () => {
    const flat = { ambient: 0.6, lightDirection: [0.3, 0.5, 0.8] };
    const plain = await frame(plane({}), flat);
    const scattered = await frame(plane({ subsurface: 1, subsurfaceRadius: 0.05 }), flat);
    // Middle 8×8: the same light, and neighbours alike.
    let a = 0;
    let b = 0;
    let jump = 0;
    for (let y = 20; y < 28; y += 1) {
      for (let x = 20; x < 28; x += 1) {
        a += at(plain, x, y)[1]!;
        b += at(scattered, x, y)[1]!;
        jump = Math.max(jump, Math.abs(at(scattered, x, y)[1]! - at(scattered, x + 1, y)[1]!));
      }
    }
    expect(Math.abs(b - a) / a).toBeLessThan(0.02);
    expect(jump).toBeLessThan(0.02 * (b / 64));
  });

  it("carries light across an edge, red the farthest", async () => {
    // Left half white, right half black, under a flat light.
    const strip: DecodedTexture = { width: 2, height: 1, data: Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255]) } as DecodedTexture;
    const flat = { ambient: 1, lightDirection: [0, 0, -1] };
    const material = { baseColorFactor: [1, 1, 1, 1] as [number, number, number, number] };
    const plain = await frame(plane(material, { textures: [strip] } as Partial<MeshSceneInstance>), flat);
    const scattered = await frame(plane({ ...material, subsurface: 1, subsurfaceRadius: 0.3 }, { textures: [strip] } as Partial<MeshSceneInstance>), flat);
    // The texture filters bilinearly across its middle: find where the plain frame's light has fallen to near nothing.
    const y = 24;
    let x = 24;
    while (x < W - 4 && at(plain, x, y)[0]! > 0.01) x += 1;
    const black = at(plain, x + 1, y);
    const bled = at(scattered, x + 1, y);
    expect(black[0]!).toBeLessThan(0.01);
    expect(bled[0]!).toBeGreaterThan(0.02);
    // Skin's profile: red scatters farthest, blue least.
    expect(bled[0]!).toBeGreaterThan(bled[2]! * 1.5);
  });

  it("lights a thin surface from behind, alike in the reference", async () => {
    const leaf = { baseColorFactor: [0.4, 0.8, 0.3, 1] as [number, number, number, number], diffuseTransmission: 0.6, diffuseTransmissionColor: [1, 0.9, 0.5] as [number, number, number] };
    const behind = { ambient: 0, lightDirection: [0, 0.3, -1] as [number, number, number] };
    const middle = (data: Float32Array) => {
      const sum = [0, 0, 0];
      for (let y = 20; y < 28; y += 1) for (let x = 20; x < 28; x += 1) at(data, x, y).forEach((v, c) => (sum[c] += v / 64));
      return sum;
    };
    const raster = middle(await frame(plane(leaf), behind));
    const opaque = middle(await frame(plane({ baseColorFactor: leaf.baseColorFactor }), behind));
    expect(opaque[1]!).toBeLessThan(0.01);
    expect(raster[1]!).toBeGreaterThan(0.1);
    const tracer = PathTracer.create(device);
    let texture: any = null;
    for (let i = 0; i < 8; i += 1) texture = tracer.render(plane(leaf), { ...camera, ...behind }, W, H, { samplesPerFrame: 16 });
    const traced = middle((await readLinearTexture(device, texture, W, H, settled)).data);
    tracer.destroy();
    raster.forEach((v, c) => expect(Math.abs(traced[c]! - v)).toBeLessThan(0.05 * Math.max(v, 0.02)));
  });
});
