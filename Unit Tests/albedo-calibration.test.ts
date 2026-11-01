/**
 * Albedos re-measured for linear light on the AAA tier (AAA_FIDELITY_ROADMAP.md
 * F11a-13): each opaque material's base colour scaled into the physical range
 * (charcoal to fresh snow, metals at least half reflective) or onto a measured
 * target, by its map's mean, so the map's detail is kept.
 */

import { describe, expect, it } from "vitest";

import { BEAVER_SCENE, PHYSICAL_ALBEDO, aaaLighting, albedoLuminance, calibratedBaseFactor, lockoutMeshSidecar, meanAlbedo, meanMetalness, parseAlbedoCalibration, type DecodedTexture, type MeshAsset } from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene, type SceneRenderer } from "@cartbox/player";
import { arenaMeshSidecar } from "../packages/editor/src/model/lockoutSeed";
import { decodePngRgba } from "../packages/editor/src/model/png";

const encode = (c: number) => Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
/** A map of two linear greys, half and half. */
const map = (a: number, b: number): DecodedTexture => {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < 256; i += 1) data.set([encode(i % 2 ? a : b), encode(i % 2 ? a : b), encode(i % 2 ? a : b), 255], i * 4);
  return { width: 16, height: 16, data };
};
const material = (factor: number, metal = 0, extra: object = {}) => ({ name: "m", baseColorFactor: [factor, factor, factor, 1] as [number, number, number, number], metallicFactor: metal, ...extra });

describe("the range", () => {
  it("reads defensively, and is charcoal to fresh snow with metals at least half reflective", () => {
    expect(PHYSICAL_ALBEDO).toEqual({ min: 0.03, max: 0.9, metalMin: 0.5 });
    expect(parseAlbedoCalibration({ min: -1, max: 2, targets: { snow: 0.8, bad: "x", neg: -1 } })).toEqual({ min: 0, max: 1, metalMin: 0.5, targets: { snow: 0.8 } });
    expect(parseAlbedoCalibration(null)).toBeNull();
  });

  it("measures a material as the renderers shade it: each texel times the factor, then decoded", () => {
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    // A map of two linear greys at factor 1: their mean.
    for (const c of meanAlbedo(material(1), map(0.2, 0.6)).mean) expect(c).toBeCloseTo(0.4, 2);
    // A factor alone is an encoded colour: 0.5 shades as 21%.
    for (const c of meanAlbedo(material(0.5), null).mean) expect(c).toBeCloseTo(lin(0.5), 6);
    // See-through texels are left out.
    const holes = map(0.2, 0.6);
    for (let i = 0; i < 256; i += 2) holes.data[i * 4 + 3] = 0;
    for (const c of meanAlbedo(material(1), holes).mean) expect(c).toBeCloseTo(0.2, 2);
    // Metalness from the factor (glTF's default 1) × the metal-roughness map's blue channel.
    const mr = { width: 2, height: 1, data: new Uint8ClampedArray([0, 128, 255, 255, 0, 128, 0, 255]) };
    expect(meanMetalness({ metallicFactor: 0.8 }, mr)).toBeCloseTo(0.4, 2);
    expect(meanMetalness({}, null)).toBe(1);
  });
});

describe("the calibration", () => {
  const shaded = (m: { baseColorFactor: readonly [number, number, number, number] }, t: DecodedTexture | null = null) => albedoLuminance(meanAlbedo(m, t).mean);
  it("lifts a dielectric darker than charcoal to it, and leaves one in range alone", () => {
    const f = calibratedBaseFactor(material(0.05), null, null, PHYSICAL_ALBEDO)!;
    expect(shaded({ baseColorFactor: f })).toBeCloseTo(0.03, 4);
    expect(calibratedBaseFactor(material(0.5), null, null, PHYSICAL_ALBEDO)).toBeNull();
  });

  it("scales the factor, not the texels, so a map keeps its detail", () => {
    const dark = map(0.004, 0.012);
    const f = calibratedBaseFactor(material(1), dark, null, PHYSICAL_ALBEDO)!;
    expect(shaded({ baseColorFactor: f }, dark)).toBeCloseTo(0.03, 3);
    // One factor for the whole map: its two greys stay apart.
    const a = meanAlbedo({ baseColorFactor: f }, map(0.004, 0.004)).mean[0];
    const b = meanAlbedo({ baseColorFactor: f }, map(0.012, 0.012)).mean[0];
    expect(b / a).toBeGreaterThan(2);
  });

  it("lifts a dark metal to at least half reflective, and a half-metal to the floor in proportion", () => {
    expect(shaded({ baseColorFactor: calibratedBaseFactor(material(0.1, 1), null, null, PHYSICAL_ALBEDO)! })).toBeCloseTo(0.5, 4);
    expect(shaded({ baseColorFactor: calibratedBaseFactor(material(0.1, 0.5), null, null, PHYSICAL_ALBEDO)! })).toBeCloseTo(0.265, 4);
  });

  it("takes a named target in place of the range, but never past a perfect reflector", () => {
    const cal = { ...PHYSICAL_ALBEDO, targets: { m: 0.8 } };
    expect(shaded({ baseColorFactor: calibratedBaseFactor(material(0.6), null, null, cal)! })).toBeCloseTo(0.8, 4);
    // A blend under it takes its first surface's.
    expect(shaded({ baseColorFactor: calibratedBaseFactor({ ...material(0.6), name: "m+other" }, null, null, cal)! })).toBeCloseTo(0.8, 4);
    // A map whose brightest texel would pass 1: held at it, short of the target.
    const bright = map(0.2, 0.95);
    const f = calibratedBaseFactor(material(0.8), bright, null, cal)!;
    expect(Math.max(...meanAlbedo({ baseColorFactor: f }, bright).peak)).toBeCloseTo(1, 3);
    expect(shaded({ baseColorFactor: f }, bright)).toBeLessThan(0.8);
  });

  it("leaves effects alone: see-through, added light, and black stand-ins", () => {
    expect(calibratedBaseFactor(material(0.05, 0, { alphaMode: "blend" }), null, null, PHYSICAL_ALBEDO)).toBeNull();
    expect(calibratedBaseFactor(material(0.05, 0, { alphaMode: "additive" }), null, null, PHYSICAL_ALBEDO)).toBeNull();
    expect(calibratedBaseFactor(material(0), null, null, PHYSICAL_ALBEDO)).toBeNull();
  });
});

