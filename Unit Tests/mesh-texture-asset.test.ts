/**
 * Sprite-backed mesh textures — the machinery that lets an era demo's scene
 * texture be an ordinary, editable cart asset.
 *
 * The chain has four links that must agree: the mesh material carries a
 * `textureSprite` region, that region round-trips through serialization, the
 * region is seeded into the cart's sprite sheet as a named block the web app can
 * read, and the mesh is rebaked from that region deterministically (so an
 * untouched cart is never marked dirty just for having run). Each is pinned here.
 */

import { describe, expect, it } from "vitest";

import {
  PS1_MESH_SIDECAR,
  PS1_ASSETS_SIDECAR,
  N64_MESH_SIDECAR,
  N64_ASSETS_SIDECAR,
  XBOX360_MESH_SIDECAR,
  XBOX360_ASSETS_SIDECAR,
  serializeMeshAsset,
  deserializeMeshAsset,
  bakeIndexedTextureImage,
  TEXTURE_CLUT_BASE,
  type IndexedTexture,
  type MeshAsset,
} from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";

import { SPRITE_BLOCK_SIZES, isSpriteBlockAsset } from "../apps/web/src/lib/cartAssets";
import { decodeVoxelSidecar } from "../apps/web/src/lib/voxelSidecar";
import {
  rebakeMeshSidecar,
  sidecarHasSpriteTexture,
  spriteRegionToRgba,
  type ChannelLike,
  type MaterialLike,
  type NormalLike,
  type SheetLike,
} from "../apps/web/src/lib/meshTextureBake";

/** Deserialize the single mesh out of a sidecar envelope string. */
function firstMesh(sidecar: string): MeshAsset {
  const parsed = JSON.parse(sidecar) as { meshes: { mesh: string }[] };
  return deserializeMeshAsset(parsed.meshes[0]!.mesh);
}

/** A stub sheet backed by a flat index array laid out in page pixel space. */
function stubSheet(indices: Uint8Array, size: number): SheetLike {
  return {
    sheetCols: 16,
    tileSize: 8,
    getPixel: (_page, tile, x, y) => {
      const col = tile % 16;
      const row = Math.floor(tile / 16);
      const gx = col * 8 + x;
      const gy = row * 8 + y;
      return indices[gy * size + gx] ?? 0;
    },
  };
}

/** A normals source over a flat direction array, mirroring {@link stubSheet}. */
function stubNormals(directions: Uint8Array, size: number): NormalLike {
  return {
    getDirection: (_page, tile, x, y) => {
      const gx = (tile % 16) * 8 + x;
      const gy = Math.floor(tile / 16) * 8 + y;
      return directions[gy * size + gx] ?? 0;
    },
  };
}

/** A material source over per-channel level arrays, mirroring {@link stubSheet}. */
function stubMaterial(
  levels: { height?: Uint8Array; specular?: Uint8Array; roughness?: Uint8Array; emissive?: Uint8Array },
  size: number,
): MaterialLike {
  const channel = (arr?: Uint8Array): ChannelLike => ({
    getValue: (_page, tile, x, y) => {
      const gx = (tile % 16) * 8 + x;
      const gy = Math.floor(tile / 16) * 8 + y;
      return arr?.[gy * size + gx] ?? 0;
    },
  });
  return {
    height: channel(levels.height),
    specular: channel(levels.specular),
    roughness: channel(levels.roughness),
    emissive: channel(levels.emissive),
  };
}

/** A 256-entry palette (RGB triplets) with a known CLUT loaded at the base. */
function paletteWithClut(clut: ReadonlyArray<readonly [number, number, number]>): Uint8Array {
  const palette = new Uint8Array(256 * 3);
  clut.forEach(([r, g, b], i) => {
    palette[(TEXTURE_CLUT_BASE + i) * 3] = r;
    palette[(TEXTURE_CLUT_BASE + i) * 3 + 1] = g;
    palette[(TEXTURE_CLUT_BASE + i) * 3 + 2] = b;
  });
  return palette;
}

