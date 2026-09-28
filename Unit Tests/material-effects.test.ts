/**
 * Material surface effects (HALO2_STYLE_ROADMAP.md, H3): detail maps up close,
 * animated emissive (scroll and pulse), a fresnel rim and a masked
 * reflectivity — the model, its stored form, the software rasteriser, the GPU
 * uniforms, and Lockout's use of them.
 */

import { describe, expect, it } from "vitest";

import {
  DETAIL_FAR,
  DETAIL_NEAR,
  builtinDetailGrain,
  composeModelMatrix,
  deserializeMeshAsset,
  detailFade,
  emissiveAnimation,
  lockoutMeshSidecar,
  projectionMatrix,
  readSurfaceEffects,
  renderMeshScene,
  serializeMeshAsset,
  viewMatrix,
  type DecodedTexture,
  type EnvironmentLight,
  type MeshAsset,
  type MeshMaterial,
} from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";

import { NO_SURFACE, UNIFORM_FLOATS, resolveSurface, writeInstanceUniform } from "../packages/player/src/render/scenePacking";

const IDENTITY = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
const PBR: MeshMaterial = { name: "pbr", baseColorFactor: [0.6, 0.6, 0.6, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 };

/** A camera-facing quad (normal +Z) at z = `z`, spanning ±`half`. */
function quad(material: MeshMaterial, z = 0, half = 1): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-half, -half, z, half, -half, z, half, half, z, -half, half, z]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material,
      },
    ],
  };
}

const SIZE = 32;
function centre(
  mesh: MeshAsset,
  opts: { eye?: [number, number, number]; time?: number; detail?: DecodedTexture | null; emis?: DecodedTexture | null; mr?: DecodedTexture | null; environment?: EnvironmentLight | null; light?: [number, number, number] } = {},
): [number, number, number] {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  renderMeshScene(
    [
      {
        mesh,
        model: IDENTITY,
        ...(opts.detail !== undefined ? { detailTextures: [opts.detail] } : {}),
        ...(opts.emis !== undefined ? { emissiveTextures: [opts.emis] } : {}),
        ...(opts.mr !== undefined ? { mrTextures: [opts.mr] } : {}),
      },
    ],
    {
      width: SIZE,
      height: SIZE,
      out,
      depth: new Float32Array(SIZE * SIZE),
      view: viewMatrix(opts.eye ?? [0, 0, 2.5], [0, 0, 0]),
      projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.05, 100),
      lightDirection: opts.light ?? [0, 0, 1],
      ambient: 0.3,
      environment: opts.environment ?? null,
      time: opts.time ?? 0,
    },
  );
  const o = ((SIZE >> 1) * SIZE + (SIZE >> 1)) * 4;
  return [out[o]!, out[o + 1]!, out[o + 2]!];
}

const flat = (r: number, g: number, b: number, a = 255): DecodedTexture => ({ width: 1, height: 1, data: Uint8ClampedArray.from([r, g, b, a]) });

describe("surface-effect model", () => {
  it("reads stored effects defensively, clamping each and dropping the malformed", () => {
    expect(
      readSurfaceEffects({
        detailScale: 1000,
        detailStrength: 2,
        emissiveScroll: [0.5, "x"],
        emissivePulse: { rate: 99, depth: -1 },
        rim: { color: [2, 0.5, 0.5], power: 3, strength: 1 },
        reflectivity: 9,
        reflectionMask: "yes",
      }),
    ).toEqual({ detailScale: 256, detailStrength: 1, emissivePulse: { rate: 30, depth: 0 }, rim: { color: [1, 0.5, 0.5], power: 3, strength: 1 }, reflectivity: 4 });
    expect(readSurfaceEffects({})).toEqual({});
  });

  it("round-trips through the stored form, detail map included", () => {
    const material: MeshMaterial = {
      ...PBR,
      detailImage: builtinDetailGrain(),
      detailScale: 12,
      detailStrength: 0.4,
      emissiveScroll: [0.25, -0.5],
      emissivePulse: { rate: 0.5, depth: 0.3 },
      rim: { color: [0.5, 0.6, 0.9], power: 4, strength: 0.2 },
      reflectivity: 1.3,
      reflectionMask: true,
    };
    const back = deserializeMeshAsset(serializeMeshAsset(quad(material))).primitives[0]!.material;
    expect(Array.from(back.detailImage!.bytes)).toEqual(Array.from(material.detailImage!.bytes));
    const { detailImage: _a, ...restBack } = back;
    const { detailImage: _b, ...rest } = material;
    expect(restBack).toMatchObject(rest);
    // A plain material stores none of it.
    expect(serializeMeshAsset(quad(PBR))).not.toContain("detail");
  });

  it("animates the emissive map: a wrapped scroll offset and a pulse that dips by its depth", () => {
    const m: MeshMaterial = { ...PBR, emissiveScroll: [0.3, 0], emissivePulse: { rate: 0.5, depth: 0.4 } };
    expect(emissiveAnimation(m, 0)).toEqual({ offset: [0, 0], gain: 1 });
    const at1 = emissiveAnimation(m, 1); // half a cycle: the trough
    expect(at1.offset[0]).toBeCloseTo(0.3, 6);
    expect(at1.gain).toBeCloseTo(0.6, 6);
    expect(emissiveAnimation(m, 10).offset[0]).toBeCloseTo(0, 6); // 3.0 wraps to 0
    expect(emissiveAnimation(PBR, 5)).toEqual({ offset: [0, 0], gain: 1 });
  });

  it("fades the detail map out with distance", () => {
    expect(detailFade(0)).toBe(1);
    expect(detailFade(DETAIL_NEAR)).toBe(1);
    expect(detailFade((DETAIL_NEAR + DETAIL_FAR) / 2)).toBeCloseTo(0.5, 6);
    expect(detailFade(DETAIL_FAR + 1)).toBe(0);
  });

  it("ships a built-in tileable grain around mid-grey, one shared image", () => {
    const a = builtinDetailGrain();
    expect(a).toBe(builtinDetailGrain());
    expect(a.mime).toBe("image/png");
  });
});

