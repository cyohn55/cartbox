/**
 * The cook reaching terrain layers and library materials
 * (AAA_PRODUCTION_ROADMAP.md D5): materials the sidecar keeps as objects, not
 * mesh strings. Their recipes are baked once at save, their maps lifted into
 * the asset store like any mesh's, streamed to the player, and supplied to
 * the terrain the AAA tier draws from its heightfield as well as to its blocks.
 */
import { describe, expect, it, vi } from "vitest";
import {
  GENERATOR_KINDS,
  deserializeMaterial,
  encodeRgbaPng,
  generatorRequestCount,
  readTerrains,
  serializeMaterial,
  serializeTerrain,
  type EncodedImage,
  type MeshMaterial,
  type Terrain,
  type TextureGenerator,
} from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene, type SceneRenderer } from "@cartbox/player";
import { hashAsset } from "@/lib/cartAssetStore";
import { cookMeshSidecar } from "@/lib/meshCook";
import { decodeMeshSidecar } from "@/lib/meshSidecar";
import { extractMeshTextures, inlineMeshTextures, meshTextureLevels, meshTextureRefs } from "@/lib/meshTextureAssets";

let seed = 71_000;
/** A recipe this process hasn't baked yet. */
const freshRecipe = (): TextureGenerator => ({ kind: GENERATOR_KINDS[0]!.kind, seed: (seed += 1), scale: 2, tint: [0.6, 0.7, 0.5], size: 64 });
const recipeMaterial = (name: string, g: TextureGenerator): MeshMaterial => ({ name, baseColorFactor: [1, 1, 1, 1], baseColorImage: null, generator: g });

function terrain(layers: MeshMaterial[]): Terrain {
  const n = 9;
  return { id: "ground", name: "Ground", origin: [-8, 0, -8], size: [16, 16], samples: n, heights: new Float32Array(n * n), layers: layers.map((material) => ({ material })) };
}

/** A sidecar as the editor saves it: recipes only, in a terrain's layers and the material library. */
function authored(grass: TextureGenerator, stone: TextureGenerator, plain?: MeshMaterial) {
  return JSON.stringify({
    version: 2,
    meshes: [],
    lighting: null,
    terrains: [serializeTerrain(terrain([recipeMaterial("grass", grass), ...(plain ? [plain] : [])]))],
    materials: [{ id: "stone", material: serializeMaterial(recipeMaterial("stone", stone)) }],
  });
}

const layerMaterial = (encoded: string, k = 0) => JSON.parse(encoded).terrains[0].layers[k].material;
const libraryMaterial = (encoded: string) => JSON.parse(encoded).materials[0].material;

describe("cooking materials kept as objects (D5)", () => {
  it("bakes a terrain layer's and a library material's recipes at save, so a load bakes nothing", () => {
    const saved = authored(freshRecipe(), freshRecipe());
    expect(layerMaterial(saved).image).toBeNull(); // the editor stores the recipe only
    expect(libraryMaterial(saved).image).toBeNull();
    // A load of what the editor saved bakes each recipe.
    let before = generatorRequestCount();
    readTerrains(JSON.parse(saved).terrains);
    decodeMeshSidecar(saved);
    expect(generatorRequestCount() - before).toBeGreaterThanOrEqual(2); // (the sidecar's reader reads its terrains too)

    const cooked = cookMeshSidecar(authored(freshRecipe(), freshRecipe()));
    expect(cooked.cooked).toBe(2);
    const layer = layerMaterial(cooked.encoded);
    expect(layer.cooked?.slots?.length).toBeGreaterThan(0);
    expect(layer.image?.bytes?.length).toBeGreaterThan(0);
    expect(libraryMaterial(cooked.encoded).cooked).toBeTruthy();
    before = generatorRequestCount();
    const [t] = readTerrains(JSON.parse(cooked.encoded).terrains);
    const library = decodeMeshSidecar(cooked.encoded).materials ?? [];
    expect(generatorRequestCount() - before).toBe(0); // nothing baked on load
    expect(t!.layers[0]!.material.baseColorImage?.bytes.length).toBeGreaterThan(0);
    expect(library[0]!.material.baseColorImage?.bytes.length).toBeGreaterThan(0);
  });

  it("leaves a material without a recipe, and a sidecar with nothing to cook, as they were", () => {
    const plain: MeshMaterial = { name: "mud", baseColorFactor: [0.4, 0.3, 0.2, 1], baseColorImage: null };
    const cooked = cookMeshSidecar(authored(freshRecipe(), freshRecipe(), plain));
    expect(layerMaterial(cooked.encoded, 1)).toEqual(serializeMaterial(plain));
    const nothing = JSON.stringify({ version: 2, meshes: [], terrains: [serializeTerrain(terrain([plain]))] });
    expect(cookMeshSidecar(nothing)).toEqual({ encoded: nothing, cooked: 0 });
    // Cooking twice changes nothing more.
    expect(cookMeshSidecar(cooked.encoded).encoded).toBe(cooked.encoded);
  });

  it("lifts the cooked maps into the asset store, lists them to stream at start, and puts them back", async () => {
    const cooked = cookMeshSidecar(authored(freshRecipe(), freshRecipe())).encoded;
    const out = await extractMeshTextures(cooked, hashAsset);
    expect(out.textures.length).toBeGreaterThanOrEqual(2);
    expect(out.encoded.length).toBeLessThan(cooked.length / 4); // the row keeps refs, not PNGs
    expect(typeof layerMaterial(out.encoded).image.asset).toBe("string");
    expect(typeof libraryMaterial(out.encoded).image.asset).toBe("string");
    const refs = meshTextureRefs(out.encoded).map((r) => r.hash);
    expect(refs).toContain(layerMaterial(out.encoded).image.asset);
    // Not tied to a level or an object: streamed at start.
    for (const hash of refs) expect(meshTextureLevels(out.encoded).get(hash)).toBeUndefined();
    const blobs = new Map(out.textures.map((t) => [t.hash, t.bytes]));
    const back = await inlineMeshTextures(out.encoded, async (h) => blobs.get(h) ?? null);
    expect(layerMaterial(back).image).toEqual(layerMaterial(cooked).image);
    expect(libraryMaterial(back).image).toEqual(libraryMaterial(cooked).image);
    // And a load of it bakes nothing either.
    const before = generatorRequestCount();
    readTerrains(JSON.parse(back).terrains);
    expect(generatorRequestCount() - before).toBe(0);
  });
});

