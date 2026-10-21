/**
 * Area lights (AAA_FIDELITY_ROADMAP.md F2e-2): rectangles, disks and tubes,
 * shaded with linearly transformed cosines on the linear-light GPU shader and
 * as the punctual light each is from far off everywhere else.
 *
 * The CPU mirror of the shader's LTC (ltc.ts) is held to the exact integrals:
 * a rectangle's and a disk's form factors in closed form, and the GGX lobe
 * by brute force over the light. On a real device (Dawn), the shader lands
 * on the mirror's numbers.
 */

import { describe, expect, it } from "vitest";

import {
  areaAsPunctual,
  areaOf,
  composeModelMatrix,
  defaultSceneLighting,
  distanceFalloff,
  lightUnit,
  parseSceneLighting,
  projectionMatrix,
  viewMatrix,
  type MeshAsset,
  type MeshSceneInstance,
  type SceneLight,
} from "@cartbox/editor";
import { LIGHT_FLOATS, WebgpuSceneRenderer, packLights } from "@cartbox/player";

import { dfgAt, dfgTable, energyCompensation, smithVisibility } from "../packages/player/src/render/brdf";
import { AREA_KIND, areaFactors, areaPolygon } from "../packages/player/src/render/ltc";

const RECT: SceneLight = { kind: "area", shape: "rect", size: [2, 1], position: [0, 1.5, 0], direction: [0, -1, 0], tangent: [1, 0, 0], color: [1, 1, 1], intensity: 1 };

/** The form factor from a point to a parallel rectangle whose corner is right above it, `x` by `y` at height `h`. */
function cornerFactor(x: number, y: number, h: number): number {
  const X = x / h;
  const Y = y / h;
  return (X / Math.sqrt(1 + X * X)) * Math.atan(Y / Math.sqrt(1 + X * X)) / (2 * Math.PI) + (Y / Math.sqrt(1 + Y * Y)) * Math.atan(X / Math.sqrt(1 + Y * Y)) / (2 * Math.PI);
}

/** GGX (F = 1, the shader's height-correlated Smith) times the cosine, integrated over RECT from the origin, by brute force. */
function bruteSpecular(roughness: number, view: readonly number[], n = 300): number {
  const a2 = roughness ** 4;
  const [w, h] = RECT.size!;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const p = [-w / 2 + (w * (i + 0.5)) / n, 1.5, -h / 2 + (h * (j + 0.5)) / n];
      const d = Math.hypot(p[0]!, p[1]!, p[2]!);
      const l = p.map((c) => c / d);
      const hv = [l[0]! + view[0]!, l[1]! + view[1]!, l[2]! + view[2]!];
      const ndh = hv[1]! / Math.hypot(hv[0]!, hv[1]!, hv[2]!);
      const dd = ndh * ndh * (a2 - 1) + 1;
      const D = a2 / (Math.PI * dd * dd);
      // N = +y; the light's cosine at its own face is l.y too (it faces straight down).
      sum += D * smithVisibility(l[1]!, view[1]!, a2) * l[1]! * (l[1]! / (d * d)) * ((w / n) * (h / n));
    }
  }
  return sum;
}