describe("rasteriser", () => {
  it("blends a detail map in up close and not far away", () => {
    const m = { ...PBR, detailImage: builtinDetailGrain(), detailStrength: 1 };
    const dark = flat(40, 40, 40);
    const [near] = centre(quad(m), { detail: dark });
    const [plain] = centre(quad(PBR));
    expect(near).toBeLessThan(plain - 20);
    // Far beyond DETAIL_FAR (a big quad so it still covers the centre): no detail.
    const far = quad(m, 0, 20);
    const eye: [number, number, number] = [0, 0, DETAIL_FAR + 10];
    expect(centre(far, { detail: dark, eye })).toEqual(centre(quad(PBR, 0, 20), { eye }));
    // Mid-grey is neutral.
    expect(centre(quad(m), { detail: flat(128, 128, 128) })[0]).toBeCloseTo(plain, -1);
  });

  it("pulses the emissive glow over time", () => {
    const glow: MeshMaterial = { ...PBR, baseColorFactor: [0, 0, 0, 1], emissiveFactor: [0.8, 0, 0], emissivePulse: { rate: 0.5, depth: 0.5 } };
    const peak = centre(quad(glow), { time: 0, light: [0, 0, -1] })[0];
    const trough = centre(quad(glow), { time: 1, light: [0, 0, -1] })[0];
    expect(trough).toBeLessThan(peak * 0.7);
  });

  it("scrolls the emissive map", () => {
    // A 2×1 map, lit on its right half only: scrolling by half a tile swaps which half glows at the centre.
    const map: DecodedTexture = { width: 2, height: 1, data: Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255]) };
    const glow: MeshMaterial = { ...PBR, baseColorFactor: [0, 0, 0, 1], emissiveFactor: [1, 1, 1], emissiveScroll: [0.25, 0] };
    const before = centre(quad(glow), { emis: map, time: 0, light: [0, 0, -1] })[0];
    const after = centre(quad(glow), { emis: map, time: 2, light: [0, 0, -1] })[0]; // shifted by 0.5
    expect(Math.abs(after - before)).toBeGreaterThan(100);
  });

  it("adds a fresnel rim at grazing angles, not head-on", () => {
    const rimmed: MeshMaterial = { ...PBR, rim: { color: [0, 0, 1], power: 2, strength: 1 } };
    const light: [number, number, number] = [0, 0, -1];
    const headOn = centre(quad(rimmed), { light })[2];
    expect(headOn).toBeCloseTo(centre(quad(PBR), { light })[2], -1);
    const tilted = { ...quad(rimmed), primitives: [{ ...quad(rimmed, 0, 3).primitives[0]!, positions: Float32Array.from([-3, 0, -3, 3, 0, -3, 3, 0, 3, -3, 0, 3]), normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]) }] };
    const plain = { ...tilted, primitives: [{ ...tilted.primitives[0]!, material: PBR }] };
    const eye: [number, number, number] = [0, 0.4, 3];
    expect(centre(tilted, { eye, light })[2]).toBeGreaterThan(centre(plain, { eye, light })[2] + 30);
  });

  it("scales reflections, masked by the MR map's alpha when asked", () => {
    const sky: EnvironmentLight = { sky: [0.9, 0.9, 0.9], horizon: [0.9, 0.9, 0.9], ground: [0.9, 0.9, 0.9], intensity: 1 };
    const metal: MeshMaterial = { ...PBR, metallicFactor: 1, roughnessFactor: 0.1 };
    const light: [number, number, number] = [0, 0, -1];
    const mr = flat(0, 255, 255, 40); // full metal, full roughness factor, alpha 40
    const base = centre(quad(metal), { environment: sky, light, mr })[0];
    const dull = centre(quad({ ...metal, reflectivity: 0.3 }), { environment: sky, light, mr })[0];
    const masked = centre(quad({ ...metal, reflectionMask: true }), { environment: sky, light, mr })[0];
    expect(dull).toBeLessThan(base - 40);
    expect(masked).toBeLessThan(base - 40);
    // Without an MR map, the mask has nothing to read and changes nothing.
    expect(centre(quad({ ...metal, reflectionMask: true }), { environment: sky, light })).toEqual(centre(quad(metal), { environment: sky, light }));
  });
});

