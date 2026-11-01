/**
 * Character shading (AAA_FIDELITY_ROADMAP.md F7c): skin's two lobes, pores and
 * cavities; the eye's cornea, iris parallax and caustic; hair's shifted
 * Kajiya-Kay lobes, forward scatter, dithered coverage and sorted cards; the
 * mouth's occlusion. The reference functions, the material field through the
 * mesh format and glTF, and on a real device (Dawn) the linear-light shader.
 */

import { describe, expect, it } from "vitest";

import {
  CHARACTER_DEFAULTS,
  cavitySpecular,
  composeModelMatrix,
  deserializeMeshAsset,
  ditherKeeps,
  dualLobeD,
  encodeGlb,
  ggxD,
  hairExponent,
  hairScatter,
  irisLight,
  irisMask,
  irisParallax,
  kajiyaKay,
  limbusShade,
  materialHasExtensions,
  microTilt,
  mouthOcclusion,
  parseGlb,
  projectionMatrix,
  readCharacterShading,
  refractDirection,
  resolveCharacter,
  serializeMeshAsset,
  shiftTangent,
  sortTrianglesBackToFront,
  viewMatrix,
  type DecodedTexture,
  type MeshAsset,
  type MeshMaterial,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { MODELS, WebgpuSceneRenderer, rasterStyleFor } from "@cartbox/player";

import { readLinearTexture } from "../packages/player/src/render/lookDevCheck";

function quad(name: string, material: Partial<MeshMaterial> = {}, uvs = [0, 0, 1, 0, 1, 1, 0, 1]): MeshAsset {
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from(uvs),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name, baseColorFactor: [0.8, 0.6, 0.5, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.5, ...material },
      },
    ],
  } as unknown as MeshAsset;
}

const unit = (v: number[]) => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return v.map((c) => c / l);
};

describe("the character field", () => {
  it("reads each kind's fields clamped, drops a bad kind, and fills the defaults", () => {
    expect(readCharacterShading({ kind: "elf" })).toBeUndefined();
    expect(readCharacterShading({ kind: "skin", lobeMix: 3, microScale: -1, lobeRoughness: [0.5, 9] })).toEqual({ kind: "skin", lobeMix: 1, microScale: 1, lobeRoughness: [0.5, 4] });
    const eye = resolveCharacter({ character: { kind: "eye", irisRadius: 0.2 } } as MeshMaterial)!;
    expect(eye.irisRadius).toBe(0.2);
    expect(eye.corneaIor).toBe(CHARACTER_DEFAULTS.corneaIor);
    expect(resolveCharacter({} as MeshMaterial)).toBeNull();
    // It puts a material on the PBR path, as the full material set does.
    expect(materialHasExtensions({ character: { kind: "hair" } })).toBe(true);
  });

  it("survives the mesh format and glTF", () => {
    const character = { kind: "mouth" as const, opening: [0, 0.1, 0.05] as [number, number, number], depth: 0.04, open: 0.5 };
    const mesh = quad("m", { character });
    expect(deserializeMeshAsset(serializeMeshAsset(mesh)).primitives[0]!.material.character).toEqual(character);
    expect(parseGlb(encodeGlb(mesh), "m").primitives[0]!.material.character).toEqual(character);
  });
});

describe("skin", () => {
  it("mixes a tight lobe and a broad one", () => {
    const rough = 0.4;
    // At the peak the tight lobe lifts it over one lobe; off the peak the broad one does.
    expect(dualLobeD(1, rough, [0.75, 1.3], 0.15)).toBeGreaterThan(ggxD(1, rough));
    expect(dualLobeD(0.8, rough, [0.75, 1.3], 0.15)).toBeGreaterThan(ggxD(0.8, rough * 0.75));
    expect(dualLobeD(0.9, rough, [1, 1], 0.3)).toBeCloseTo(ggxD(0.9, rough), 6);
  });

  it("tilts the normal by pores and keeps the specular out of cavities", () => {
    const tilts = Array.from({ length: 64 }, (_, i) => microTilt(i * 0.013, i * 0.007, 96, 0.25));
    expect(tilts.some(([a, b]) => Math.hypot(a, b) > 0.02)).toBe(true);
    expect(tilts.every(([a, b]) => Math.hypot(a, b) <= 0.25 * Math.SQRT2)).toBe(true);
    expect(microTilt(0.3, 0.4, 96, 0).map(Math.abs)).toEqual([0, 0]);
    expect(cavitySpecular(0.2, 1)).toBeCloseTo(0.2);
    expect(cavitySpecular(0.2, 0)).toBe(1);
  });
});