describe("linearly transformed cosines (the CPU mirror)", () => {
  it("integrates a rectangle's and a disk's diffuse exactly", () => {
    // Under the rectangle's centre: four corner rectangles.
    expect(areaFactors(RECT, [0, 0, 0], [0, 1, 0], [0.3, 0.9, 0.2], 0.5).diffuse).toBeCloseTo(4 * cornerFactor(1, 0.5, 1.5), 4);
    // Off to one side, the difference of two corner rectangles.
    const off = areaFactors(RECT, [1.5, 0, 0], [0, 1, 0], [0, 1, 0], 0.5).diffuse;
    expect(off).toBeCloseTo(2 * (cornerFactor(2.5, 0.5, 1.5) - cornerFactor(0.5, 0.5, 1.5)), 4);
    // A coaxial disk: R² / (R² + h²); its octagon holds the disk's area.
    const disk: SceneLight = { ...RECT, shape: "disk", size: [1, 1] };
    expect(areaFactors(disk, [0, 0, 0], [0, 1, 0], [0, 1, 0], 0.5).diffuse).toBeCloseTo(0.25 / (0.25 + 2.25), 3);
  });

  it("integrates the GGX lobe over a rectangle within a few percent of brute force", () => {
    for (const [rough, view] of [[0.3, [0.3, 1, 0.2]], [0.6, [0, 1, 0]], [0.9, [0.8, 0.6, 0]], [0.5, [-0.9, 0.4, 0.1]]] as const) {
      const v = view.map((c) => c / Math.hypot(...view));
      const f = areaFactors(RECT, [0, 0, 0], [0, 1, 0], v, rough);
      const brute = bruteSpecular(rough, v);
      expect(Math.abs(f.spec * f.norm - brute) / brute).toBeLessThan(0.05);
    }
  });

  it("lights only the side a rectangle or disk faces, and every side of a tube", () => {
    expect(areaPolygon(RECT, [0, 3, 0])).toBeNull();
    expect(areaFactors(RECT, [0, 3, 0], [0, -1, 0], [0, -1, 0], 0.5).diffuse).toBe(0);
    const tube: SceneLight = { ...RECT, shape: "tube", size: [2, 0.1] };
    const below = areaFactors(tube, [0, 0, 0], [0, 1, 0], [0, 1, 0], 0.5).diffuse;
    expect(below).toBeGreaterThan(0);
    expect(areaFactors(tube, [0, 3, 0], [0, -1, 0], [0, -1, 0], 0.5).diffuse).toBeCloseTo(below, 6);
  });
});

describe("far off, the punctual light it is", () => {
  it("is a cosine-shaded spot of L·A/π for a rectangle or disk, and a point of L × its side-on area / π for a tube", () => {
    const spot = areaAsPunctual({ ...RECT, intensity: 3 });
    expect(spot).toMatchObject({ kind: "spot", falloff: "inverseSquare", innerAngle: 0, outerAngle: 89, position: [0, 1.5, 0], direction: [0, -1, 0] });
    expect(spot.intensity).toBeCloseTo((3 * 2) / Math.PI, 10);
    const tube = areaAsPunctual({ ...RECT, shape: "tube", size: [2, 0.2] });
    expect(tube.kind).toBe("point");
    expect(tube.intensity).toBeCloseTo((2 * 0.2 + Math.PI * 0.01) / Math.PI, 10);
    expect(areaOf({ shape: "disk", size: [1, 1] })).toBeCloseTo(Math.PI / 4, 10);
    // Its LTC diffuse straight below, far off, is the punctual one's: A cos cos / (π d²).
    const far: SceneLight = { ...RECT, position: [0, 40, 0] };
    const diffuse = areaFactors(far, [0, 0, 0], [0, 1, 0], [0, 1, 0], 0.5).diffuse;
    expect(diffuse / ((spot.intensity / 3) * distanceFalloff({ falloff: "inverseSquare" }, 40))).toBeCloseTo(1, 2);
  });

  it("reads in nits, and passes punctual lights through untouched", () => {
    expect(lightUnit(RECT)).toBe("nt");
    const point: SceneLight = { kind: "point", position: [0, 0, 0], color: [1, 1, 1], intensity: 1 };
    expect(areaAsPunctual(point)).toBe(point);
  });
});