describe("streamed terrain maps on the AAA path", () => {
  const renderer = { backend: "webgpu", sunCascades: true, render() {}, dispose() {}, renderToTexture: () => null } as unknown as SceneRenderer;
  const png = (seed: number): EncodedImage => ({ mime: "image/png", bytes: encodeRgbaPng(Uint8Array.from({ length: 4 * 4 * 4 }, (_, i) => (i * 5 + seed) & 255), 4, 4) });

  it("re-decodes a heightfield terrain's layers when their textures arrive, keeping earlier ones", async () => {
    // Node has no image decoder: a stand-in that "decodes" any image to one pixel of its first byte.
    let last = 0;
    vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
      last = new Uint8Array(await blob.arrayBuffer())[0] ?? 0;
      return { width: 1, height: 1, close() {} };
    });
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return { drawImage() {}, getImageData: () => ({ width: 1, height: 1, data: new Uint8ClampedArray([last, last, last, 255]) }) };
        }
      },
    );
    // Two layers whose base colours are asset placeholders, as an offloaded sidecar loads.
    const placeholder = (hash: string) => ({ ...serializeMaterial({ name: hash, baseColorFactor: [1, 1, 1, 1], baseColorImage: null }), image: { mime: "image/png", asset: hash } });
    const t = serializeTerrain(terrain([deserializeMaterial(null), deserializeMaterial(null)]));
    t.layers = [{ material: placeholder("a".repeat(64)) as never }, { material: placeholder("b".repeat(64)) as never }];
    const scene = parseMeshScene(JSON.stringify({ version: 2, meshes: [], lighting: null, terrains: [t] }))!;
    expect(scene.terrains?.[0]?.layers[0]?.material.baseColorImage?.ref).toBe("a".repeat(64));
    const surface = (await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer, { prepass: true })) as any;
    expect(surface.ground).toHaveLength(1);
    const terrainBefore = surface.ground[0].terrain;
    const first = surface.ground[0].layers.map((l: { base: unknown }) => l.base);

    // The first layer's texture arrives: its maps change, the terrain (and so its GPU copy) stays the same object.
    expect(await surface.supplyImages(new Map([["a".repeat(64), png(1)]]))).toBeGreaterThan(0);
    const second = surface.ground[0].layers.map((l: { base: unknown }) => l.base);
    expect(surface.ground[0].terrain).toBe(terrainBefore);
    expect(second[0]).not.toBe(first[0]);
    // Then the second's: both are now textured (the first isn't lost to the second batch).
    await surface.supplyImages(new Map([["b".repeat(64), png(2)]]));
    const third = surface.ground[0].layers.map((l: { base: { width?: number } | null }) => l.base);
    expect(third[1]).not.toBe(second[1]);
    expect(third[0]).not.toBe(first[0]);
    expect(third[0]).not.toBeNull();
    expect(third[1]).not.toBeNull();
    expect(first[0]).toBeNull(); // a placeholder alone draws flat
    // A texture nothing on the ground uses changes nothing there.
    const ground = surface.ground[0];
    await surface.supplyImages(new Map([["c".repeat(64), png(3)]]));
    expect(surface.ground[0]).toBe(ground);
    surface.destroy();
    vi.unstubAllGlobals();
  });
});
