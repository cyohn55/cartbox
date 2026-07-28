/**
 * The Assets tab's selection logic: which assets a medium lists, and which one
 * is being edited.
 *
 * These are the parts of the merged tab that are easy to get subtly wrong — a
 * sculpt's lattice lives inside its serialized grid rather than in a field of its
 * own, a sprite asset is matched by coordinates rather than remembered, and a
 * selection left over from another medium has to resolve to something usable.
 * Real serialized grids go in, built with the editor's own `VoxelGrid`, so the
 * lattice is read the way the app reads it.
 */

import { describe, expect, it } from "vitest";

import { serializeVoxelGrid, VoxelGrid } from "@cartbox/editor";
import {
  assetsForMedium,
  blockIdAt,
  mediumForSculpt,
  resolveSculptId,
  sculptsForMedium,
  selectionForBlock,
  shapeForMedium,
} from "../apps/web/src/app/edit/[cartId]/assetSelection";
import {
  SPRITE_BLOCK_KIND,
  VOXEL_GRID_KIND,
  type CartAsset,
  type SpriteBlockAsset,
  type VoxelGridAsset,
} from "../apps/web/src/lib/cartAssets";
import type { SpriteSelection } from "../apps/web/src/app/edit/[cartId]/SpriteEditor";

/** A real sculpt payload on a given lattice. */
function gridPayload(shape: "cube" | "hexel"): string {
  const grid = new VoxelGrid(8, 8, 8);
  // (2,0,2) is a valid site on both lattices, so the two payloads differ only in
  // the shape they record — which is exactly what these read back.
  grid.set(2, 0, 2, 180, 180, 190);
  return serializeVoxelGrid(grid, shape);
}

const sculpt = (id: string, name: string, shape: "cube" | "hexel"): VoxelGridAsset => ({
  kind: VOXEL_GRID_KIND,
  id,
  name,
  grid: gridPayload(shape),
  spriteMaterials: [],
});

const block = (id: string, name: string, overrides: Partial<SpriteBlockAsset> = {}): SpriteBlockAsset => ({
  kind: SPRITE_BLOCK_KIND,
  id,
  name,
  bank: 0,
  page: 0,
  tile: 16,
  tilesPerSide: 2,
  ...overrides,
});

const at = (page: 0 | 1, tile: number, tilesPerSide: number): SpriteSelection => ({ page, tile, tilesPerSide });

const ASSETS: CartAsset[] = [
  sculpt("cube-1", "Hero ship", "cube"),
  sculpt("hex-1", "Terrain", "hexel"),
  sculpt("cube-2", "Enemy", "cube"),
  block("b0", "Hero sprite", { bank: 0, page: 0, tile: 16, tilesPerSide: 2 }),
  block("b1", "In another bank", { bank: 2, page: 0, tile: 16, tilesPerSide: 2 }),
];

describe("shapeForMedium", () => {
  it("maps the two 3D mediums onto their lattices", () => {
    expect(shapeForMedium("voxels")).toBe("cube");
    expect(shapeForMedium("hexels")).toBe("hexel");
  });

  it("has no lattice for pixels", () => {
    expect(shapeForMedium("pixels")).toBeNull();
  });
});

describe("mediumForSculpt", () => {
  it("reads the lattice back out of the saved grid", () => {
    expect(mediumForSculpt(sculpt("a", "Cube", "cube"))).toBe("voxels");
    expect(mediumForSculpt(sculpt("b", "Hex", "hexel"))).toBe("hexels");
  });

  it("treats an unreadable grid as the cube default rather than throwing", () => {
    const corrupt: VoxelGridAsset = { ...sculpt("c", "Broken", "cube"), grid: "not a grid" };
    expect(mediumForSculpt(corrupt)).toBe("voxels");
  });
});

describe("sculptsForMedium", () => {
  it("separates the lattices", () => {
    expect(sculptsForMedium(ASSETS, "voxels").map((a) => a.id)).toEqual(["cube-1", "cube-2"]);
    expect(sculptsForMedium(ASSETS, "hexels").map((a) => a.id)).toEqual(["hex-1"]);
  });

  it("finds no sculpts in the pixel medium", () => {
    expect(sculptsForMedium(ASSETS, "pixels")).toEqual([]);
  });

  it("agrees with the medium each sculpt reports for itself", () => {
    for (const medium of ["voxels", "hexels"] as const) {
      for (const found of sculptsForMedium(ASSETS, medium)) {
        expect(mediumForSculpt(found), found.id).toBe(medium);
      }
    }
  });
});