describe("the packed record", () => {
  it("packs an area light's shape, half size and frame for the linear-light shader, and its punctual light for the rest", () => {
    expect(LIGHT_FLOATS).toBe(20);
    const disk: SceneLight = { ...RECT, shape: "disk", size: [0.6, 0.6], tangent: [0, 1, 1], channels: 2 };
    const packed = packLights([disk], true);
    expect(packed[3]).toBe(AREA_KIND.disk);
    expect(Array.from(packed.subarray(9, 12))).toEqual([Math.fround(0.3), Math.fround(0.3), -1]);
    expect(Array.from(packed.subarray(12, 16))).toEqual([0, -1, 0, 5]);
    // The tangent, made perpendicular to the face's normal.
    expect(Array.from(packed.subarray(16, 19)).map((v) => Math.round(v * 1e5) / 1e5)).toEqual([0, 0, 1]);
    const punctual = packLights([disk]);
    expect(punctual[3]).toBe(2);
    expect(punctual[7]).toBeCloseTo((Math.PI * 0.09) / Math.PI, 6);
  });

  it("keeps an area light through a save, holding its size to at least a centimetre", () => {
    const rig = { ...defaultSceneLighting(), lights: [{ ...RECT, shape: "tube", size: [3, 0], castShadows: true }, { ...RECT, shape: "blob" }] };
    const back = parseSceneLighting(JSON.parse(JSON.stringify(rig)))!;
    expect(back.lights[0]).toMatchObject({ kind: "area", shape: "tube", size: [3, 0.01], tangent: [1, 0, 0], direction: [0, -1, 0] });
    expect(back.lights[0]!.castShadows).toBeUndefined();
    expect(back.lights[1]!.shape).toBe("rect");
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

const W = 48;
const H = 48;

function quad(metallic: number, roughness: number): MeshAsset {
  return {
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
  } as unknown as MeshAsset;
}

describe.skipIf(!device)("on a real device, in linear light", { timeout: 60_000 }, () => {
  /** The linear red at the frame's centre (the quad's middle, seen head-on), under `light`. */
  async function centre(mesh: MeshAsset, light: SceneLight): Promise<number> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
    const instances: MeshSceneInstance[] = [{ mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [2, 2, 1]) }];
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, {
      width: W,
      height: H,
      view: viewMatrix([0, 0, 3], [0, 0, 0]),
      projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
      ambient: 0,
      lightDirection: [0, 0, -1],
      environment: null,
      lights: [light],
    } as any);
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
    return half(halves[((H >> 1) * bytesPerRow) / 2 + (W >> 1) * 4]!);
  }

  /** What the shader should give at the centre pixel, from the CPU mirror: where that pixel's ray meets the quad (N = +z), seen from the eye. */
  function expected(light: SceneLight, metallic: number, rough: number): number {
    const reach = 3 * Math.tan(Math.PI / 6);
    const P: [number, number, number] = [(((W >> 1) + 0.5) / W * 2 - 1) * reach, (1 - (((H >> 1) + 0.5) / H) * 2) * reach, 0];
    const toEye = [-P[0], -P[1], 3];
    const V = toEye.map((c) => c / Math.hypot(...toEye));
    const f = areaFactors(light, P, [0, 0, 1], V, rough);
    const ndv = V[2]!;
    const f0 = 0.04 + (1 - 0.04) * metallic;
    const kdm = 1 - metallic;
    const eComp = energyCompensation(f0, dfgAt(dfgTable(), ndv, rough));
    const fv = f0 + (1 - f0) * (1 - ndv) ** 5;
    return (kdm * (1 - fv) * f.diffuse + (f0 * f.norm + (1 - f0) * f.fresnel) * f.spec * eComp) * light.intensity;
  }

  it("shades a rectangle, a disk and a tube as the CPU mirror does", async () => {
    const facing: SceneLight = { kind: "area", shape: "rect", size: [1.6, 0.8], position: [0.2, 0.1, 1.2], direction: [0, 0, -1], tangent: [1, 0.2, 0], color: [1, 1, 1], intensity: 2 };
    // A thin tube under a tight lobe is left out: there the highlight moves 4.5% a centimetre, and f32 lands 5% off f64.
    const cases: [SceneLight, number, number][] = [];
    for (const light of [facing, { ...facing, shape: "disk" as const, size: [1, 1] as const }, { ...facing, shape: "tube" as const, size: [1.5, 0.1] as const }]) {
      cases.push([light, 0, 0.5], [light, 1, 0.6]);
      if (light.shape !== "tube") cases.push([light, 1, 0.35]);
    }
    for (const [light, metallic, rough] of cases) {
      {
        const want = expected(light, metallic, rough);
        const got = await centre(quad(metallic, rough), light);
        expect(want).toBeGreaterThan(0.01);
        expect(Math.abs(got - want) / want).toBeLessThan(0.02);
      }
    }
  });

  it("is dark behind a rectangle's lit face", async () => {
    const away: SceneLight = { kind: "area", shape: "rect", size: [1, 1], position: [0, 0, 1.2], direction: [0, 0, 1], color: [1, 1, 1], intensity: 2 };
    expect(await centre(quad(0, 0.5), away)).toBe(0);
  });
});
