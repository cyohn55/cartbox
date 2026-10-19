/**
 * The AAA tier's BRDF (AAA_FIDELITY_ROADMAP.md F1c): the split-sum DFG table
 * against a brute-force integral of the same BRDF, multiple scattering that
 * keeps a white furnace white, Fresnel on the environment's reflection, and
 * specular occlusion. On a real device (Dawn), the linear-light shader reads
 * the table and lands on the CPU's numbers.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, projectionMatrix, viewMatrix, type EnvironmentLight, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";
import { sceneShader } from "../packages/player/src/render/WebgpuSceneRenderer";
import { DFG_SIZE, dfgAt, dfgTable, energyCompensation, integrateDfg, smithVisibility, specularEnergy, specularOcclusion } from "../packages/player/src/render/brdf";

/** The BRDF's hemispherical integral for f0 = 1 (A + B), by brute force over L. */
function bruteForce(ndv: number, roughness: number, n = 400): number {
  const alpha = roughness * roughness;
  const a2 = alpha * alpha;
  const v = [Math.sqrt(1 - ndv * ndv), 0, ndv];
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const ct = (i + 0.5) / n;
      const phi = (2 * Math.PI * (j + 0.5)) / n;
      const st = Math.sqrt(1 - ct * ct);
      const h = [st * Math.cos(phi) + v[0]!, st * Math.sin(phi), ct + v[2]!];
      const ndh = h[2]! / Math.hypot(h[0]!, h[1]!, h[2]!);
      const d = ndh * ndh * (a2 - 1) + 1;
      sum += (a2 / (Math.PI * d * d)) * smithVisibility(ct, ndv, a2) * ct * ((2 * Math.PI) / n) * (1 / n);
    }
  }
  return sum;
}

