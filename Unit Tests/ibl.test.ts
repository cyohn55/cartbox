/**
 * Image-based lighting on the GPU (AAA_FIDELITY_ROADMAP.md F3a): the
 * environment in linear light, its L2 SH irradiance against a brute-force
 * cosine integral, and on a real device (Dawn) the prefiltered cube: its faces
 * where WebGPU samples them, its rough levels against a CPU GGX integral, and
 * the AAA tier lit by it.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, type EnvironmentLight, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";
import { IBL_FACE, IBL_LEVELS, IblBuilder, cubeDirection, environmentPanorama, environmentSh, shIrradiance, type LinearPanorama } from "../packages/player/src/render/ibl";

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** A blue sky over brown ground. */
const SKY: EnvironmentLight = { sky: [0.25, 0.45, 0.9], horizon: [0.8, 0.85, 0.9], ground: [0.35, 0.25, 0.15], intensity: 1.5 };

/** The panorama along a direction, nearest (as the shader's envColorDir maps it). */
function along(pano: LinearPanorama, d: readonly [number, number, number]): [number, number, number] {
  const u = Math.atan2(d[2], d[0]) / (2 * Math.PI) + 0.5;
  const v = Math.acos(Math.max(-1, Math.min(1, d[1]))) / Math.PI;
  const x = Math.min(pano.width - 1, Math.floor(u * pano.width));
  const y = Math.min(pano.height - 1, Math.floor(v * pano.height));
  const i = (y * pano.width + x) * 4;
  return [pano.data[i]!, pano.data[i + 1]!, pano.data[i + 2]!];
}

/** A white Lambertian's reflected radiance at normal n, by brute force over the panorama. */
function bruteIrradiance(pano: LinearPanorama, n: readonly [number, number, number]): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < pano.height; y += 1) {
    const theta = (Math.PI * (y + 0.5)) / pano.height;
    const dw = Math.sin(theta) * (Math.PI / pano.height) * ((2 * Math.PI) / pano.width);
    for (let x = 0; x < pano.width; x += 1) {
      const phi = (2 * Math.PI * (x + 0.5)) / pano.width - Math.PI;
      const d = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
      const c = d[0]! * n[0] + d[1]! * n[1] + d[2]! * n[2];
      if (c <= 0) continue;
      for (let k = 0; k < 3; k += 1) out[k] += (pano.data[(y * pano.width + x) * 4 + k]! * c * dw) / Math.PI;
    }
  }
  return out;
}