describe("assetsForMedium", () => {
  it("lists this bank's sprite blocks for pixels, and no sculpts", () => {
    expect(assetsForMedium(ASSETS, "pixels", 0).map((a) => a.id)).toEqual(["b0"]);
    expect(assetsForMedium(ASSETS, "pixels", 2).map((a) => a.id)).toEqual(["b1"]);
    expect(assetsForMedium(ASSETS, "pixels", 1)).toEqual([]);
  });

  it("lists sculpts for the 3D mediums, and ignores the bank", () => {
    expect(assetsForMedium(ASSETS, "voxels", 0).map((a) => a.id)).toEqual(["cube-1", "cube-2"]);
    // Sculpts are cart-wide, so a different bank shows the same list.
    expect(assetsForMedium(ASSETS, "voxels", 3).map((a) => a.id)).toEqual(["cube-1", "cube-2"]);
  });

  it("never lists an asset under a medium that cannot edit it", () => {
    for (const medium of ["pixels", "voxels", "hexels"] as const) {
      for (const listed of assetsForMedium(ASSETS, medium, 0)) {
        const expected = listed.kind === SPRITE_BLOCK_KIND ? "pixels" : mediumForSculpt(listed);
        expect(expected, listed.id).toBe(medium);
      }
    }
  });
});

describe("blockIdAt", () => {
  const blocks = [
    block("b8", "Small", { page: 0, tile: 4, tilesPerSide: 1 }),
    block("b16", "Medium", { page: 0, tile: 16, tilesPerSide: 2 }),
    block("bp1", "On the sprite page", { page: 1, tile: 16, tilesPerSide: 2 }),
  ];

  it("matches the block the editor is sitting on", () => {
    expect(blockIdAt(blocks, at(0, 16, 2))).toBe("b16");
    expect(blockIdAt(blocks, at(0, 4, 1))).toBe("b8");
  });

  it("distinguishes the two pages at the same tile", () => {
    expect(blockIdAt(blocks, at(1, 16, 2))).toBe("bp1");
  });

  it("does not match a block of a different size at the same tile", () => {
    // Same corner, different extent — a 32×32 at tile 16 is not the 16×16 there.
    expect(blockIdAt(blocks, at(0, 16, 4))).toBeNull();
  });

  it("deselects once the editor moves off a named block", () => {
    expect(blockIdAt(blocks, at(0, 17, 2))).toBeNull();
    expect(blockIdAt(blocks, at(0, 99, 1))).toBeNull();
  });

  it("finds nothing in an empty list", () => {
    expect(blockIdAt([], at(0, 16, 2))).toBeNull();
  });

  it("round-trips through the selection a block stands for", () => {
    for (const entry of blocks) {
      expect(blockIdAt(blocks, selectionForBlock(entry))).toBe(entry.id);
    }
  });
});

describe("resolveSculptId", () => {
  const cubes = sculptsForMedium(ASSETS, "voxels");

  it("keeps a chosen sculpt that is still on this lattice", () => {
    expect(resolveSculptId(cubes, "cube-2")).toBe("cube-2");
  });

  it("falls back to the first when the chosen one belongs to another medium", () => {
    // What happens on a medium switch: the hexel id cannot survive into cubes.
    expect(resolveSculptId(cubes, "hex-1")).toBe("cube-1");
  });

  it("falls back to the first when the chosen one was deleted", () => {
    expect(resolveSculptId(cubes, "gone")).toBe("cube-1");
  });

  it("resolves to nothing when the medium has no sculpts", () => {
    // Not a failure: it means the sculptor edits the cart's main sculpt, which is
    // what a cart that never named an asset has.
    expect(resolveSculptId([], "cube-1")).toBeNull();
    expect(resolveSculptId([], null)).toBeNull();
  });

  it("always resolves to something the medium actually lists", () => {
    for (const chosen of [null, "cube-1", "cube-2", "hex-1", "nonexistent"]) {
      const resolved = resolveSculptId(cubes, chosen);
      if (resolved !== null) expect(cubes.some((s) => s.id === resolved), String(chosen)).toBe(true);
    }
  });
});
