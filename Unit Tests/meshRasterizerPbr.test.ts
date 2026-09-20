/**
 * Phase 2 shading — the software-rasteriser metallic-roughness reference path.
 *
 * The Modern (AAA) tier shades imported glTF materials with a Cook-Torrance
 * metallic-roughness BRDF instead of the fantasy Blinn-Phong/diffuse path. This
 * is the *verifiable* reference for that shading (the WebGPU WGSL variant, which
 * a headless CI cannot run, mirrors it in-browser — see AAA_TIER_ROADMAP.md 2b).
 *
 * A camera-facing quad carries PBR material fields + maps; the checks pin the
 * physically-meaningful behaviour the branch must exhibit, and — crucially — the
 * gate that a material with *no* PBR signal is byte-identical to the fantasy
 * path, so the fantasy tiers never regress.
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type DecodedTexture,
  type Mat4,
  type MeshAsset,
} from "@cartbox/editor";

type Material = MeshAsset["primitives"][number]["material"];

/** A UV-mapped quad facing the camera (normal +Z), carrying `material`. */
function quad(material: Material): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material,
      },
    ],
  };
}

/** A 1×1 texture from four bytes. */
function tex(r: number, g: number, b: number, a: number): DecodedTexture {
  return { width: 1, height: 1, data: Uint8ClampedArray.from([r, g, b, a]) };
}

const SIZE = 64;
const identity = (): Mat4 => composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);

interface Options {
  readonly eye?: readonly [number, number, number];
  readonly light?: readonly [number, number, number];
  readonly ambient?: number;
  readonly mr?: DecodedTexture | null;
  readonly occ?: DecodedTexture | null;
  readonly emis?: DecodedTexture | null;
}

/** Render the quad and return the centre pixel's [r, g, b]. */
function centre(material: Material, opts: Options = {}): [number, number, number] {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const depth = new Float32Array(SIZE * SIZE);
  renderMeshScene(
    [
      {
        mesh: quad(material),
        model: identity(),
        mrTextures: opts.mr !== undefined ? [opts.mr] : undefined,
        occlusionTextures: opts.occ !== undefined ? [opts.occ] : undefined,
        emissiveTextures: opts.emis !== undefined ? [opts.emis] : undefined,
      },
    ],
    {
      width: SIZE,
      height: SIZE,
      out,
      depth,
      view: viewMatrix(opts.eye ?? [0, 0, 5], [0, 0, 0]),
      projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
      lightDirection: opts.light ?? [0, 0, 1],
      ambient: opts.ambient ?? 0.05,
    },
  );
  const i = ((SIZE >> 1) * SIZE + (SIZE >> 1)) * 4;
  return [out[i]!, out[i + 1]!, out[i + 2]!];
}

const GREY: Material = { name: "grey", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null };

describe("rasteriser PBR — metallic-roughness reference path", () => {
  it("a smooth metal gives a far brighter head-on highlight than a rough one", () => {
    // metallic-roughness branch: a low-roughness GGX lobe peaks sharply when the
    // half-vector aligns with the normal (camera + light both head-on).
    const smooth: Material = { ...GREY, metallicFactor: 1, roughnessFactor: 0.05 };
    const rough: Material = { ...GREY, metallicFactor: 1, roughnessFactor: 1 };
    const s = centre(smooth)[0];
    const r = centre(rough)[0];
    expect(s).toBeGreaterThan(r + 100);
  });

  it("a metal's specular is tinted by its base colour (F0 = albedo)", () => {
    // A polished red metal reflects red; the blue channel stays dark because a
    // metal's F0 is its albedo, not the dielectric's neutral 0.04.
    const redMetal: Material = {
      name: "red-metal",
      baseColorFactor: [0.9, 0.0, 0.0, 1],
      baseColorImage: null,
      metallicFactor: 1,
      roughnessFactor: 0.08,
    };
    const [r, , b] = centre(redMetal);
    expect(r).toBeGreaterThan(b + 100);
  });

  it("a rough dielectric keeps its diffuse albedo where a rough metal loses it", () => {
    // Diffuse is the discriminator: a metal has none (kd = 1 − metallic = 0), and
    // at high roughness there is no specular to replace it, so it reads dark; the
    // dielectric shows its base colour.
    const red: [number, number, number, number] = [0.8, 0, 0, 1];
    const dielectric: Material = { name: "d", baseColorFactor: red, baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 };
    const metal: Material = { name: "m", baseColorFactor: red, baseColorImage: null, metallicFactor: 1, roughnessFactor: 1 };
    expect(centre(dielectric)[0]).toBeGreaterThan(centre(metal)[0] + 100);
  });

  it("an emissive factor keeps the surface lit when the light turns away", () => {
    const glow: Material = {
      name: "glow",
      baseColorFactor: [0.5, 0.5, 0.5, 1],
      baseColorImage: null,
      metallicFactor: 0,
      roughnessFactor: 1,
      emissiveFactor: [1, 0, 0],
    };
    // Side light: no diffuse and no specular reach the camera, so only ambient +
    // emissive remain. The red channel is lifted; green (no emissive) is not.
    const [r, g] = centre(glow, { light: [1, 0, 0] });
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(30);
  });

  it("an occlusion map darkens the ambient term", () => {
    const mat: Material = { name: "ao", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 };
    // Side-lit so only the ambient*albedo*ao term survives: AO = 0 blacks it out,
    // AO = 1 leaves the full ambient contribution.
    const lit = centre(mat, { light: [1, 0, 0], ambient: 0.4, occ: tex(255, 255, 255, 255) })[0];
    const occluded = centre(mat, { light: [1, 0, 0], ambient: 0.4, occ: tex(0, 0, 0, 255) })[0];
    expect(lit).toBeGreaterThan(occluded + 20);
    expect(occluded).toBeLessThan(10);
  });

  it("reads roughness/metallic from the packed map (glTF G=rough, B=metal)", () => {
    // Same factors, but the map drives one texel smooth-metal and the other
    // rough-metal: the map's blue/green channels must reach the BRDF.
    const base: Material = { name: "mapped", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 1, roughnessFactor: 1 };
    const smooth = centre(base, { mr: tex(0, 12, 255, 255) })[0]; // low roughness, full metal
    const rough = centre(base, { mr: tex(0, 255, 255, 255) })[0]; // high roughness, full metal
    expect(smooth).toBeGreaterThan(rough + 100);
  });

  it("leaves a non-PBR material byte-identical to the fantasy path (the gate)", () => {
    // GREY carries no metallic/roughness/emissive signal, so buildPbrFrag returns
    // null and the fantasy diffuse path runs. Passing the PBR arrays as all-null
    // must not change a single byte versus omitting them entirely.
    const withNulls = centre(GREY, { mr: null, occ: null, emis: null });
    const without = centre(GREY);
    expect(withNulls).toEqual(without);
    // And it is actually the fantasy diffuse value (head-on: shade ≈ 1), distinct
    // from what the metallic-roughness branch would produce for the same albedo.
    expect(without[0]).toBeGreaterThan(200);
    expect(without).not.toEqual(centre({ ...GREY, metallicFactor: 1, roughnessFactor: 1 }));
  });
});