const QUAD = (factor: number) =>
  ({
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2]),
        material: { name: "recess", baseColorImage: null, baseColorFactor: [factor, factor, factor, 1], metallicFactor: 0 },
      },
    ],
  }) as unknown as MeshAsset;

describe("the player", () => {
  it("calibrates on the renderer the re-light reaches, and draws the material as authored elsewhere", async () => {
    const draws: { instances: { mesh: MeshAsset }[] }[] = [];
    const renderer = (aaa: boolean) =>
      ({ backend: "webgpu", ...(aaa ? { sunCascades: true } : {}), render: (instances: { mesh: MeshAsset }[]) => draws.push({ instances }), dispose: () => {} }) as unknown as SceneRenderer;
    const lighting = { environment: { sky: [0.4, 0.5, 0.7], horizon: [0.7, 0.8, 0.9], ground: [0.4, 0.4, 0.4], intensity: 1 }, ambient: 0.3, exposure: 1, tonemap: true, shadows: false, lights: [], aaa: { materialAlbedo: PHYSICAL_ALBEDO } };
    const scene = { instances: [{ mesh: QUAD(0.5), model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }], bounds: { min: [-1, 0, -1], max: [1, 1, 1], center: [0, 0.5, 0], radius: 2 }, lighting } as never;
    const factorOf = (surface: MeshOverlaySurface) => (surface as unknown as { instances: { mesh: MeshAsset }[] }).instances[0]!.mesh.primitives[0]!.material.baseColorFactor[0];
    const aaa = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer(true));
    const other = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer(false));
    // A factor of 0.5 shades as 21%: in range, unchanged on both.
    expect(factorOf(other)).toBe(0.5);
    expect(factorOf(aaa)).toBe(0.5);
    // One of 0.05 (0.4%) is lifted to charcoal on the AAA renderer only.
    const dark = { ...(scene as object), instances: [{ mesh: QUAD(0.05), model: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] } as never;
    const aaaDark = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, dark, renderer(true));
    const otherDark = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, dark, renderer(false));
    const lifted = factorOf(aaaDark);
    expect(albedoLuminance(meanAlbedo({ baseColorFactor: [lifted, lifted, lifted, 1] }, null).mean)).toBeCloseTo(0.03, 4);
    expect(factorOf(otherDark)).toBe(0.05);
  });
});

describe("the shipped maps under their re-lights", () => {
  it.each([
    ["Lockout", () => lockoutMeshSidecar()],
    ["Beaver Creek", () => arenaMeshSidecar(BEAVER_SCENE)],
  ] as const)("brings every opaque material of %s into the physical range, or onto its measured target", async (_name, sidecar) => {
    const scene = parseMeshScene(sidecar())!;
    const relit = aaaLighting(scene.lighting!);
    const cal = relit.materialAlbedo!;
    expect(cal).toBeTruthy();
    // Every other tier: no calibration.
    expect(scene.lighting!.materialAlbedo).toBeUndefined();
    const decoded = new Map<unknown, Promise<DecodedTexture | null>>();
    const decode = (image: { mime: string; bytes: Uint8Array } | null | undefined) => {
      if (!image || image.mime !== "image/png" || image.bytes.length === 0) return Promise.resolve(null);
      let entry = decoded.get(image);
      if (!entry) {
        entry = decodePngRgba(image.bytes).then((d) => ({ width: d.width, height: d.height, data: new Uint8ClampedArray(d.data) }));
        decoded.set(image, entry);
      }
      return entry;
    };
    const seen = new Set<string>();
    let lifted = 0;
    for (const instance of scene.instances) {
      for (const primitive of instance.mesh.primitives) {
        const m = primitive.material;
        if (seen.has(m.name) || m.alphaMode === "blend" || m.alphaMode === "additive") continue;
        seen.add(m.name);
        const base = await decode(m.baseColorImage);
        const mr = await decode(m.metallicRoughnessImage);
        const before = albedoLuminance(meanAlbedo(m, base).mean);
        if (!(before > 1e-4)) continue;
        const factor = calibratedBaseFactor(m, base, mr, cal);
        const { mean, peak } = meanAlbedo(factor ? { baseColorFactor: factor } : m, base);
        const after = albedoLuminance(mean);
        const metal = Math.min(1, meanMetalness(m, mr));
        const floor = cal.min + (cal.metalMin - cal.min) * metal;
        const target = cal.targets?.[m.name] ?? cal.targets?.[m.name.split("+")[0]!];
        // Held under a perfect reflector: a texel at 1 is as far as the factor goes.
        const capped = Math.max(...peak) > 0.999;
        if (target !== undefined) {
          if (!capped) expect(after).toBeCloseTo(target, 2);
          else expect(after).toBeLessThanOrEqual(target + 1e-6);
        } else if (!capped) {
          // Within the 1% a material is left alone inside.
          expect(after).toBeGreaterThanOrEqual(floor * 0.99);
          expect(after).toBeLessThanOrEqual(cal.max * 1.01);
        }
        if (factor) lifted += 1;
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    expect(lifted).toBeGreaterThan(0);
  }, 300_000);
});