describe("GPU uniforms", () => {
  it("resolves effects as the rasteriser does, and packs them after shadow2", () => {
    const m: MeshMaterial = {
      ...PBR,
      emissiveFactor: [1, 1, 1],
      detailScale: 12,
      detailStrength: 0.4,
      emissiveScroll: [0.3, 0],
      emissivePulse: { rate: 0.5, depth: 0.4 },
      rim: { color: [0.5, 0.5, 1], power: 3, strength: 0.5 },
      reflectivity: 1.5,
      reflectionMask: true,
    };
    const s = resolveSurface(m, 1, true, true);
    expect(s).toMatchObject({ detailScale: 12, detailStrength: 0.4, reflect: 1.5, reflectMask: true, rim: [0.25, 0.25, 0.5], rimPower: 3 });
    expect(s.emisGain).toBeCloseTo(0.6, 6);
    expect(resolveSurface(m, 1, false, false)).toMatchObject({ detailStrength: 0, reflectMask: false }); // maps not bound
    expect(resolveSurface(PBR, 3, false, false)).toEqual(NO_SURFACE);

    const data = new Float32Array(UNIFORM_FLOATS);
    writeInstanceUniform(data, 0, {
      mvp: IDENTITY,
      normalBasis: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      baseColor: [1, 1, 1, 1],
      hasTexture: false,
      light: { direction: [0, 1, 0], ambient: 0.3 },
      viewDir: [0, 0, 1],
      pbr: { metallic: 0, roughness: 1, isPbr: true, emissive: [1, 1, 1] },
      hasMrMap: true,
      hasOcclusionMap: false,
      hasEmissiveMap: false,
      environment: null,
      lightMvp: null,
      shadow: null,
      tonemap: null,
      hasSsao: false,
      model: IDENTITY,
      lightCount: 0,
      surface: s,
    });
    expect(data[176 / 4]).toBeCloseTo(0.6, 5); // emissive × pulse gain
    expect(Array.from(data.subarray(496 / 4, 544 / 4)).map((v) => +v.toFixed(3))).toEqual([12, 0.4, 1.5, 1, 0.3, 0, 0, 0, 0.25, 0.25, 0.5, 3]);
  });
});

describe("Lockout", () => {
  const map = parseMeshScene(lockoutMeshSidecar())!.instances.find((i) => i.id === "lockout-map")!.mesh;
  const byName = (name: string) => map.primitives.find((p) => p.material.name === name)!.material;

  it("puts grain on the walls and deck up close — one shared image", () => {
    const wall = byName("forerunner");
    const deck = byName("forerunner-deck");
    expect(wall.detailImage).toBeTruthy();
    expect(deck.detailImage).toBe(wall.detailImage); // stored once, decoded once
    expect(wall.detailScale).toBeGreaterThan(4);
  });

  it("pulses the cyan trim, with the panels' glow breathing in step", () => {
    const trim = byName("energy").emissivePulse!;
    const wall = byName("forerunner").emissivePulse!;
    expect(trim.depth).toBeGreaterThan(wall.depth);
    expect(trim.rate).toBe(wall.rate);
    expect(byName("forerunner-underside").emissivePulse).toBeUndefined();
  });

  it("gives the metal a rim and masks its reflections to the polished panels", () => {
    const wall = byName("forerunner");
    expect(wall.rim?.strength).toBeGreaterThan(0);
    expect(wall.reflectionMask).toBe(true);
  });
});