describe("sprite block sizes", () => {
  it("reach a full page so a scene texture is one asset", () => {
    expect(SPRITE_BLOCK_SIZES).toContain(8); // 64x64
    expect(SPRITE_BLOCK_SIZES).toContain(16); // 128x128, a whole page
    // The small blocks a creator uses for ordinary sprites are still there.
    for (const size of [1, 2, 4]) expect(SPRITE_BLOCK_SIZES).toContain(size);
  });
});

describe("textureSprite serialization", () => {
  it("round-trips through serialize/deserialize", () => {
    const asset: MeshAsset = {
      name: "m",
      primitives: [
        {
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: null,
          uvs: null,
          indices: new Uint32Array([0, 1, 2]),
          material: {
            name: "t",
            baseColorFactor: [1, 1, 1, 1],
            baseColorImage: null,
            textureSprite: { page: 1, x: 0, y: 0, width: 64, height: 64 },
          },
        },
      ],
    };
    const back = deserializeMeshAsset(serializeMeshAsset(asset));
    expect(back.primitives[0]!.material.textureSprite).toEqual({ page: 1, x: 0, y: 0, width: 64, height: 64 });
  });

  it("drops a malformed reference rather than trusting it", () => {
    const raw = serializeMeshAsset({
      name: "m",
      primitives: [
        {
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: null,
          uvs: null,
          indices: new Uint32Array([0, 1, 2]),
          material: { name: "t", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
        },
      ],
    });
    const tampered = raw.replace('"textureSprite":null', '"textureSprite":{"page":0,"x":-5}');
    expect(deserializeMeshAsset(tampered).primitives[0]!.material.textureSprite ?? null).toBeNull();
  });
});

describe("the PS1 plate is a sprite-backed, editable asset", () => {
  it("has its mesh texture bound to a sprite region", () => {
    const mesh = firstMesh(PS1_MESH_SIDECAR);
    const ref = mesh.primitives[0]!.material.textureSprite;
    expect(ref).toEqual({ page: 0, x: 0, y: 0, width: 64, height: 64 });
    // Still ships a baked image, so the scene renders before any rebake.
    expect(mesh.primitives[0]!.material.baseColorImage?.mime).toBe("image/png");
  });

  it("still parses into a scene the runtime can draw", () => {
    const scene = parseMeshScene(PS1_MESH_SIDECAR)!;
    expect(scene).not.toBeNull();
    expect(scene.instances).toHaveLength(1);
  });

  it("seeds a named sprite block the web app decodes", () => {
    // The cross-package agreement: the editor hand-writes the voxel sidecar's v2
    // JSON, and the web app's decoder must accept it as a real editable asset.
    const assets = decodeVoxelSidecar(PS1_ASSETS_SIDECAR).assets;
    expect(assets).toHaveLength(1);
    const block = assets[0]!;
    expect(isSpriteBlockAsset(block)).toBe(true);
    expect(block.name).toBe("PS1 plate");
    if (isSpriteBlockAsset(block)) {
      expect(block.tilesPerSide).toBe(8); // 64px / 8px tiles
      expect(block.page).toBe(0);
      expect(block.bank).toBe(0);
    }
  });
});

describe("every era scene ships an editable, sprite-backed texture", () => {
  const cases = [
    { era: "N64 grass", mesh: N64_MESH_SIDECAR, assets: N64_ASSETS_SIDECAR, size: 64, tiles: 8 },
    { era: "360 grunge", mesh: XBOX360_MESH_SIDECAR, assets: XBOX360_ASSETS_SIDECAR, size: 128, tiles: 16 },
  ] as const;

  for (const { era, mesh, assets, size, tiles } of cases) {
    it(`${era}: the textured primitive is bound to a sprite region`, () => {
      const asset = firstMesh(mesh);
      const textured = asset.primitives.find((p) => p.material.textureSprite);
      expect(textured, "a primitive carries textureSprite").toBeTruthy();
      expect(textured!.material.textureSprite).toEqual({ page: 0, x: 0, y: 0, width: size, height: size });
      expect(textured!.material.baseColorImage?.mime).toBe("image/png");
    });

    it(`${era}: seeds a named sprite block the web app decodes`, () => {
      // The texture asset is named after the era. A scene may ship extra assets
      // alongside it (the 360 also seeds a "Lit badge"), so find it by name
      // rather than assuming it is the only one.
      const list = decodeVoxelSidecar(assets).assets;
      const block = list.find((asset) => isSpriteBlockAsset(asset) && asset.name === era);
      expect(block, `a "${era}" sprite block`).toBeTruthy();
      if (block && isSpriteBlockAsset(block)) expect(block.tilesPerSide).toBe(tiles);
    });

    it(`${era}: still parses into a drawable scene`, () => {
      const scene = parseMeshScene(mesh)!;
      expect(scene).not.toBeNull();
      expect(scene.instances).toHaveLength(1);
    });
  }
});

describe("spriteRegionToRgba", () => {
  it("maps sprite indices through the palette, fully opaque", () => {
    // Palette holds the two colours at indices 0 and 1, and the sheet stores
    // those indices directly — the mapping under test.
    const palette = new Uint8Array(256 * 3);
    palette.set([10, 20, 30], 0);
    palette.set([200, 100, 50], 3);
    const indices = new Uint8Array([0, 1, 1, 0]); // 2x2
    const sheet = stubSheet(indices, 2);
    const rgba = spriteRegionToRgba(sheet, palette, 0, 0, 0, 2, 2);
    expect([...rgba.slice(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...rgba.slice(4, 8)]).toEqual([200, 100, 50, 255]);
  });
});

describe("rebakeMeshSidecar", () => {
  const clut: [number, number, number][] = [
    [8, 8, 8],
    [240, 16, 16],
  ];
  const size = 8;
  const indices = new Uint8Array(size * size).fill(0);
  indices[0] = 1; // one red texel
  const texture: IndexedTexture = { size, indices, clut };

  function sidecarWithTexture(): string {
    const asset: MeshAsset = {
      name: "m",
      primitives: [
        {
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: null,
          uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
          indices: new Uint32Array([0, 1, 2]),
          material: {
            name: "t",
            baseColorFactor: [1, 1, 1, 1],
            baseColorImage: bakeIndexedTextureImage(texture),
            textureSprite: { page: 0, x: 0, y: 0, width: size, height: size },
          },
        },
      ],
    };
    return JSON.stringify({
      version: 1,
      meshes: [{ id: "m", name: "m", mesh: serializeMeshAsset(asset), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
    });
  }

  it("leaves an untouched texture byte-identical, so a fresh cart is not dirtied", async () => {
    const sidecar = sidecarWithTexture();
    const sheet = stubSheet(Uint8Array.from(indices, (i) => TEXTURE_CLUT_BASE + i), size);
    const rebaked = await rebakeMeshSidecar(sidecar, sheet, paletteWithClut(clut));
    expect(rebaked).toBe(sidecar);
  });

  it("regenerates the baked image when a sprite pixel changes", async () => {
    const sidecar = sidecarWithTexture();
    const edited = Uint8Array.from(indices, (i) => TEXTURE_CLUT_BASE + i);
    edited[0] = TEXTURE_CLUT_BASE + 0; // undo the red texel: now all base colour
    const sheet = stubSheet(edited, size);
    const rebaked = await rebakeMeshSidecar(sidecar, sheet, paletteWithClut(clut));
    expect(rebaked).not.toBe(sidecar);
    const before = firstMesh(sidecar).primitives[0]!.material.baseColorImage!.bytes;
    const after = firstMesh(rebaked!).primitives[0]!.material.baseColorImage!.bytes;
    expect(after).not.toEqual(before);
  });

  it("bakes a normal map when the region's Normal layer is painted", async () => {
    const sidecar = sidecarWithTexture();
    const sheet = stubSheet(Uint8Array.from(indices, (i) => TEXTURE_CLUT_BASE + i), size);
    const directions = new Uint8Array(size * size); // flat…
    directions[0] = 3; // …except one painted texel (a non-flat direction)
    const rebaked = await rebakeMeshSidecar(sidecar, sheet, paletteWithClut(clut), stubNormals(directions, size));
    const normalImage = firstMesh(rebaked!).primitives[0]!.material.normalImage;
    expect(normalImage, "a normal map was baked").toBeTruthy();
    expect(normalImage!.mime).toBe("image/png");
  });

  it("adds no normal map for a flat (unpainted) region — no phantom dirty", async () => {
    const sidecar = sidecarWithTexture();
    const sheet = stubSheet(Uint8Array.from(indices, (i) => TEXTURE_CLUT_BASE + i), size);
    const flat = new Uint8Array(size * size); // every pixel direction 0 = flat
    const rebaked = await rebakeMeshSidecar(sidecar, sheet, paletteWithClut(clut), stubNormals(flat, size));
    // The albedo is untouched and no normal map is carried, so the sidecar is
    // byte-identical to the seed — a fresh cart is never dirtied by the normal path.
    expect(rebaked).toBe(sidecar);
    expect(firstMesh(rebaked!).primitives[0]!.material.normalImage ?? null).toBeNull();
  });

  it("bakes a material map when the region's Material layer has specular", async () => {
    const sidecar = sidecarWithTexture();
    const sheet = stubSheet(Uint8Array.from(indices, (i) => TEXTURE_CLUT_BASE + i), size);
    const specular = new Uint8Array(size * size); // no specular…
    specular[0] = 12; // …except one glossy texel
    const rebaked = await rebakeMeshSidecar(sidecar, sheet, paletteWithClut(clut), undefined, stubMaterial({ specular }, size));
    const materialImage = firstMesh(rebaked!).primitives[0]!.material.materialImage;
    expect(materialImage, "a material map was baked").toBeTruthy();
    expect(materialImage!.mime).toBe("image/png");
  });

  it("bakes a material map when the region has emissive but no specular", async () => {
    const sidecar = sidecarWithTexture();
    const sheet = stubSheet(Uint8Array.from(indices, (i) => TEXTURE_CLUT_BASE + i), size);
    const emissive = new Uint8Array(size * size);
    emissive[0] = 15; // a self-illuminated texel
    const rebaked = await rebakeMeshSidecar(sidecar, sheet, paletteWithClut(clut), undefined, stubMaterial({ emissive }, size));
    expect(firstMesh(rebaked!).primitives[0]!.material.materialImage, "an emissive map was baked").toBeTruthy();
  });

  it("adds no material map when only height/roughness are painted — no phantom dirty", async () => {
    // Height and roughness alone change nothing the 3D rasteriser acts on (a
    // highlight needs specular), so the sidecar stays byte-identical to the seed.
    const sidecar = sidecarWithTexture();
    const sheet = stubSheet(Uint8Array.from(indices, (i) => TEXTURE_CLUT_BASE + i), size);
    const height = new Uint8Array(size * size).fill(9);
    const roughness = new Uint8Array(size * size).fill(4);
    const rebaked = await rebakeMeshSidecar(sidecar, sheet, paletteWithClut(clut), undefined, stubMaterial({ height, roughness }, size));
    expect(rebaked).toBe(sidecar);
    expect(firstMesh(rebaked!).primitives[0]!.material.materialImage ?? null).toBeNull();
  });

  it("returns a sidecar with no sprite-backed texture unchanged", async () => {
    const plain = JSON.stringify({
      version: 1,
      meshes: [
        {
          id: "m",
          name: "m",
          mesh: serializeMeshAsset({
            name: "m",
            primitives: [
              {
                positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
                normals: null,
                uvs: null,
                indices: new Uint32Array([0, 1, 2]),
                material: { name: "t", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
              },
            ],
          }),
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    });
    expect(sidecarHasSpriteTexture(plain)).toBe(false);
    expect(await rebakeMeshSidecar(plain, stubSheet(new Uint8Array(64), 8), new Uint8Array(768))).toBe(plain);
  });
});
