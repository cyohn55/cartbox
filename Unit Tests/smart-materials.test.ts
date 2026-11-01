/**
 * Smart materials (AAA_FIDELITY_ROADMAP.md F9b): masks generated from bakes
 * (edge wear, dirt, rust, ID), brush strokes and anchors; a stack painted into
 * a texture set, heights bending its normals; the presets; storage on the
 * material; and UDIM tiles split into one primitive and texture set a tile.
 */

import { describe, expect, it } from "vitest";

import {
  SMART_PRESETS,
  applyTextureSet,
  deserializeMaterial,
  evaluateMask,
  paintSmartStack,
  serializeMaterial,
  splitUdim,
  textureSetFiles,
  udimTile,
  udimTiles,
  type DecodedTexture,
  type MeshAsset,
  type MeshMaterial,
  type MeshPrimitive,
  type SmartStack,
} from "@cartbox/editor";

const S = 32;
/** A bake of size S filled per texel by `fn` (RGB 0..255). */
function bake(fn: (x: number, y: number) => [number, number, number]): DecodedTexture {
  const data = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) data.set([...fn(x, y), 255], (y * S + x) * 4);
  return { width: S, height: S, data };
}
const NONE = new Map<string, Float32Array>();
const at = (m: Float32Array, x: number, y: number) => m[y * S + x]!;
const base: Pick<MeshMaterial, "baseColorFactor" | "metallicFactor" | "roughnessFactor"> = { baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0, roughnessFactor: 1 };

describe("smart masks", () => {
  // A convex edge down the middle column band (curvature high), a concave seam along the top rows.
  const relief = bake((x, y) => [255, x >= 14 && x < 18 ? 255 : y < 4 ? 0 : 128, 0]);
  // Dark occlusion in the bottom-left corner.
  const occlusion = bake((x, y) => (x < 8 && y > 24 ? [40, 40, 40] : [255, 255, 255]));
  // Position: y (G) rises up the image (row 0 is the top).
  const position = bake((_x, y) => [128, 255 - Math.round((y / (S - 1)) * 255), 128]);
  // Two parts: the left half red, the right half blue.
  const id = bake((x) => (x < 16 ? [220, 40, 40] : [40, 40, 220]));
  const bakes = { relief, occlusion, position, id };

  it("wears the convex edges, and nothing flat", () => {
    const m = evaluateMask({ kind: "edgeWear", level: 0.3, width: 0.05 }, S, bakes, NONE);
    expect(at(m, 15, 10)).toBeGreaterThan(0.95);
    expect(at(m, 4, 10)).toBeLessThan(0.05);
    // The concave seam is no edge.
    expect(at(m, 4, 1)).toBeLessThan(0.05);
  });

  it("puts dirt in occlusion and in cavities", () => {
    const m = evaluateMask({ kind: "dirt", level: 0.4, width: 0.1 }, S, bakes, NONE);
    expect(at(m, 3, 28)).toBeGreaterThan(0.9);
    expect(at(m, 4, 1)).toBeGreaterThan(0.5);
    expect(at(m, 24, 12)).toBeLessThan(0.05);
  });

  it("runs rust down to the low ground", () => {
    const m = evaluateMask({ kind: "rust", level: 0.35, width: 0.15 }, S, bakes, NONE);
    const row = (y: number) => Array.from({ length: S }, (_, x) => at(m, x, y)).reduce((a, b) => a + b, 0) / S;
    expect(row(S - 2)).toBeGreaterThan(row(2) + 0.2);
  });

  it("picks one part by the ID map's colour", () => {
    const m = evaluateMask({ kind: "id", idColour: [220, 40, 40] }, S, bakes, NONE);
    expect(at(m, 5, 5)).toBe(1);
    expect(at(m, 25, 5)).toBe(0);
  });

  it("paints and erases with brush strokes, hard or soft", () => {
    const m = evaluateMask({ kind: "paint", strokes: [{ u: 0.5, v: 0.5, radius: 0.2, hardness: 1, strength: 1 }, { u: 0.5, v: 0.5, radius: 0.05, hardness: 1, strength: -1 }] }, S, bakes, NONE);
    expect(at(m, 16, 20)).toBe(1);
    expect(at(m, 16, 16)).toBe(0);
    expect(at(m, 2, 2)).toBe(0);
    const soft = evaluateMask({ kind: "paint", strokes: [{ u: 0.5, v: 0.5, radius: 0.3, hardness: 0, strength: 1 }] }, S, bakes, NONE);
    expect(at(soft, 16, 16)).toBeGreaterThan(at(soft, 16, 22));
    expect(at(soft, 16, 22)).toBeGreaterThan(0);
  });

  it("anchors one layer's mask to another's, inverted", () => {
    const wear = evaluateMask({ kind: "edgeWear", level: 0.3, width: 0.05 }, S, bakes, NONE);
    const m = evaluateMask({ kind: "anchor", anchor: "wear", invert: true }, S, bakes, new Map([["wear", wear]]));
    for (const [x, y] of [[15, 10], [4, 10]] as const) expect(at(m, x, y)).toBeCloseTo(1 - at(wear, x, y), 6);
  });
});

