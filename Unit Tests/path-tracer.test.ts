/**
 * The path-traced reference (AAA_FIDELITY_ROADMAP.md F10b): the scene it
 * packs over the lightmapper's BVH, and, on a real device (Dawn), its light
 * against closed forms and against the linear-light renderer, its
 * accumulation, and captures in tiles.
 */

import { describe, expect, it } from "vitest";

import { buildBvh, composeModelMatrix, projectionMatrix, viewMatrix, type DecodedTexture, type MeshAsset, type MeshSceneInstance, type SceneLight } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";

import { PathTracer, REFERENCE_TEXTURE_SIDE, captureReference, packReferenceScene, referenceAmbient, referenceLights, referenceSceneKey, type ReferenceDraw } from "../packages/player/src/render/pathTracer";

const srgb = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function quad(name: string, material: Record<string, unknown> = {}): MeshAsset {
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

const solid = (width: number, height: number, rgba: readonly number[]): DecodedTexture => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set(rgba, i * 4);
  return { width, height, data } as DecodedTexture;
};

const at = (x: number, y: number, z: number, scale = 2): Float32Array => composeModelMatrix([x, y, z], [0, 0, 0], [scale, scale, 1]) as unknown as Float32Array;

describe("the reference's scene", () => {
  it("packs each triangle's corners in the BVH's order, with its normals, UVs and material", () => {
    const instances = [
      { mesh: quad("a"), model: at(0, 0, 0) },
      { mesh: quad("b", { metallicFactor: 1, emissiveFactor: [1, 0.5, 0] }), model: at(3, 0, 0, 1) },
    ] as unknown as MeshSceneInstance[];
    const scene = packReferenceScene(instances);
    const bvh = buildBvh(instances.map((i) => ({ mesh: i.mesh, model: i.model })));
    expect(scene.triangles).toBe(4);
    expect(scene.materials).toBe(2);
    const bits = new Uint32Array(scene.prims.buffer);
    for (let i = 0; i < 4; i += 1) {
      // The same corner the BVH's triangle starts at, and a normal facing +z.
      for (let a = 0; a < 3; a += 1) expect(scene.prims[i * 28 + a]).toBeCloseTo(bvh.tri[bvh.order[i]! * 9 + a]!, 5);
      expect(scene.prims[i * 28 + 14]).toBeCloseTo(1, 5);
      // Triangles 0, 1 are the first quad's (material 0), 2, 3 the second's.
      expect(bits[i * 28 + 27]).toBe(bvh.order[i]! < 2 ? 0 : 1);
    }
    // The second material: metal, its emission, and PBR.
    expect(Array.from(scene.mats.slice(44, 60))).toEqual([0.8, 0.4, 0.2, 1, 1, 0.5, 0, 0, 1, 0.6, -1, -1, -1, 1, 0.5, 1].map((v) => Math.fround(v)));
    // Then its full material set (F1d) at the defaults: no sheen, a 4% dielectric, no transmission or film, no transform, strength 1.
    expect(Array.from(scene.mats.slice(60, 88))).toEqual([0, 0, 0, 0, 0.04, 0.04, 0.04, 0, 0, 0, 0, 1.3, 1, 1, 1, 400, 1, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0].map((v) => Math.fround(v)));
  });

  it("stores each map once, downsizing the largest", () => {
    const big = solid(REFERENCE_TEXTURE_SIDE * 2, 4, [255, 0, 0, 255]);
    const mesh = quad("t");
    const scene = packReferenceScene([
      { mesh, model: at(0, 0, 0), textures: [big] },
      { mesh, model: at(3, 0, 0), textures: [big] },
    ] as unknown as MeshSceneInstance[]);
    expect(scene.mapTable).toBe(11);
    expect(Array.from(new Uint32Array(scene.mats.buffer).slice(44, 48))).toEqual([0, REFERENCE_TEXTURE_SIDE, 2, 0]);
    expect(scene.texels.length).toBe(REFERENCE_TEXTURE_SIDE * 2);
    // Red, opaque: r in the low byte.
    expect(scene.texels[0]).toBe(0xff0000ff);
    expect(scene.materials).toBe(1);
  });

  it("keys the scene by its meshes, transforms and maps", () => {
    const mesh = quad("k");
    const one = [{ mesh, model: at(0, 0, 0) }] as unknown as MeshSceneInstance[];
    expect(referenceSceneKey(one)).toBe(referenceSceneKey([{ mesh, model: at(0, 0, 0) }] as unknown as MeshSceneInstance[]));
    expect(referenceSceneKey(one)).not.toBe(referenceSceneKey([{ mesh, model: at(0, 0.1, 0) }] as unknown as MeshSceneInstance[]));
    expect(referenceSceneKey(one)).not.toBe(referenceSceneKey([{ mesh: quad("k"), model: at(0, 0, 0) }] as unknown as MeshSceneInstance[]));
  });

  it("lights by the rig, or the key light as a white directional of 1, over the flat ambient as a sky", () => {
    const keyed = referenceLights({ view: [] as never, projection: [] as never, lightDirection: [0, 2, 0] });
    expect(keyed.directional).toBe(1);
    expect(Array.from(keyed.data.slice(0, 8))).toEqual([0, 1, 0, 0, 1, 1, 1, 1]);
    const rig = referenceLights({ view: [] as never, projection: [] as never, lights: [{ kind: "point", position: [0, 1, 0], color: [1, 1, 1], intensity: 2 }] });
    expect(rig).toMatchObject({ directional: 0, local: 1 });
    expect(referenceAmbient({ view: [] as never, projection: [] as never, ambient: 0.5 })).toBeCloseTo(srgb(0.5), 6);
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

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

const W = 16;
const H = 16;

describe.skipIf(!device)("the reference on a real device", { timeout: 300_000 }, () => {
  const camera = { view: viewMatrix([0, 0, 3], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50) };

  async function readTexture(texture: any, w: number, h: number): Promise<number[][]> {
    const bytesPerRow = Math.ceil((w * 8) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * h, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: h }, { width: w, height: h });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const halves = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    const out: number[][] = [];
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) out.push([0, 1, 2, 3].map((c) => half(halves[(y * bytesPerRow) / 2 + x * 4 + c]!)));
    return out;
  }

  /** The mean RGBA over the frame's middle 4×4 after `samples` samples. */
  async function traced(instances: MeshSceneInstance[], draw: Partial<ReferenceDraw>, samples = 256, settings: Record<string, unknown> = {}): Promise<number[]> {
    const tracer = PathTracer.create(device);
    device.pushErrorScope("validation");
    let texture: any = null;
    const full = { ...camera, ...draw };
    for (let i = 0; i < samples / 32; i += 1) texture = tracer.render(instances, full, W, H, { samplesPerFrame: 32, ...settings });
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    expect(tracer.samples).toBe(samples);
    const pixels = await readTexture(texture, W, H);
    tracer.destroy();
    return middle(pixels);
  }

  /** The mean RGBA over a frame's middle 4×4. */
  function middle(pixels: number[][]): number[] {
    const sum = [0, 0, 0, 0];
    for (let y = H / 2 - 2; y < H / 2 + 2; y += 1) for (let x = W / 2 - 2; x < W / 2 + 2; x += 1) pixels[y * W + x]!.forEach((v, c) => (sum[c] += v / 16));
    return sum;
  }

  let renderer: WebgpuSceneRenderer;
  /** The linear-light renderer's mean over the same middle 4×4. */
  async function rastered(instances: MeshSceneInstance[], draw: Record<string, unknown>): Promise<number[]> {
    renderer ??= (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
    const texture = renderer.renderToTexture!(instances, { width: W, height: H, ...camera, environment: null, lights: [], ...draw } as any);
    return middle(await readTexture(texture, W, H));
  }

  const plane = (material: Record<string, unknown> = {}) => [{ mesh: quad("p", material), model: at(0, 0, 0) }] as unknown as MeshSceneInstance[];
  const near = (got: number[], want: number[], tolerance: number) => want.forEach((w, c) => expect(Math.abs(got[c]! - w)).toBeLessThanOrEqual(tolerance * Math.max(w, 0.02)));

  it("keeps a white furnace white: a rough white metal under a uniform sky", async () => {
    // The key light behind the plane, so only the sky lights it.
    const got = await traced(plane({ baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1 }), { ambient: 1, lightDirection: [0, 0, -1] }, 512);
    near(got.slice(0, 3), [1, 1, 1], 0.04);
    expect(got[3]).toBe(1);
  });

  it("matches the renderer's direct light from the key light", async () => {
    const instances = plane();
    const draw = { ambient: 0, lightDirection: [0, 0.6, 0.8] as [number, number, number] };
    const raster = await rastered(instances, draw);
    const got = await traced(instances, draw, 128);
    near(got.slice(0, 3), raster.slice(0, 3), 0.03);
  });

  it("matches the renderer's point light and its inverse square", async () => {
    const instances = plane({ roughnessFactor: 0.8 });
    const lights: SceneLight[] = [{ kind: "point", position: [0, 0, 1.5], color: [1, 0.9, 0.8], intensity: 3, falloff: "inverseSquare" } as SceneLight];
    const raster = await rastered(instances, { ambient: 0, lights });
    const got = await traced(instances, { ambient: 0, lights }, 128);
    near(got.slice(0, 3), raster.slice(0, 3), 0.03);
  });

  it("shadows what an occluder hides from the light, and sees emission as it is", async () => {
    const lit = await traced(plane(), { ambient: 0, lightDirection: [0, 0, 1] }, 64);
    const blocker = { mesh: quad("b"), model: composeModelMatrix([0, 0, 5], [0, 0, 0], [4, 4, 1]) } as unknown as MeshSceneInstance;
    // The eye at z = 3 looks past the blocker's back (it is behind the camera).
    const shadowed = await traced([...plane(), blocker], { ambient: 0, lightDirection: [0, 0, 1] }, 64);
    expect(lit[0]!).toBeGreaterThan(0.1);
    expect(shadowed[0]!).toBeLessThan(lit[0]! * 0.02);
    const glow = await traced(plane({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [1, 0.5, 0.25] }), { ambient: 0, lightDirection: [0, 0, -1] }, 32);
    near(glow.slice(0, 3), [1, srgb(0.5), srgb(0.25)], 0.01);
  });

  it("reads the base colour from its map, at the renderer's colour", async () => {
    const instances = [{ mesh: quad("m", { baseColorFactor: [1, 1, 1, 1] }), model: at(0, 0, 0), textures: [solid(4, 4, [51, 204, 102, 255])] }] as unknown as MeshSceneInstance[];
    const draw = { ambient: 0, lightDirection: [0, 0.6, 0.8] as [number, number, number] };
    const got = await traced(instances, draw, 64);
    const raster = await rastered(instances, draw);
    near(got.slice(0, 3), raster.slice(0, 3), 0.03);
  });

  it("lets a cut-out's clear texels through", async () => {
    const back = { mesh: quad("back", { baseColorFactor: [0, 0, 0, 1], emissiveFactor: [0, 1, 0] }), model: at(0, 0, -1, 4) };
    const cut = { mesh: quad("cut", { baseColorFactor: [0, 0, 0, 1], emissiveFactor: [1, 0, 0], alphaMode: "mask" }), model: at(0, 0, 0), textures: [solid(2, 2, [255, 255, 255, 0])] };
    const got = await traced([back, cut] as unknown as MeshSceneInstance[], { ambient: 0, lightDirection: [0, 0, -1] }, 32);
    near(got.slice(0, 3), [0, 1, 0], 0.01);
  });

  it("accumulates while the view holds and starts again when it moves", async () => {
    const tracer = PathTracer.create(device);
    const instances = plane();
    tracer.render(instances, { ...camera, ambient: 0.5 }, W, H, { samplesPerFrame: 2 });
    tracer.render(instances, { ...camera, ambient: 0.5 }, W, H, { samplesPerFrame: 2 });
    expect(tracer.samples).toBe(4);
    tracer.render(instances, { ...camera, view: viewMatrix([0, 0.1, 3], [0, 0, 0]), ambient: 0.5 }, W, H, { samplesPerFrame: 2 });
    expect(tracer.samples).toBe(2);
    tracer.render(instances, { ...camera, view: viewMatrix([0, 0.1, 3], [0, 0, 0]), ambient: 0.5 }, W, H, { samplesPerFrame: 4, maxSamples: 4 });
    expect(tracer.samples).toBe(4);
    tracer.destroy();
  });

  it("captures the same image in tiles as in one piece", async () => {
    const instances = plane({ roughnessFactor: 0.3 });
    const draw = { ...camera, view: viewMatrix([0, 0, 8], [0, 0, 0]), ambient: 0.3, lightDirection: [0.3, 0.6, 0.8] as [number, number, number] };
    const whole = await settled(captureReference(device, instances, draw, { width: 24, height: 20, samples: 8, tile: 24, hdr: true }));
    let reported = 0;
    const tiled = await settled(captureReference(device, instances, draw, { width: 24, height: 20, samples: 8, tile: 8, hdr: true, progress: (p) => (reported = p) }));
    expect(reported).toBeCloseTo(1, 6);
    expect(tiled.hdr!.length).toBe(24 * 20 * 4);
    let worst = 0;
    for (let i = 0; i < whole.hdr!.length; i += 1) worst = Math.max(worst, Math.abs(whole.hdr![i]! - tiled.hdr![i]!));
    expect(worst).toBeLessThan(1e-4);
    expect(Array.from(tiled.rgba)).toEqual(Array.from(whole.rgba));
    // The sky behind the plane's corners shows (the flat ambient), and the plane is lit.
    expect(whole.rgba[3]).toBe(255);
    expect(whole.hdr![0]!).toBeCloseTo(srgb(0.3), 4);
  });
});
