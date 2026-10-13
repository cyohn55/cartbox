/**
 * Texture generators (EDITOR_PRO_ROADMAP.md P1c): every kind bakes four
 * matching, tileable maps, deterministically from its recipe; a material
 * keeps the recipe, not the maps, and bakes them again when it loads.
 */

import { describe, expect, it } from "vitest";
import {
  GENERATOR_KINDS,
  deserializeMeshAsset,
  generateTextures,
  readGenerator,
  serializeMeshAsset,
  type MeshAsset,
  type TextureGenerator,
} from "@cartbox/editor";

import { decodeRgbaPng as decode } from "./helpers/pngDecode";

const recipe = (kind: TextureGenerator["kind"], seed = 4): TextureGenerator => ({ kind, seed, scale: 1, tint: [1, 1, 1], size: 64 });

describe("texture generators", () => {
  it("bake four maps of the recipe's size for every kind, the same every time", () => {
    for (const { kind } of GENERATOR_KINDS) {
      const maps = generateTextures(recipe(kind));
      for (const image of [maps.albedo, maps.normal, maps.metallicRoughness, maps.relief]) expect(decode(image.bytes).width, kind).toBe(64);
      // Memoised: the same recipe is the same images…
      expect(generateTextures(recipe(kind)).albedo).toBe(maps.albedo);
      // …and a different seed a different surface.
      expect(Buffer.compare(Buffer.from(generateTextures(recipe(kind, 5)).albedo.bytes), Buffer.from(maps.albedo.bytes)), kind).not.toBe(0);
    }
  });

  it("tile: the left and right edges, and the top and bottom, run on into each other", () => {
    for (const { kind } of GENERATOR_KINDS) {
      const { data, width } = decode(generateTextures({ ...recipe(kind), size: 128 }).albedo.bytes);
      const px = (x: number, y: number) => data[(((y + width) % width) * width + ((x + width) % width)) * 4]!;
      // The step across a column (or row) boundary, summed down it; boundary 0 is the wrap-around seam.
      const across = (b: number, rows: boolean) => {
        let sum = 0;
        for (let i = 0; i < width; i += 1) sum += rows ? Math.abs(px(i, b) - px(i, b - 1)) : Math.abs(px(b, i) - px(b - 1, i));
        return sum;
      };
      for (const rows of [false, true]) {
        let roughest = 0;
        for (let b = 1; b < width; b += 1) roughest = Math.max(roughest, across(b, rows));
        // The seam is no rougher than the roughest boundary inside the texture (a mortar or panel line can land on it).
        expect(across(0, rows), `${kind} ${rows ? "rows" : "columns"}`).toBeLessThanOrEqual(roughest);
      }
    }
  });

  it("make normal maps that point out of the surface, and roughness in G", () => {
    const maps = generateTextures(recipe("stone"));
    const n = decode(maps.normal.bytes).data;
    for (let i = 0; i < n.length; i += 4) expect(n[i + 2]!).toBeGreaterThan(127);
    const mr = decode(generateTextures(recipe("forerunner")).metallicRoughness.bytes).data;
    expect(Math.max(...Array.from({ length: 64 }, (_, i) => mr[(16 * 64 + i) * 4 + 2]!))).toBeGreaterThan(150); // metal in B, along a row through the panels' middles
  });

  it("read a stored recipe defensively", () => {
    expect(readGenerator({ kind: "mud", seed: 2.7, scale: 99, tint: [2, -1, 0.5], size: 300 })).toEqual({ kind: "mud", seed: 2, scale: 8, tint: [2, 0, 0.5], size: 256 });
    expect(readGenerator({ kind: "lava" })).toBeUndefined();
    expect(readGenerator(null)).toBeUndefined();
  });
});

describe("a material with a generator", () => {
  const quad = (material: Partial<MeshAsset["primitives"][number]["material"]>): MeshAsset => ({
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0]),
        normals: null,
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1]),
        indices: Uint32Array.from([0, 1, 2]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, ...material },
      },
    ],
  });

  it("is saved as its recipe alone, and loads with its maps baked", () => {
    const generator = { ...recipe("cliff"), size: 256 };
    const maps = generateTextures(generator);
    const mesh = quad({ generator, baseColorImage: maps.albedo, normalImage: maps.normal, metallicRoughnessImage: maps.metallicRoughness, reliefImage: maps.relief });
    const stored = serializeMeshAsset(mesh);
    expect(stored.length).toBeLessThan(2000); // four 256² maps would be tens of kilobytes
    const loaded = deserializeMeshAsset(stored).primitives[0]!.material;
    expect(loaded.generator).toEqual(generator);
    expect(loaded.baseColorImage).toBe(maps.albedo);
    expect(loaded.normalImage).toBe(maps.normal);
    expect(loaded.metallicRoughnessImage).toBe(maps.metallicRoughness);
    expect(loaded.reliefImage).toBe(maps.relief);
  });

  it("keeps maps of its own (painted over, or detached) as images", () => {
    const maps = generateTextures(recipe("grass"));
    const painted = { mime: "image/png", bytes: maps.albedo.bytes.slice() };
    const stored = serializeMeshAsset(quad({ generator: recipe("grass"), baseColorImage: painted, normalImage: maps.normal }));
    const loaded = deserializeMeshAsset(stored).primitives[0]!.material;
    expect(Buffer.compare(Buffer.from(loaded.baseColorImage!.bytes), Buffer.from(painted.bytes))).toBe(0);
    expect(loaded.normalImage).toBe(maps.normal);
    // Detached ("Keep the maps"): no recipe, so every map is stored.
    const detached = serializeMeshAsset(quad({ baseColorImage: maps.albedo }));
    expect(deserializeMeshAsset(detached).primitives[0]!.material.baseColorImage).not.toBeNull();
  });
});