describe("painting a stack", () => {
  const relief = bake((x) => [255, x >= 14 && x < 18 ? 255 : 128, 0]);
  const stack: SmartStack = {
    layers: [
      { id: "steel", name: "Steel", baseColor: [0.6, 0.6, 0.6], metallic: 1, roughness: 0.3 },
      { id: "wear", name: "Wear", visible: false, mask: { kind: "edgeWear", level: 0.3, width: 0.05 } },
      { id: "paint", name: "Paint", baseColor: [0.8, 0.1, 0.1], metallic: 0, roughness: 0.6, height: 0.5, mask: { kind: "anchor", anchor: "wear", invert: true } },
      { id: "glow", name: "Glow", emissive: [1, 0.5, 0], mask: { kind: "paint", strokes: [{ u: 0.1, v: 0.1, radius: 0.05, hardness: 1, strength: 1 }] } },
    ],
  };
  const set = paintSmartStack(stack, S, { relief }, base);
  const px = (t: DecodedTexture, x: number, y: number) => Array.from(t.data.slice((y * S + x) * 4, (y * S + x) * 4 + 3));

  it("fills each channel through its masks, bottom up", () => {
    // Paint on the flats, steel showing at the worn edge.
    expect(px(set.baseColor, 4, 20)[0]).toBeGreaterThan(200);
    expect(px(set.baseColor, 4, 20)[1]).toBeLessThan(100);
    expect(px(set.metallicRoughness, 4, 20)).toEqual([0, Math.round(0.6 * 255), 0]);
    expect(px(set.metallicRoughness, 15, 20)).toEqual([0, Math.round(0.3 * 255), 255]);
    expect(px(set.baseColor, 15, 20)[0]).toBe(px(set.baseColor, 15, 20)[1]);
    // The glow where it was painted, black elsewhere.
    expect(px(set.emissive, 3, 3)[0]).toBe(255);
    expect(px(set.emissive, 20, 20)).toEqual([0, 0, 0]);
  });

  it("bends the normals where the paint's height steps down to the bare edge, and leaves the flats flat", () => {
    const flat = px(set.normal, 4, 20);
    expect(flat).toEqual([128, 128, 255]);
    // Across the step at x = 13 → 14 the paint (height) ends: the normal leans along +x... away from the high side.
    const left = px(set.normal, 13, 20);
    const right = px(set.normal, 18, 20);
    expect(left[0]).toBeGreaterThan(132);
    expect(right[0]).toBeLessThan(124);
  });

  it("goes on a material, which stores its stack and keeps it through a save", () => {
    const material: MeshMaterial = { name: "m", baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 };
    const painted = applyTextureSet(material, set, stack);
    expect(painted.baseColorImage?.mime).toBe("image/png");
    expect(painted.metallicRoughnessImage).toBeTruthy();
    expect(painted.normalImage).toBeTruthy();
    expect(painted.emissiveImage).toBeTruthy();
    expect([painted.metallicFactor, painted.roughnessFactor]).toEqual([1, 1]);
    const back = deserializeMaterial(JSON.parse(JSON.stringify(serializeMaterial(painted))));
    expect(back.smartStack).toEqual(stack);
  });

  it("paints the presets", () => {
    for (const preset of SMART_PRESETS) {
      const out = paintSmartStack(preset.stack, 16, { relief }, base);
      expect(out.size).toBe(16);
      expect(out.masks.size).toBe(preset.stack.layers.length);
    }
  });
});

describe("UDIM", () => {
  const material: MeshMaterial = { name: "hero", baseColorFactor: [1, 1, 1, 1], baseColorImage: null };
  // Two quads: one in tile 1001 (u 0..1), one in tile 1002 (u 1..2).
  const quad = (u0: number): number[] => [u0 + 0.02, 0.02, u0 + 0.98, 0.02, u0 + 0.98, 0.98, u0 + 0.02, 0.98];
  const prim: MeshPrimitive = {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 3, 1, 0, 2, 1, 0]),
    normals: Float32Array.from(Array.from({ length: 8 }, () => [0, 0, 1]).flat()),
    uvs: Float32Array.from([...quad(0), ...quad(1)]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
    material,
  } as unknown as MeshPrimitive;

  it("numbers tiles as the tools do, and finds a primitive's", () => {
    expect(udimTile(0.5, 0.5)).toBe(1001);
    expect(udimTile(1.5, 0.5)).toBe(1002);
    expect(udimTile(0.5, 1.5)).toBe(1011);
    expect(udimTiles(prim)).toEqual([1001, 1002]);
  });

  it("splits a primitive into one a tile, its coordinates in 0..1", () => {
    const split = splitUdim({ name: "hero", primitives: [prim] } as unknown as MeshAsset);
    expect(split.primitives).toHaveLength(2);
    expect(split.primitives.map((p) => p.material.name)).toEqual(["hero.1001", "hero.1002"]);
    for (const p of split.primitives) {
      expect(p.indices).toHaveLength(6);
      expect(Math.max(...p.uvs!)).toBeLessThanOrEqual(1);
      expect(Math.min(...p.uvs!)).toBeGreaterThanOrEqual(0);
    }
  });

  it("names a tile's texture set's files", () => {
    const set = paintSmartStack({ layers: [{ id: "a", name: "A", baseColor: [1, 0, 0] }] }, 8, {}, base);
    expect(textureSetFiles("hero", set, 1002).map((f) => f.name)).toEqual(["hero_BaseColor.1002.png", "hero_MetallicRoughness.1002.png", "hero_Normal.1002.png", "hero_Emissive.1002.png"]);
  });
});