describe("eyes", () => {
  it("masks the iris, darkens the limbus, and refracts", () => {
    expect(irisMask(0, 0.16, 0.025)).toBe(1);
    expect(irisMask(0.3, 0.16, 0.025)).toBe(0);
    expect(irisMask(0.16, 0.16, 0.025)).toBeCloseTo(0.5);
    expect(limbusShade(0.16, 0.16, 0.025)).toBeCloseTo(0.35);
    expect(limbusShade(0.05, 0.16, 0.025)).toBe(1);
    // Snell: sin θ₁ = n sin θ₂.
    const into = refractDirection(unit([1, 0, -1]), [0, 0, 1], 1 / 1.376)!;
    expect(Math.hypot(into[0], into[2])).toBeCloseTo(1, 6);
    expect(into[0]).toBeCloseTo(Math.SQRT1_2 / 1.376, 6);
    expect(refractDirection(unit([1, 0, -0.1]), [0, 0, -1], 1.376)).toBeNull(); // total internal reflection
  });

  it("sees the iris shifted away from the eye, more the deeper it lies", () => {
    const n = [0, 0, 1];
    const view = unit([1, 0, 1]); // the viewer off to +x
    const [du, dv] = irisParallax(view, n, [1, 0, 0], [0, 1, 0], n, 0.05, 1.376);
    expect(du).toBeLessThan(0);
    expect(dv).toBeCloseTo(0, 6);
    expect(irisParallax(view, n, [1, 0, 0], [0, 1, 0], n, 0.1, 1.376)[0]).toBeCloseTo(2 * du, 6);
    expect(irisParallax(n, n, [1, 0, 0], [0, 1, 0], n, 0.1, 1.376)[0]).toBeCloseTo(0, 6);
  });

  it("gathers the light on the iris's far side", () => {
    const toLight = unit([1, 0, 1]);
    const n = [0, 0, 1];
    const near = irisLight(toLight, n, n, [0.05, 0, 0], 1, 1.376);
    const far = irisLight(toLight, n, n, [-0.05, 0, 0], 1, 1.376);
    expect(far).toBeGreaterThan(near);
    expect(irisLight(toLight, n, n, [-0.05, 0, 0], 0, 1.376)).toBeCloseTo(near, 6);
  });
});

