/**
 * The cook (AAA_PRODUCTION_ROADMAP.md D5): a generator's maps baked when the
 * cart is saved, so a load (the player's, or the editor's) uses them and
 * bakes nothing. Measured by the generator's own count of requests for maps
 * (memoised or not): a cooked load makes none, where a plain one makes one.
 */
import { describe, expect, it } from "vitest";
import {
  GENERATOR_KINDS,
  deserializeMeshAsset,
  generateTextures,
  generatorRequestCount,
  serializeMeshAsset,
  type MeshAsset,
  type MeshMaterial,
  type TextureGenerator,
} from "@cartbox/editor";
import { hashAsset } from "@/lib/cartAssetStore";
import { cookMeshSidecar } from "@/lib/meshCook";
import { extractMeshPackages, inlineMeshPackages, loadMeshoptCodec } from "@/lib/meshPackages";
import { extractMeshTextures, inlineMeshTextures } from "@/lib/meshTextureAssets";

let seed = 9000;
/** A recipe this process hasn't baked yet. */
const freshRecipe = (): TextureGenerator => ({ kind: GENERATOR_KINDS[0]!.kind, seed: (seed += 1), scale: 2, tint: [1, 0.9, 0.8], size: 64 });

function quadMesh(material: MeshMaterial, name = "q"): MeshAsset {
  // Enough triangles that D4 packages it (over 4 KB of JSON).
  const n = 16;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= n; j += 1) for (let i = 0; i <= n; i += 1) {
    positions.push(i, 0, j);
    uvs.push(i / n, j / n);
  }
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) {
    const a = j * (n + 1) + i;
    indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
  }
  return { name, primitives: [{ positions: Float32Array.from(positions), normals: null, uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material }] };
}

/** A mesh as the editor saves it: the recipe, no maps. */
const authored = (g: TextureGenerator, own?: MeshMaterial["normalImage"]) =>
  serializeMeshAsset(quadMesh({ name: "rock", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, generator: g, ...(own ? { normalImage: own } : {}) }));

const sidecar = (...meshes: string[]) => JSON.stringify({ version: 1, meshes: meshes.map((mesh, i) => ({ id: `m${i}`, name: `M${i}`, mesh })), lighting: null });

describe("the cook (D5)", () => {
  it("bakes a generator's maps into the saved mesh, so a load bakes nothing", () => {
    const g = freshRecipe();
    const saved = authored(g);
    expect(JSON.parse(saved).primitives[0].material.image).toBeNull(); // the editor stores the recipe only
    const before = generatorRequestCount();
    const cooked = cookMeshSidecar(sidecar(saved));
    expect(cooked.cooked).toBe(1);
    expect(generatorRequestCount()).toBe(before + 2); // on the server: reading the authored mesh asks for the raw maps, the cook for the compressed
    const mesh = JSON.parse(JSON.parse(cooked.encoded).meshes[0].mesh);
    expect(mesh.primitives[0].material.cooked.slots.sort()).toEqual(["baseColorImage", "metallicRoughnessImage", "normalImage", "reliefImage"]);
    const plainLoads = generatorRequestCount();
    deserializeMeshAsset(saved);
    expect(generatorRequestCount()).toBe(plainLoads + 1); // the control: an uncooked load asks
    const loads = generatorRequestCount();
    const loaded = deserializeMeshAsset(JSON.parse(cooked.encoded).meshes[0].mesh);
    expect(generatorRequestCount()).toBe(loads);
    const m = loaded.primitives[0]!.material;
    expect(Array.from(m.baseColorImage!.bytes)).toEqual(Array.from(generateTextures(g).albedo.bytes));
    expect(m.generator).toEqual(g);
  });

  it("leaves the editor's own save as the recipe, and keeps a map of the material's own", () => {
    const own = { mime: "image/png", bytes: Uint8Array.from([137, 80, 78, 71, 1, 2, 3]) };
    const cooked = cookMeshSidecar(sidecar(authored(freshRecipe(), own)));
    const mesh = deserializeMeshAsset(JSON.parse(cooked.encoded).meshes[0].mesh);
    const resaved = JSON.parse(serializeMeshAsset(mesh)).primitives[0].material;
    expect(resaved.image).toBeNull(); // the cooked maps are the generator's: left out again
    expect(resaved.cooked).toBeUndefined();
    expect(resaved.normalImage).not.toBeNull(); // the material's own normal map kept
    expect(JSON.parse(JSON.parse(cooked.encoded).meshes[0].mesh).primitives[0].material.cooked.slots).not.toContain("normalImage");
  });

  it("bakes again when the recipe no longer matches its maps, and leaves other meshes untouched", () => {
    const g = freshRecipe();
    const cooked = JSON.parse(cookMeshSidecar(sidecar(authored(g))).encoded).meshes[0].mesh as string;
    const edited = JSON.parse(cooked);
    edited.primitives[0].material.generator.seed += 1; // hand-edited: the maps are stale
    const before = generatorRequestCount();
    deserializeMeshAsset(JSON.stringify(edited));
    expect(generatorRequestCount()).toBe(before + 1);
    const plain = serializeMeshAsset(quadMesh({ name: "p", baseColorFactor: [1, 0, 0, 1], baseColorImage: null }));
    const out = cookMeshSidecar(sidecar(plain));
    expect(out.cooked).toBe(0);
    expect(out.encoded).toBe(sidecar(plain));
  });

  it("survives the save path (textures offloaded, meshes packaged) and the load path, still cooked", async () => {
    const g = freshRecipe();
    const codec = await loadMeshoptCodec();
    const cooked = cookMeshSidecar(sidecar(authored(g))).encoded;
    const textures = await extractMeshTextures(cooked, hashAsset);
    expect(textures.textures).toHaveLength(4); // the four maps, as content-addressed textures
    const packaged = await extractMeshPackages(textures.encoded, hashAsset, codec);
    expect(packaged.packages).toHaveLength(1);
    const store = new Map([...textures.textures, ...packaged.packages].map((t) => [t.hash, t.bytes]));
    const fetch = async (hash: string) => store.get(hash) ?? null;
    const back = await inlineMeshTextures(await inlineMeshPackages(packaged.encoded, fetch, codec), fetch);
    const before = generatorRequestCount();
    const mesh = deserializeMeshAsset(JSON.parse(back).meshes[0].mesh);
    expect(generatorRequestCount()).toBe(before);
    expect(Array.from(mesh.primitives[0]!.material.normalImage!.bytes)).toEqual(Array.from(generateTextures(g).normal.bytes));
  });
});