describe("the split-sum DFG table", () => {
  it("integrates the shader's BRDF: A + B matches a brute-force integral", () => {
    for (const [ndv, rough] of [[0.1, 0.5], [0.5, 0.5], [1, 0.5], [0.2, 1], [0.7, 1], [0.9, 0.25]] as const) {
      const [a, b] = integrateDfg(ndv, rough);
      expect(Math.abs(a + b - bruteForce(ndv, rough))).toBeLessThan(0.01);
    }
  });

  it("loses no energy when smooth and up to two thirds at full roughness", () => {
    const lut = dfgTable();
    expect(lut.length).toBe(DFG_SIZE * DFG_SIZE * 2);
    const [a, b] = dfgAt(lut, 0.9, 0.05);
    expect(a + b).toBeGreaterThan(0.98);
    const rough = dfgAt(lut, 0.95, 1);
    expect(rough[0] + rough[1]).toBeLessThan(0.4);
    for (let i = 0; i < lut.length; i += 2) {
      expect(lut[i]! + lut[i + 1]!).toBeLessThanOrEqual(1.001);
      expect(lut[i + 1]!).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("multiple scattering, Fresnel and occlusion", () => {
  const lut = dfgTable();

  it("keeps a white furnace white: a rough white metal reflects everything", () => {
    for (const rough of [0.2, 0.5, 0.8, 1]) {
      for (const ndv of [0.1, 0.5, 1]) {
        const dfg = dfgAt(lut, ndv, rough);
        // Single scattering alone loses what bounces between microfacets…
        if (rough >= 0.8 && ndv >= 0.5) expect(dfg[0] + dfg[1]).toBeLessThan(0.7);
        // …which the multiple-scattering lobe gives back.
        expect(specularEnergy(1, dfg)).toBeCloseTo(1, 6);
        // A light's specular is scaled by the same loss.
        expect(energyCompensation(1, dfg) * (dfg[0] + dfg[1])).toBeCloseTo(1, 4);
      }
    }
  });

  it("puts Fresnel on the environment: a dielectric reflects more toward grazing", () => {
    const head = specularEnergy(0.04, dfgAt(lut, 1, 0.2));
    const grazing = specularEnergy(0.04, dfgAt(lut, 0.1, 0.2));
    expect(head).toBeGreaterThan(0.035);
    expect(head).toBeLessThan(0.05);
    expect(grazing).toBeGreaterThan(5 * head);
    // A rough one's highlight flattens: less to gain at grazing.
    expect(specularEnergy(0.04, dfgAt(lut, 0.1, 1)) / specularEnergy(0.04, dfgAt(lut, 1, 1))).toBeLessThan(grazing / head);
  });

  it("occludes the specular by the AO, less where a smooth lobe faces out of the crevice", () => {
    expect(specularOcclusion(0.7, 1, 0.3)).toBeCloseTo(1, 6);
    expect(specularOcclusion(0.7, 0, 0.3)).toBe(0);
    // A rough lobe is occluded as the AO says; a smooth one facing the viewer, less.
    expect(Math.abs(specularOcclusion(1, 0.5, 1) - 0.5)).toBeLessThan(0.01);
    expect(specularOcclusion(1, 0.5, 0.01)).toBeGreaterThan(0.65);
    // At grazing the smooth lobe skims the crevice's walls: more occluded than head-on.
    expect(specularOcclusion(0.05, 0.5, 0.01)).toBeLessThan(specularOcclusion(1, 0.5, 0.01));
  });

  it("is only in the linear-light shader: the Modern tier keeps its parity with the software rasteriser", () => {
    const linear = sceneShader(null, false, true);
    const byte = sceneShader(null, false, false);
    for (const name of ["dfgLut", "smithVisibility(", "specularEnergy(", "specularOcclusion(", "eComp"]) {
      expect(linear).toContain(name);
      expect(byte).not.toContain(name);
    }
    // The reflection's weight: the energy the surface reflects, scaled by its reflectivity but never past 1 (F11a).
    expect(sceneShader(null, true, true)).toContain("specK * specAo");
    expect(linear).toContain("min(specE * reflectK, vec3<f32>(1.0))");
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

/** A half float's value. */
function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

const W = 48;
const H = 48;

/** The linear red at the frame's centre, as the HDR renderer leaves it. */
async function centre(texture: any): Promise<number> {
  const bytesPerRow = Math.ceil((W * 8) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 }); // MAP_READ | COPY_DST
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const halves = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  return half(halves[((H >> 1) * bytesPerRow) / 2 + (W >> 1) * 4]!);
}

function quad(base: [number, number, number, number], metallic: number, roughness: number): MeshAsset {
  return {
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: base, baseColorImage: null, metallicFactor: metallic, roughnessFactor: roughness },
      },
    ],
  } as unknown as MeshAsset;
}

/** A uniform white environment: every direction the same radiance, 1. */
const FURNACE: EnvironmentLight = { sky: [1, 1, 1], horizon: [1, 1, 1], ground: [1, 1, 1], intensity: 1 };

describe.skipIf(!device)("on a real device, in linear light", { timeout: 60_000 }, () => {
  /** The centre's linear value: a quad turned `yaw` degrees from the camera at +z. */
  async function shade(mesh: MeshAsset, yaw: number, options: { environment?: EnvironmentLight; lightDirection?: [number, number, number]; ambient?: number }): Promise<number> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
    expect(renderer).not.toBeNull();
    const instances: MeshSceneInstance[] = [{ mesh, model: composeModelMatrix([0, 0, 0], [0, yaw, 0], [2, 2, 1]) }];
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, {
      width: W,
      height: H,
      view: viewMatrix([0, 0, 3], [0, 0, 0]),
      projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
      ambient: options.ambient ?? 0,
      lightDirection: options.lightDirection ?? [0, 0, -1],
      environment: options.environment ?? null,
    } as any);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const value = await centre(texture);
    renderer.dispose();
    return value;
  }

  it("keeps a white furnace white, metal or dielectric, smooth or rough", async () => {
    // Before F1c a white dielectric gained its reflection on top of its diffuse (1.04).
    for (const [metallic, rough] of [[1, 0.3], [1, 1], [0, 0.3], [0, 1]] as const) {
      const v = await shade(quad([1, 1, 1, 1], metallic, rough), 0, { environment: FURNACE });
      expect(Math.abs(v - 1)).toBeLessThan(0.01);
    }
  });

  it("reflects the environment with Fresnel: a black dielectric, head-on and at 75°", async () => {
    const lut = dfgTable();
    for (const yaw of [0, 75]) {
      const ndv = Math.cos((yaw * Math.PI) / 180);
      const v = await shade(quad([0, 0, 0, 1], 0, 0.3), yaw, { environment: FURNACE });
      const expected = specularEnergy(0.04, dfgAt(lut, ndv, 0.3));
      expect(Math.abs(v - expected) / expected).toBeLessThan(0.03);
    }
  });

  it("adds a rough metal's lost energy back to its highlight, normalised against the diffuse", async () => {
    // Lit head-on, N = V = L: D = 1 / (π α²) and V = 1 / (4α), times π and the compensation.
    const lut = dfgTable();
    for (const rough of [0.5, 1]) {
      const alpha = rough * rough;
      const single = (1 / (Math.PI * alpha * alpha)) * smithVisibility(1, 1, alpha * alpha) * Math.PI;
      const expected = single * energyCompensation(1, dfgAt(lut, 1, rough));
      const v = await shade(quad([1, 1, 1, 1], 1, rough), 0, { lightDirection: [0, 0, 1] });
      expect(Math.abs(v - expected) / expected).toBeLessThan(0.02);
      expect(v).toBeGreaterThan(single * 1.05);
      // A tighter lobe's peak is over 1, and kept: linear light reaches the tone map unclamped.
      if (rough === 0.5) expect(v).toBeGreaterThan(4);
    }
  });
});
