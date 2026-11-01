/**
 * The full material set (AAA_FIDELITY_ROADMAP.md F1d): the KHR extensions'
 * fields read, resolved and written, the glTF round trip, the CPU mirrors of
 * the shader's terms, the uniform rows, and, on a real device (Dawn), the
 * linear-light renderer against the path-traced reference (F10b) for each.
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  encodeGlb,
  iridescenceFresnel,
  materialHasExtensions,
  parseGlb,
  projectionMatrix,
  readGlb,
  readMaterialExtensions,
  resolveExtensions,
  sheenAlbedo,
  transformUv,
  viewMatrix,
  volumeTransmittance,
  type DecodedTexture,
  type MeshAsset,
  type MeshMaterial,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { MODELS, UNIFORM_FLOATS, WebgpuSceneRenderer, rasterStyleFor, writeInstanceUniform } from "@cartbox/player";

import { PathTracer, type ReferenceDraw } from "../packages/player/src/render/pathTracer";
import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";

const srgb = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function quad(name: string, material: Partial<MeshMaterial> = {}): MeshAsset {
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name, baseColorFactor: [0.8, 0.4, 0.2, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.6, ...material },
      },
    ],
  } as unknown as MeshAsset;
}

const base = { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } as MeshMaterial;

describe("the material set's fields", () => {
  it("reads each field clamped, and drops what is neutral or malformed", () => {
    const read = readMaterialExtensions({
      sheenColor: [2, 0.5, -1],
      sheenRoughness: 3,
      transmission: 0.5,
      thickness: -1,
      attenuationColor: [1, 1, 1],
      ior: 1.5,
      specularFactor: 1,
      specularColor: [1, 0.5, 1],
      iridescence: 1,
      iridescenceThickness: 9999,
      emissiveStrength: 5,
      uvTransform: { offset: [0.5, 0], rotation: 0, scale: [1, 1] },
    });
    expect(read).toEqual({
      sheenColor: [1, 0.5, 0],
      sheenRoughness: 1,
      transmission: 0.5,
      specularColor: [1, 0.5, 1],
      iridescence: 1,
      iridescenceThickness: 2000,
      emissiveStrength: 5,
      uvTransform: { offset: [0.5, 0], rotation: 0, scale: [1, 1] },
    });
    expect(readMaterialExtensions({ uvTransform: { offset: [0, 0], rotation: 0, scale: [1, 1] }, sheenColor: [0, 0, 0], ior: "x" })).toEqual({});
    expect(materialHasExtensions(base)).toBe(false);
    expect(materialHasExtensions({ ...base, transmission: 1 })).toBe(true);
  });

  it("resolves a dielectric's reflectance from its IOR and specular", () => {
    expect(resolveExtensions(base).dielectricF0[0]).toBeCloseTo(0.04, 6);
    expect(resolveExtensions({ ...base, ior: 2 }).dielectricF0[0]).toBeCloseTo(1 / 9, 6);
    const tinted = resolveExtensions({ ...base, specularFactor: 0.5, specularColor: [1, 0.5, 0] });
    [0.02, 0.01, 0].forEach((v, i) => expect(tinted.dielectricF0[i]).toBeCloseTo(v, 9));
    expect(tinted.specularFactor).toBe(0.5);
    // glTF's IOR of 0: a full reflector.
    expect(resolveExtensions({ ...base, ior: 0 }).dielectricF0).toEqual([1, 1, 1]);
  });

  it("transforms UVs in glTF's space, V flipped", () => {
    expect(transformUv(0.3, 0.6, null)).toEqual([0.3, 0.6]);
    const shift = { offset: [0.25, 0.1] as const, rotation: 0, scale: [1, 1] as const };
    const [u, v] = transformUv(0.3, 0.6, shift);
    expect(u).toBeCloseTo(0.55, 6);
    // glTF's V runs down: an offset of 0.1 moves the engine's V down by 0.1.
    expect(v).toBeCloseTo(0.5, 6);
    const scaled = transformUv(0.3, 1, { offset: [0, 0], rotation: 0, scale: [2, 3] });
    expect(scaled[0]).toBeCloseTo(0.6, 6);
    expect(scaled[1]).toBeCloseTo(1, 6);
    // A quarter turn takes glTF's (u, v) = (1, 0) to (0, −1).
    const turned = transformUv(1, 1, { offset: [0, 0], rotation: Math.PI / 2, scale: [1, 1] });
    expect(turned[0]).toBeCloseTo(0, 6);
    expect(turned[1]).toBeCloseTo(2, 6);
  });

  it("evaluates a thin film, the sheen's albedo and a volume's absorption", () => {
    // No film: about the base's own reflectance head-on (the interference series' first terms stay, as glTF's viewer has them).
    const bare = iridescenceFresnel(1, 1.3, 1, 0, [0.04, 0.04, 0.04]);
    bare.forEach((c) => expect(Math.abs(c - 0.04)).toBeLessThan(0.01));
    // A 400 nm film colours it, and the colour shifts with the angle.
    const head = iridescenceFresnel(1, 1.3, 1, 400, [0.04, 0.04, 0.04]);
    const tilted = iridescenceFresnel(1, 1.3, 0.5, 400, [0.04, 0.04, 0.04]);
    expect(Math.max(...head) - Math.min(...head)).toBeGreaterThan(0.01);
    expect(head).not.toEqual(tilted);
    for (const r of [0.2, 0.5, 1]) {
      const e = sheenAlbedo(0.7, r);
      expect(e).toBeGreaterThan(0);
      expect(e).toBeLessThan(1);
    }
    expect(volumeTransmittance([0.5, 1, 0.25], 1, 2)).toEqual([0.25, 1, 0.0625]);
    expect(volumeTransmittance([0.5, 0.5, 0.5], 0, 2)).toEqual([1, 1, 1]);
  });

  it("writes each into the draw's uniform", () => {
    const out = new Float32Array(UNIFORM_FLOATS);
    const uniform = {
      mvp: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      normalBasis: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      baseColor: [1, 1, 1, 1] as const,
      hasTexture: false,
      light: { direction: [0, 1, 0] as const, ambient: 0.3 },
      viewDir: [0, 0, 1] as const,
      pbr: { isPbr: true, metallic: 0, roughness: 1, emissive: [0, 0, 0] as const },
      hasMrMap: false,
      hasOcclusionMap: false,
      hasEmissiveMap: false,
      environment: null,
      lightMvp: null,
      shadow: null,
      tonemap: null,
      hasSsao: false,
      model: null,
      lightCount: 0,
    };
    writeInstanceUniform(out, 0, uniform);
    // The defaults: a 4% dielectric of IOR 1.5, strength 1, no transform.
    expect(Array.from(out.slice(240, 248))).toEqual([0.04, 0.04, 0.04, 1, 0, 0, 0, 1.5].map(Math.fround));
    expect(out[254]).toBe(1);
    expect(out[255]).toBe(0);
    const e = resolveExtensions({ ...base, sheenColor: [1, 0.5, 0.25], sheenRoughness: 0.4, transmission: 0.7, emissiveStrength: 3, uvTransform: { offset: [0.1, 0.2], rotation: Math.PI, scale: [2, 2] } });
    writeInstanceUniform(out, 0, { ...uniform, extensions: e });
    expect(Array.from(out.slice(236, 240))).toEqual([1, 0.5, 0.25, 0.4].map(Math.fround));
    expect(out[244]).toBeCloseTo(0.7, 6);
    expect(out[254]).toBe(3);
    expect(out[255]).toBe(1);
    expect(out[258]).toBeCloseTo(-1, 6);
    expect(Array.from(out.slice(260, 262))).toEqual([0.1, 0.2].map(Math.fround));
  });
});

describe("the material set in glTF", () => {
  it("writes each KHR extension and reads it back", () => {
    const material: Partial<MeshMaterial> = {
      sheenColor: [0.5, 0.25, 1],
      sheenRoughness: 0.3,
      transmission: 0.8,
      thickness: 0.02,
      attenuationDistance: 0.5,
      attenuationColor: [0.9, 0.5, 0.2],
      ior: 1.33,
      specularFactor: 0.7,
      specularColor: [1, 0.9, 0.8],
      iridescence: 0.6,
      iridescenceIor: 1.4,
      iridescenceThickness: 550,
      emissiveStrength: 8,
      emissiveFactor: [1, 0.5, 0],
    };
    const bytes = encodeGlb(quad("k", material));
    const { json } = readGlb(bytes);
    const used = json.extensionsUsed ?? [];
    for (const name of ["KHR_materials_sheen", "KHR_materials_transmission", "KHR_materials_volume", "KHR_materials_ior", "KHR_materials_specular", "KHR_materials_iridescence", "KHR_materials_emissive_strength"]) {
      expect(used).toContain(name);
      expect(Object.keys(json.materials![0]!.extensions ?? {})).toContain(name);
    }
    const back = parseGlb(bytes).primitives[0]!.material;
    for (const [key, value] of Object.entries(material)) {
      if (Array.isArray(value)) (value as number[]).forEach((v, i) => expect((back as any)[key][i]).toBeCloseTo(v, 5));
      else if (typeof value === "number") expect((back as any)[key]).toBeCloseTo(value, 5);
    }
  });

  it("writes a texture's transform on each of its maps, and reads the first", () => {
    const image = { mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) };
    const bytes = encodeGlb(quad("t", { baseColorImage: image, uvTransform: { offset: [0.5, 0], rotation: 0, scale: [1, 1] } }));
    const { json } = readGlb(bytes);
    expect(json.extensionsUsed).toContain("KHR_texture_transform");
    expect(json.materials![0]!.pbrMetallicRoughness!.baseColorTexture!.extensions!.KHR_texture_transform!.offset).toEqual([0.5, 0]);
    expect(parseGlb(bytes).primitives[0]!.material.uvTransform!.offset).toEqual([0.5, 0]);
    // A plain material writes none.
    expect(readGlb(encodeGlb(quad("p"))).json.extensionsUsed ?? []).not.toContain("KHR_materials_ior");
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

const W = 16;
const H = 16;

describe.skipIf(!device)("the material set on a real device, against the reference", { timeout: 300_000 }, () => {
  const camera = { view: viewMatrix([0, 0, 3], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50) };
  const key = { ambient: 0, lightDirection: [0, 0.6, 0.8] as [number, number, number] };
  const middle = (data: Float32Array): number[] => {
    const sum = [0, 0, 0, 0];
    for (let y = H / 2 - 2; y < H / 2 + 2; y += 1) for (let x = W / 2 - 2; x < W / 2 + 2; x += 1) for (let c = 0; c < 4; c += 1) sum[c] += data[(y * W + x) * 4 + c]! / 16;
    return sum;
  };

  let renderer: WebgpuSceneRenderer;
  async function rastered(instances: MeshSceneInstance[], draw: Partial<ReferenceDraw>): Promise<number[]> {
    // As the AAA tier makes it: textures filtered, with mips (F1a).
    renderer ??= (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, { width: W, height: H, ...camera, environment: null, lights: [], ...draw } as any);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    return middle((await readLinearTexture(device, texture, W, H, settled)).data);
  }
  async function traced(instances: MeshSceneInstance[], draw: Partial<ReferenceDraw>, samples = 256): Promise<number[]> {
    const tracer = PathTracer.create(device);
    let texture: any = null;
    for (let i = 0; i < samples / 32; i += 1) texture = tracer.render(instances, { ...camera, ...draw }, W, H, { samplesPerFrame: 32 });
    const out = middle((await readLinearTexture(device, texture, W, H, settled)).data);
    tracer.destroy();
    return out;
  }
  const plane = (material: Partial<MeshMaterial>, extra: Partial<MeshSceneInstance> = {}) => [{ mesh: quad("p", material), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [2, 2, 1]), ...extra }] as unknown as MeshSceneInstance[];
  const near = (got: number[], want: number[], tolerance: number) => want.slice(0, 3).forEach((w, c) => expect(Math.abs(got[c]! - w)).toBeLessThanOrEqual(tolerance * Math.max(w, 0.02)));
  const both = async (instances: MeshSceneInstance[], draw: Partial<ReferenceDraw> = key, tolerance = 0.05) => {
    const r = await rastered(instances, draw);
    const t = await traced(instances, draw);
    near(t, r, tolerance);
    return r;
  };

  it("reflects more from a higher IOR, alike in both", async () => {
    const plain = await both(plane({ baseColorFactor: [0, 0, 0, 1], roughnessFactor: 0.5 }));
    const dense = await both(plane({ baseColorFactor: [0, 0, 0, 1], roughnessFactor: 0.5, ior: 2.4 }));
    expect(dense[1]!).toBeGreaterThan(plain[1]! * 3);
    const tinted = await both(plane({ baseColorFactor: [0, 0, 0, 1], roughnessFactor: 0.5, ior: 2.4, specularColor: [1, 0.2, 0.2] }));
    expect(tinted[0]!).toBeGreaterThan(tinted[1]! * 2);
  });

  it("adds a sheen over a dark cloth, alike in both", async () => {
    const velvet = await both(plane({ baseColorFactor: [0.05, 0.05, 0.05, 1], roughnessFactor: 1, sheenColor: [1, 0.2, 0.2], sheenRoughness: 0.5 }), key, 0.06);
    // A red sheen over a grey cloth: redder, though head-on, where the sheen is weakest.
    expect(velvet[0]!).toBeGreaterThan(velvet[1]! * 1.1);
  });

  it("scales emission by its strength", async () => {
    const one = await both(plane({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [1, 0.5, 0.25] }), { ambient: 0, lightDirection: [0, 0, -1] }, 0.02);
    const four = await both(plane({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [1, 0.5, 0.25], emissiveStrength: 4 }), { ambient: 0, lightDirection: [0, 0, -1] }, 0.02);
    near(four, one.map((c) => c * 4), 0.01);
    expect(one[0]).toBeCloseTo(1, 2);
  });

  it("lets the light behind a transmitting surface through, tinted by its volume", async () => {
    const back = { mesh: quad("back", { baseColorFactor: [0, 0, 0, 1], emissiveFactor: [0, 1, 0] }), model: composeModelMatrix([0, 0, -1], [0, 0, 0], [6, 6, 1]) };
    const glass = (material: Partial<MeshMaterial>) => [back, { mesh: quad("glass", { baseColorFactor: [1, 1, 1, 1], roughnessFactor: 0.3, transmission: 1, ...material }), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [2, 2, 1]) }] as unknown as MeshSceneInstance[];
    const dark = { ambient: 0, lightDirection: [0, 0, -1] as [number, number, number] };
    const clear = await both(glass({}), dark);
    // Nearly all of it, less what the glass reflects.
    expect(clear[1]!).toBeGreaterThan(0.9);
    expect(clear[1]!).toBeLessThan(1);
    const thick = await both(glass({ thickness: 1, attenuationDistance: 0.5, attenuationColor: [0.5, 0.5, 0.5] }), dark);
    // Two attenuation distances: a quarter.
    expect(thick[1]! / clear[1]!).toBeCloseTo(0.25, 2);
  });

  it("moves the maps by the UV transform", async () => {
    const strip: DecodedTexture = { width: 4, height: 1, data: Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]) } as DecodedTexture;
    const textured = (material: Partial<MeshMaterial>) => plane({ baseColorFactor: [1, 1, 1, 1], ...material }, { textures: [strip] } as Partial<MeshSceneInstance>);
    const plain = await both(textured({}));
    const movedMaterial = { uvTransform: { offset: [0.25, 0] as const, rotation: 0, scale: [1, 1] as const } };
    const moved = await both(textured(movedMaterial));
    expect(moved).not.toEqual(plain);
  });

  it("colours a thin film, alike in both", async () => {
    const film = await both(plane({ baseColorFactor: [0, 0, 0, 1], roughnessFactor: 0.4, iridescence: 1, iridescenceThickness: 400 }), key, 0.08);
    const bare = await rastered(plane({ baseColorFactor: [0, 0, 0, 1], roughnessFactor: 0.4 }), key);
    expect(Math.max(...film.slice(0, 3)) - Math.min(...film.slice(0, 3))).toBeGreaterThan(Math.max(...bare.slice(0, 3)) - Math.min(...bare.slice(0, 3)));
  });
});

void srgb;