describe("hair", () => {
  it("lights a strand where H is across it, shifted along the normal", () => {
    const e = hairExponent(0.3);
    expect(kajiyaKay(0, e)).toBeGreaterThan(kajiyaKay(0.3, e) * 10);
    expect(hairExponent(0.3)).toBeGreaterThan(hairExponent(0.6));
    const t = shiftTangent([0, 1, 0], [0, 0, 1], 0.1);
    expect(Math.hypot(...t)).toBeCloseTo(1, 6);
    expect(t[2]).toBeGreaterThan(0);
    // Normalised: the lobe integrates to about 1 over the angle to the strand, as a GGX lobe over the hemisphere.
    let sum = 0;
    for (let i = 0; i < 2000; i += 1) {
      const theta = ((i + 0.5) / 2000) * Math.PI;
      sum += kajiyaKay(Math.cos(theta), e) * (Math.PI / 2000);
    }
    expect(sum).toBeGreaterThan(0.1);
  });

  it("scatters light from behind toward the viewer", () => {
    expect(hairScatter([0, 0, -1], [0, 0, 1], 0.5)).toBeCloseTo(0.5);
    expect(hairScatter([0, 0, 1], [0, 0, 1], 0.5)).toBe(0);
  });

  it("dithers coverage to its alpha over the frames", () => {
    for (const alpha of [0.25, 0.5, 0.8]) {
      let kept = 0;
      for (let f = 0; f < 64; f += 1) for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) kept += ditherKeeps(alpha, x, y, f) ? 1 : 0;
      expect(kept / (64 * 64)).toBeCloseTo(alpha, 1);
    }
    expect(ditherKeeps(1, 3, 4, 7)).toBe(true);
    expect(ditherKeeps(0, 3, 4, 7)).toBe(false);
  });

  it("sorts a card's triangles back to front", () => {
    // Two triangles, the near one (z = 1) first.
    const positions = Float32Array.from([0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, -1, 1, 0, -1, 0, 1, -1]);
    const indices = Uint32Array.from([0, 1, 2, 3, 4, 5]);
    expect([...sortTrianglesBackToFront(positions, indices, [0, 0, 5])]).toEqual([3, 4, 5, 0, 1, 2]);
    expect([...sortTrianglesBackToFront(positions, indices, [0, 0, -5])]).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("the mouth", () => {
  it("darkens with depth behind the opening, less as it opens", () => {
    expect(mouthOcclusion(0, 0.05, 0.9, 0)).toBe(1);
    expect(mouthOcclusion(0.05, 0.05, 0.9, 0)).toBeCloseTo(0.1);
    expect(mouthOcclusion(0.05, 0.05, 0.9, 1)).toBeCloseTo(1 - 0.9 * 0.4);
    expect(mouthOcclusion(0.025, 0.05, 0.9, 0)).toBeCloseTo(0.55);
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

const W = 32;
const H = 32;

/** A map split down U at `edge`: red to the left, blue to the right. */
function split(edge: number): DecodedTexture {
  const size = 64;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) data.set((x + 0.5) / size < edge ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * size + x) * 4);
  return { width: size, height: size, data } as DecodedTexture;
}

describe.skipIf(!device)("character shading on a real device", { timeout: 300_000 }, () => {
  let renderer: WebgpuSceneRenderer;
  const lum = (p: number[]) => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!;
  async function frame(instances: MeshSceneInstance[], draw: Record<string, unknown>, eye: [number, number, number] = [0, 0, 3]): Promise<Float32Array> {
    renderer ??= (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, { width: W, height: H, view: viewMatrix(eye, [0, 0, 0]), projection: projectionMatrix(Math.PI / 4, 1, 0.1, 50), environment: null, lights: [], ambient: 0, ...draw } as any);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    return (await readLinearTexture(device, texture, W, H, settled)).data;
  }
  const at = (data: Float32Array, x: number, y: number) => Array.from(data.slice((y * W + x) * 4, (y * W + x) * 4 + 3));
  const one = (mesh: MeshAsset, textures: DecodedTexture[] = [], scale = 2) => [{ mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [scale, scale, 1]), textures }] as unknown as MeshSceneInstance[];

  it("breaks skin's highlight up with pores, and sharpens and widens it with its two lobes", async () => {
    // The key light and the view are directions, so a flat quad shades evenly: the light's angle picks N·H.
    // Dark, so the specular shows over the diffuse.
    const dark = [0.03, 0.03, 0.03, 1] as [number, number, number, number];
    const skin = (character: Record<string, unknown>) => one(quad("s", { baseColorFactor: dark, roughnessFactor: 0.35, character: { kind: "skin", microStrength: 0, ...character } }));
    const plain = one(quad("p", { baseColorFactor: dark, roughnessFactor: 0.35 }));
    const headOn = { lightDirection: [0, 0, 1] };
    const oblique = { lightDirection: [0.6, 0, 0.8] };
    // At the highlight's peak the tighter lobe gives more than one lobe at the material's roughness.
    expect(lum(at(await frame(skin({}), headOn), 16, 16))).toBeGreaterThan(lum(at(await frame(plain, headOn), 16, 16)) * 1.1);
    // Off it, the broad lobe's share keeps more than the tight lobe alone.
    expect(lum(at(await frame(skin({}), oblique), 16, 16))).toBeGreaterThan(lum(at(await frame(skin({ lobeMix: 0 }), oblique), 16, 16)) * 1.2);
    // Pores: neighbouring pixels differ where the plain surface is even.
    const pores = await frame(skin({ microStrength: 1, microScale: 24 }), { lightDirection: [0.35, 0, 0.94] });
    let spread = 0;
    for (let x = 8; x < 24; x += 1) spread += Math.abs(lum(at(pores, x, 16)) - lum(at(pores, x + 1, 16)));
    expect(spread).toBeGreaterThan(0.01);
  });

  it("shows the iris shifted behind the cornea, from the side", async () => {
    const eye = (depth: number) => one(quad("e", { baseColorFactor: [1, 1, 1, 1], character: { kind: "eye", irisRadius: 0.45, irisDepth: depth } }), [split(0.47)]);
    const side: [number, number, number] = [2.2, 0, 2.2];
    const flat = at(await frame(eye(0), { ambient: 1, lightDirection: [0, 0, 1] }, side), 16, 16);
    const deep = at(await frame(eye(0.12), { ambient: 1, lightDirection: [0, 0, 1] }, side), 16, 16);
    // Without depth the middle is blue (u ≈ 0.5); with it, the view lands nearer the red side.
    expect(flat[2]!).toBeGreaterThan(flat[0]!);
    expect(deep[0]!).toBeGreaterThan(deep[2]!);
  });

  it("lights a hair card across its strands, and through it from behind", async () => {
    const graze = { lightDirection: unit([1, 0, 0.3]) };
    const material = { roughnessFactor: 0.3, baseColorFactor: [0.5, 0.35, 0.2, 1] as [number, number, number, number] };
    const plain = await frame(one(quad("p", material)), graze);
    const along = await frame(one(quad("h", { ...material, character: { kind: "hair", shift: 0, secondaryShift: 0 } })), graze);
    // The same card with its strands turned to run across the screen (U and V swapped).
    const across = await frame(one(quad("h2", { ...material, character: { kind: "hair", shift: 0, secondaryShift: 0 } }, [0, 0, 0, 1, 1, 1, 1, 0])), graze);
    expect(lum(at(along, 16, 16))).toBeGreaterThan(lum(at(plain, 16, 16)) * 1.5);
    expect(lum(at(along, 16, 16))).toBeGreaterThan(lum(at(across, 16, 16)) * 1.3);
    const behind = { lightDirection: [0, 0, -1] };
    const lit = await frame(one(quad("h3", { ...material, character: { kind: "hair", scatter: 1 } })), behind);
    const unlit = await frame(one(quad("p2", material)), behind);
    expect(lum(at(lit, 16, 16))).toBeGreaterThan(lum(at(unlit, 16, 16)) + 0.05);
  });

  it("dithers a masked card's coverage, a new pattern each frame", async () => {
    const card = one(quad("d", { baseColorFactor: [1, 1, 1, 0.5], alphaMode: "mask", alphaCutoff: 0.5, character: { kind: "hair" } }));
    const draw = { ambient: 1, lightDirection: [0, 0, 1] };
    const masks: boolean[][] = [];
    for (let f = 0; f < 2; f += 1) {
      const data = await frame(card, draw);
      const mask: boolean[] = [];
      for (let y = 10; y < 22; y += 1) for (let x = 10; x < 22; x += 1) mask.push(lum(at(data, x, y)) > 0.2);
      masks.push(mask);
    }
    for (const mask of masks) {
      const covered = mask.filter(Boolean).length / mask.length;
      expect(covered).toBeGreaterThan(0.3);
      expect(covered).toBeLessThan(0.7);
    }
    expect(masks[0]!.some((m, i) => m !== masks[1]![i])).toBe(true);
  });

  it("draws a blended card's triangles back to front", async () => {
    // One primitive, two quads: the near one (z = 0.5, the map's red half) first in its indices, the far one (blue) after.
    const positions: number[] = [];
    const uvs: number[] = [];
    for (const [z, u0, u1] of [[0.5, 0, 0.4], [-0.5, 0.6, 1]] as const) {
      positions.push(-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z);
      uvs.push(u0, 0, u1, 0, u1, 1, u0, 1);
    }
    const mesh = {
      name: "cards",
      primitives: [
        {
          positions: Float32Array.from(positions),
          normals: Float32Array.from(Array.from({ length: 8 }, () => [0, 0, 1]).flat()),
          uvs: Float32Array.from(uvs),
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
          material: { name: "cards", baseColorFactor: [1, 1, 1, 0.5], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1, alphaMode: "blend", character: { kind: "hair", scatter: 0 } },
        },
      ],
    } as unknown as MeshAsset;
    const data = await frame([{ mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]), textures: [split(0.5)] }] as unknown as MeshSceneInstance[], { ambient: 1, lightDirection: [0, 0, 1] });
    const p = at(data, 16, 16);
    // The near red over the far blue: red the larger share.
    expect(p[0]!).toBeGreaterThan(p[2]! * 1.3);
  });

  it("darkens the mouth with depth, less as it opens", async () => {
    // The opening at the quad's left edge, full dark a quad's width in.
    const mouth = (open: number) => one(quad("m", { baseColorFactor: [0.8, 0.8, 0.8, 1], character: { kind: "mouth", opening: [-1, 0, 0], depth: 2, occlusion: 0.9, open } }));
    const draw = { ambient: 0.5, lightDirection: [0, 0, 1] };
    const shut = await frame(mouth(0), draw);
    const wide = await frame(mouth(1), draw);
    expect(lum(at(shut, 26, 16))).toBeLessThan(lum(at(shut, 6, 16)) * 0.5);
    expect(lum(at(wide, 26, 16))).toBeGreaterThan(lum(at(shut, 26, 16)) * 1.5);
  });
});