describe("the environment in linear light", () => {
  it("decodes the gradient and scales it by the intensity, sky up and ground down", () => {
    const pano = environmentPanorama(SKY);
    const up = along(pano, [0, 1, 0]);
    const down = along(pano, [0, -1, 0]);
    expect(up[2]).toBeCloseTo(lin(0.9) * 1.5, 1);
    expect(down[0]).toBeCloseTo(lin(0.35) * 1.5, 1);
    expect(along(pano, [1, 0, 0])[1]).toBeCloseTo(lin(0.85) * 1.5, 1);
  });

  it("gives the SH irradiance of a brute-force cosine integral, within L2's 5%", () => {
    const pano = environmentPanorama(SKY);
    const sh = environmentSh(pano);
    for (const n of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0.6, 0.8], [-0.6, -0.8, 0]] as [number, number, number][]) {
      const want = bruteIrradiance(pano, n);
      const got = shIrradiance(sh, n);
      // Against the brightest channel: L2 rings a little in a weak one (the sky's red).
      for (let k = 0; k < 3; k += 1) expect(Math.abs(got[k]! - want[k]!) / Math.max(...want)).toBeLessThan(0.05);
    }
    // A constant environment lights white at its radiance.
    const flat = environmentSh(environmentPanorama({ sky: [1, 1, 1], horizon: [1, 1, 1], ground: [1, 1, 1], intensity: 2 }));
    for (const v of shIrradiance(flat, [0.3, 0.9, -0.3])) expect(v).toBeCloseTo(2, 3);
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

/** One cube face at one level, as RGB floats. */
async function readFace(cube: any, level: number, face: number): Promise<{ size: number; rgb: (x: number, y: number) => [number, number, number] }> {
  const size = Math.max(1, IBL_FACE >> level);
  const bytesPerRow = Math.ceil((size * 8) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * size, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture: cube, mipLevel: level, origin: { x: 0, y: 0, z: face } }, { buffer, bytesPerRow, rowsPerImage: size }, { width: size, height: size, depthOrArrayLayers: 1 });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const halves = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return { size, rgb: (x, y) => [0, 1, 2].map((k) => half(halves[(y * bytesPerRow) / 2 + x * 4 + k]!)) as [number, number, number] };
}

/** The GGX lobe of roughness `rough` about `n` (V = N) over the panorama, by many samples on the CPU. */
function ggxReference(pano: LinearPanorama, n: readonly [number, number, number], rough: number, samples = 20000): [number, number, number] {
  const alpha = rough * rough;
  const a2 = alpha * alpha;
  const up = Math.abs(n[2]) < 0.999 ? [0, 0, 1] : [1, 0, 0];
  const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const norm = (v: number[]) => v.map((x) => x / Math.hypot(...v));
  const tx = norm(cross(up, n));
  const ty = cross(n, tx);
  const out = [0, 0, 0];
  let weight = 0;
  for (let i = 0; i < samples; i += 1) {
    const u1 = (i + 0.5) / samples;
    const u2 = (i * 0.618033988749895) % 1;
    const phi = 2 * Math.PI * u2;
    const cosT = Math.sqrt((1 - u1) / (1 + (a2 - 1) * u1));
    const sinT = Math.sqrt(1 - cosT * cosT);
    const h = [0, 1, 2].map((k) => tx[k]! * sinT * Math.cos(phi) + ty[k]! * sinT * Math.sin(phi) + n[k]! * cosT);
    const nh = h[0]! * n[0] + h[1]! * n[1] + h[2]! * n[2];
    const l = [0, 1, 2].map((k) => 2 * nh * h[k]! - n[k]!);
    const ndl = l[0]! * n[0] + l[1]! * n[1] + l[2]! * n[2];
    if (ndl <= 0) continue;
    const c = along(pano, l as [number, number, number]);
    for (let k = 0; k < 3; k += 1) out[k] += c[k]! * ndl;
    weight += ndl;
  }
  return out.map((v) => v / weight) as [number, number, number];
}

describe.skipIf(!device)("the prefiltered cube, on a real device", { timeout: 120_000 }, () => {
  it("puts each face where WebGPU samples it: its sharp level is the panorama", async () => {
    const pano = environmentPanorama(SKY);
    const cube = new IblBuilder(device).build(pano);
    for (const face of [0, 1, 2, 3, 4, 5]) {
      const level = await readFace(cube, 0, face);
      for (const [x, y] of [[16, 16], [64, 64], [100, 40]] as const) {
        const d = cubeDirection(face, ((x + 0.5) / level.size) * 2 - 1, ((y + 0.5) / level.size) * 2 - 1);
        const want = along(pano, d);
        const got = level.rgb(x, y);
        for (let k = 0; k < 3; k += 1) expect(Math.abs(got[k]! - want[k]!)).toBeLessThan(0.03 * Math.max(1, want[k]!));
      }
    }
    cube.destroy();
  });

  it("filters each rough level as the GGX lobe does, within 4%", async () => {
    const pano = environmentPanorama(SKY);
    const cube = new IblBuilder(device).build(pano);
    for (const level of [2, 3, 5]) {
      const rough = level / (IBL_LEVELS - 1);
      for (const face of [0, 2]) {
        const read = await readFace(cube, level, face);
        const x = Math.floor(read.size * 0.3);
        const y = Math.floor(read.size * 0.6);
        const d = cubeDirection(face, ((x + 0.5) / read.size) * 2 - 1, ((y + 0.5) / read.size) * 2 - 1);
        const want = ggxReference(pano, d, rough);
        const got = read.rgb(x, y);
        for (let k = 0; k < 3; k += 1) expect(Math.abs(got[k]! - want[k]!) / Math.max(...want)).toBeLessThan(0.04);
      }
    }
    cube.destroy();
  });

  it("lights the AAA tier: a rough white floor gets the sky's irradiance, a mirror its sharp reflection", async () => {
    const W = 32;
    const H = 32;
    const quad = (metallic: number, roughness: number): MeshAsset =>
      ({
        name: "q",
        primitives: [
          {
            positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
            normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
            uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
            indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
            material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: metallic, roughnessFactor: roughness },
          },
        ],
      }) as unknown as MeshAsset;
    // A floor facing up (+y), seen from straight above.
    const shade = async (mesh: MeshAsset) => {
      const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
      const instances: MeshSceneInstance[] = [{ mesh, model: composeModelMatrix([0, 0, 0], [-90, 0, 0], [2, 2, 1]) }];
      device.pushErrorScope("validation");
      const texture = renderer.renderToTexture!(instances, { width: W, height: H, view: viewMatrix([0, 3, 0.001], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50), ambient: 0, lightDirection: [0, -1, 0], environment: SKY } as any);
      const error = await settled(device.popErrorScope());
      expect(error ? String((error as any).message ?? error) : null).toBeNull();
      const bytesPerRow = 256;
      const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
      device.queue.submit([encoder.finish()]);
      await settled(buffer.mapAsync(0x01));
      const halves = new Uint16Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      renderer.dispose();
      const i = ((H >> 1) * bytesPerRow) / 2 + (W >> 1) * 4;
      return [half(halves[i]!), half(halves[i + 1]!), half(halves[i + 2]!)];
    };
    const pano = environmentPanorama(SKY);
    // A white rough dielectric: the hemisphere's irradiance, less what the reflection takes (a few %).
    const floor = await shade(quad(0, 1));
    const irr = shIrradiance(environmentSh(pano), [0, 1, 0]);
    for (let k = 0; k < 3; k += 1) {
      expect(floor[k]!).toBeLessThan(irr[k]! * 1.03);
      expect(floor[k]!).toBeGreaterThan(irr[k]! * 0.9);
    }
    // A smooth white metal mirrors the zenith.
    const mirror = await shade(quad(1, 0.05));
    const zenith = along(pano, [0, 1, 0]);
    for (let k = 0; k < 3; k += 1) expect(Math.abs(mirror[k]! - zenith[k]!) / zenith[k]!).toBeLessThan(0.05);
  });
});
