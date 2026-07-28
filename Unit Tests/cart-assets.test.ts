/**
 * The cart's named asset list, and the sidecar's migration to carrying it.
 *
 * Two things are under test and the second is the one that matters most:
 *
 * 1. The asset model itself — the list operations, the defensive reader, and the
 *    asymmetry between a sprite block (a reference into the sheet) and a voxel
 *    grid (a payload of its own).
 * 2. The compatibility ladder. Carts saved before assets existed are upgraded
 *    lazily, on load, and a cart that has not used a new feature must re-encode
 *    to the *exact bytes* it was stored with. Nothing here is stubbed: real
 *    `VoxelGrid` payloads go in, and the assertions are on the strings that would
 *    actually land in the database.
 */

import { describe, expect, it } from "vitest";

import { BANK_COUNT, serializeVoxelGrid, VoxelGrid } from "@cartbox/editor";
import {
  createAssetId,
  defaultAssetName,
  duplicateAsset,
  findAsset,
  isSpriteBlockAsset,
  isVoxelGridAsset,
  moveAssetBefore,
  readCartAssets,
  removeAsset,
  renameAsset,
  spriteBlockAssets,
  upsertAsset,
  voxelGridAssets,
  MAX_ASSET_NAME_CHARS,
  MAX_CART_ASSETS,
  MAX_TILE_INDEX,
  PRIMARY_VOXEL_ASSET_ID,
  PRIMARY_VOXEL_ASSET_NAME,
  SPRITE_BLOCK_KIND,
  VOXEL_GRID_KIND,
  type CartAsset,
  type SpriteBlockAsset,
  type VoxelGridAsset,
} from "../apps/web/src/lib/cartAssets";
import {
  decodeVoxelSidecar,
  encodeVoxelSidecar,
  parseVoxelPayload,
  primaryVoxelAsset,
  withPrimaryVoxel,
  EMPTY_VOXEL_SIDECAR,
  VOXEL_SIDECAR_KIND,
  VOXEL_SIDECAR_VERSION,
  VOXEL_SIDECAR_V1,
} from "../apps/web/src/lib/voxelSidecar";
import { uniformSpriteMaterial } from "../apps/web/src/lib/spriteTiles";

/** A real serialized sculpt with two filled cells. */
function serializedGrid(seed = 200): string {
  const grid = new VoxelGrid(4, 4, 4);
  grid.set(1, 1, 1, seed, 100, 50);
  grid.set(1, 2, 1, 255, 255, 255, 0, 13);
  return serializeVoxelGrid(grid);
}

const sculpt = (id: string, name: string, grid = serializedGrid()): VoxelGridAsset => ({
  kind: VOXEL_GRID_KIND,
  id,
  name,
  grid,
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

describe("asset ids", () => {
  it("mints distinct ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createAssetId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });
});

describe("list operations", () => {
  const assets: CartAsset[] = [sculpt("a", "Model 1"), block("b", "Hero"), sculpt("c", "Model 2")];

  it("finds by id, and reports a miss rather than guessing", () => {
    expect(findAsset(assets, "b")?.name).toBe("Hero");
    expect(findAsset(assets, "nope")).toBeNull();
    expect(findAsset(assets, null)).toBeNull();
  });

  it("separates the two kinds", () => {
    expect(voxelGridAssets(assets).map((a) => a.id)).toEqual(["a", "c"]);
    expect(spriteBlockAssets(assets).map((a) => a.id)).toEqual(["b"]);
    expect(assets.filter(isVoxelGridAsset)).toHaveLength(2);
    expect(assets.filter(isSpriteBlockAsset)).toHaveLength(1);
  });

  it("scopes sprite blocks to a bank, since the sheet they point into is per-bank", () => {
    const multiBank = [block("b0", "In bank 0", { bank: 0 }), block("b3", "In bank 3", { bank: 3 })];
    expect(spriteBlockAssets(multiBank, 0).map((a) => a.id)).toEqual(["b0"]);
    expect(spriteBlockAssets(multiBank, 3).map((a) => a.id)).toEqual(["b3"]);
    expect(spriteBlockAssets(multiBank, 1)).toEqual([]);
    // No bank asked for means every bank.
    expect(spriteBlockAssets(multiBank)).toHaveLength(2);
  });

  it("replaces in place rather than reordering", () => {
    const next = upsertAsset(assets, sculpt("c", "Renamed", serializedGrid(9)));
    expect(next.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(next[2]!.name).toBe("Renamed");
    expect(next).toHaveLength(3);
  });

  it("appends an asset it has never seen", () => {
    const next = upsertAsset(assets, sculpt("d", "Model 3"));
    expect(next.map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("does not mutate the list it was given", () => {
    const original = [...assets];
    upsertAsset(assets, sculpt("d", "Model 3"));
    removeAsset(assets, "a");
    renameAsset(assets, "a", "Changed");
    expect(assets).toEqual(original);
  });

  it("removes by id", () => {
    expect(removeAsset(assets, "b").map((a) => a.id)).toEqual(["a", "c"]);
    expect(removeAsset(assets, "absent")).toHaveLength(3);
  });

  it("renames, refusing a blank name rather than storing one", () => {
    expect(renameAsset(assets, "a", "  Trimmed  ").find((a) => a.id === "a")!.name).toBe("Trimmed");
    expect(renameAsset(assets, "a", "   ").find((a) => a.id === "a")!.name).toBe("Model 1");
    expect(renameAsset(assets, "a", "").find((a) => a.id === "a")!.name).toBe("Model 1");
  });

  it("caps a rename at the stored name length", () => {
    const long = "x".repeat(MAX_ASSET_NAME_CHARS + 40);
    expect(renameAsset(assets, "a", long).find((a) => a.id === "a")!.name).toHaveLength(MAX_ASSET_NAME_CHARS);
  });
});

describe("moveAssetBefore", () => {
  const assets: CartAsset[] = [sculpt("a", "A"), block("b", "B"), sculpt("c", "C"), block("d", "D")];
  const order = (list: readonly CartAsset[]) => list.map((entry) => entry.id);

  it("moves an asset in front of a later one", () => {
    expect(order(moveAssetBefore(assets, "a", "c"))).toEqual(["b", "a", "c", "d"]);
  });

  it("moves an asset in front of an earlier one", () => {
    expect(order(moveAssetBefore(assets, "d", "b"))).toEqual(["a", "d", "b", "c"]);
  });

  it("moves to the end when there is nothing to land before", () => {
    expect(order(moveAssetBefore(assets, "a", null))).toEqual(["b", "c", "d", "a"]);
  });

  it("reorders across a filtered view, where positions would be meaningless", () => {
    // The browser lists one medium at a time, so a drag names two real ids and
    // the assets between them — of the other kind — must not move.
    const moved = moveAssetBefore(assets, "c", "a");
    expect(order(moved)).toEqual(["c", "a", "b", "d"]);
    // The sculpts are now in the dragged order...
    expect(order(moved.filter(isVoxelGridAsset))).toEqual(["c", "a"]);
    // ...and the sprite blocks kept theirs.
    expect(order(moved.filter(isSpriteBlockAsset))).toEqual(["b", "d"]);
  });

  it("leaves the order alone for a no-op or an unknown id", () => {
    expect(order(moveAssetBefore(assets, "b", "b"))).toEqual(["a", "b", "c", "d"]);
    expect(order(moveAssetBefore(assets, "gone", "a"))).toEqual(["a", "b", "c", "d"]);
    expect(order(moveAssetBefore(assets, "a", "gone"))).toEqual(["a", "b", "c", "d"]);
  });

  it("never drops or duplicates an asset", () => {
    for (const id of ["a", "b", "c", "d"]) {
      for (const before of ["a", "b", "c", "d", null]) {
        const moved = moveAssetBefore(assets, id, before);
        expect(moved, `${id} → ${before}`).toHaveLength(assets.length);
        expect(new Set(order(moved)).size).toBe(assets.length);
      }
    }
  });

  it("does not mutate the list it was given", () => {
    const original = [...assets];
    moveAssetBefore(assets, "a", "d");
    expect(assets).toEqual(original);
  });
});

describe("duplicateAsset", () => {
  const assets: CartAsset[] = [sculpt("a", "Hero"), block("b", "Hero sprite")];

  it("inserts the copy directly after its source", () => {
    const next = duplicateAsset(assets, "a");
    expect(next.map((entry) => entry.name)).toEqual(["Hero", "Hero copy", "Hero sprite"]);
  });

  it("gives the copy a fresh id", () => {
    const next = duplicateAsset(assets, "a");
    expect(next[1]!.id).not.toBe("a");
    expect(new Set(next.map((entry) => entry.id)).size).toBe(next.length);
  });

  it("copies a sculpt's grid, so the two can diverge", () => {
    const copy = duplicateAsset(assets, "a")[1] as VoxelGridAsset;
    expect(copy.grid).toBe((assets[0] as VoxelGridAsset).grid);
    expect(copy.kind).toBe(VOXEL_GRID_KIND);
  });

  it("copies a sprite block's coordinates — both then name the same pixels", () => {
    const copy = duplicateAsset(assets, "b")[2] as SpriteBlockAsset;
    const source = assets[1] as SpriteBlockAsset;
    expect({ bank: copy.bank, page: copy.page, tile: copy.tile, tilesPerSide: copy.tilesPerSide }).toEqual({
      bank: source.bank,
      page: source.page,
      tile: source.tile,
      tilesPerSide: source.tilesPerSide,
    });
  });

  it("numbers repeated copies rather than colliding", () => {
    let list: readonly CartAsset[] = assets;
    for (let round = 0; round < 3; round += 1) list = duplicateAsset(list, "a");
    const names = list.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("Hero copy");
    expect(names).toContain("Hero copy 2");
  });

  it("leaves the list alone for an unknown id", () => {
    expect(duplicateAsset(assets, "gone")).toEqual(assets);
  });
});

describe("defaultAssetName", () => {
  it("names by kind, counting up", () => {
    expect(defaultAssetName(VOXEL_GRID_KIND, [])).toBe("Model 1");
    expect(defaultAssetName(SPRITE_BLOCK_KIND, [])).toBe("Sprite 1");
  });

  it("skips names already taken", () => {
    const assets = [sculpt("a", "Model 1"), sculpt("b", "Model 2")];
    expect(defaultAssetName(VOXEL_GRID_KIND, assets)).toBe("Model 3");
    // Counts by name, not by kind — the sprite stem is independent.
    expect(defaultAssetName(SPRITE_BLOCK_KIND, assets)).toBe("Sprite 1");
  });

  it("fills a gap left by a deletion", () => {
    const assets = [sculpt("a", "Model 1"), sculpt("c", "Model 3")];
    expect(defaultAssetName(VOXEL_GRID_KIND, assets)).toBe("Model 2");
  });
});

describe("readCartAssets", () => {
  it("reads a well-formed list of both kinds", () => {
    const assets = readCartAssets([sculpt("a", "Model 1"), block("b", "Hero")]);
    expect(assets).toHaveLength(2);
    expect(assets[0]!.kind).toBe(VOXEL_GRID_KIND);
    expect(assets[1]!.kind).toBe(SPRITE_BLOCK_KIND);
  });

  it("returns nothing for a value that is not a list", () => {
    expect(readCartAssets(undefined)).toEqual([]);
    expect(readCartAssets(null)).toEqual([]);
    expect(readCartAssets("assets")).toEqual([]);
    expect(readCartAssets({ 0: sculpt("a", "Model 1") })).toEqual([]);
  });

  it("drops entries with no usable identity", () => {
    const assets = readCartAssets([
      { ...sculpt("a", "Model 1"), id: "" },
      { ...sculpt("b", "Model 2"), id: 7 },
      { ...sculpt("c", "Model 3"), name: "   " },
      { ...sculpt("d", "Model 4"), name: undefined },
      sculpt("e", "Kept"),
    ]);
    expect(assets.map((a) => a.id)).toEqual(["e"]);
  });

  it("drops an unknown kind rather than guessing at it", () => {
    const assets = readCartAssets([{ kind: "audioClip", id: "x", name: "Beep" }, sculpt("a", "Model 1")]);
    expect(assets.map((a) => a.id)).toEqual(["a"]);
  });

  it("drops a sculpt with no grid — the payload is the whole point of it", () => {
    const assets = readCartAssets([
      { kind: VOXEL_GRID_KIND, id: "a", name: "Model 1" },
      { kind: VOXEL_GRID_KIND, id: "b", name: "Model 2", grid: "" },
      sculpt("c", "Model 3"),
    ]);
    expect(assets.map((a) => a.id)).toEqual(["c"]);
  });

  it("keeps a sculpt's sprite skins, dropping only the malformed ones", () => {
    const good = uniformSpriteMaterial("Brick", { page: 0, tile: 4 });
    const assets = readCartAssets([
      { ...sculpt("a", "Model 1"), spriteMaterials: [good, { name: "no faces" }, "nonsense"] },
    ]);
    expect((assets[0] as VoxelGridAsset).spriteMaterials).toEqual([good]);
  });

  it("rejects sprite blocks addressing somewhere the sheet cannot be", () => {
    const assets = readCartAssets([
      block("ok", "Fine"),
      block("bank-high", "Past the last bank", { bank: BANK_COUNT }),
      block("bank-neg", "Negative bank", { bank: -1 }),
      block("bank-frac", "Fractional bank", { bank: 1.5 }),
      block("page", "Third page", { page: 2 as SpriteBlockAsset["page"] }),
      block("tile-neg", "Negative tile", { tile: -1 }),
      block("tile-huge", "Absurd tile", { tile: MAX_TILE_INDEX + 1 }),
      block("size", "Not a block size", { tilesPerSide: 3 }),
    ]);
    expect(assets.map((a) => a.id)).toEqual(["ok"]);
  });

  it("accepts every block size the sprite editor authors", () => {
    const assets = readCartAssets([
      block("s1", "8", { tilesPerSide: 1 }),
      block("s2", "16", { tilesPerSide: 2 }),
      block("s4", "32", { tilesPerSide: 4 }),
    ]);
    expect(assets).toHaveLength(3);
  });

  it("keeps the first of a duplicated id, so a later entry cannot shadow it", () => {
    const assets = readCartAssets([sculpt("dup", "First"), sculpt("dup", "Second")]);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.name).toBe("First");
  });

  it("stops at the asset ceiling", () => {
    const many = Array.from({ length: MAX_CART_ASSETS + 25 }, (_unused, index) =>
      sculpt(`id-${index}`, `Model ${index}`),
    );
    expect(readCartAssets(many)).toHaveLength(MAX_CART_ASSETS);
  });
});

describe("the primary sculpt", () => {
  it("is the first voxel asset, ignoring sprite blocks", () => {
    const sidecar = { assets: [block("b", "Hero"), sculpt("a", "Model 1")], mapLayer: null };
    expect(primaryVoxelAsset(sidecar)?.id).toBe("a");
  });

  it("is null on a cart with no sculpt", () => {
    expect(primaryVoxelAsset(EMPTY_VOXEL_SIDECAR)).toBeNull();
    expect(primaryVoxelAsset({ assets: [block("b", "Hero")], mapLayer: null })).toBeNull();
  });

  it("is created with the migration identity on a cart that had none", () => {
    const next = withPrimaryVoxel(EMPTY_VOXEL_SIDECAR, { grid: serializedGrid(), spriteMaterials: [] });
    const created = primaryVoxelAsset(next)!;
    expect(created.id).toBe(PRIMARY_VOXEL_ASSET_ID);
    expect(created.name).toBe(PRIMARY_VOXEL_ASSET_NAME);
  });

  it("keeps its id and name when the sculpt is replaced", () => {
    const start = { assets: [sculpt("custom-id", "My hero")], mapLayer: null };
    const next = withPrimaryVoxel(start, { grid: serializedGrid(7), spriteMaterials: [] });
    const updated = primaryVoxelAsset(next)!;
    expect(updated.id).toBe("custom-id");
    expect(updated.name).toBe("My hero");
    expect(updated.grid).toBe(serializedGrid(7));
  });

  it("leaves every other asset, and the map layer, untouched", () => {
    const start = {
      assets: [block("b", "Hero"), sculpt("a", "Model 1"), block("c", "Enemy")],
      mapLayer: "columns-payload",
    };
    const next = withPrimaryVoxel(start, { grid: serializedGrid(7), spriteMaterials: [] });
    expect(next.assets.map((a) => a.id)).toEqual(["b", "a", "c"]);
    expect(next.mapLayer).toBe("columns-payload");
  });

  it("removes the sculpt when it is cleared, rather than storing a blank one", () => {
    const start = { assets: [block("b", "Hero"), sculpt("a", "Model 1")], mapLayer: null };
    const next = withPrimaryVoxel(start, { grid: null, spriteMaterials: [] });
    expect(primaryVoxelAsset(next)).toBeNull();
    expect(next.assets.map((a) => a.id)).toEqual(["b"]);
  });
});

/**
 * The compatibility ladder. These are the tests that let this ship without a
 * data migration, so they assert on exact stored bytes rather than on shape.
 */
describe("payload compatibility", () => {
  it("migrates a bare grid to one named asset", () => {
    const grid = serializedGrid();
    const decoded = decodeVoxelSidecar(grid);
    expect(decoded.assets).toHaveLength(1);
    const migrated = primaryVoxelAsset(decoded)!;
    expect(migrated.id).toBe(PRIMARY_VOXEL_ASSET_ID);
    expect(migrated.name).toBe(PRIMARY_VOXEL_ASSET_NAME);
    expect(migrated.grid).toBe(grid);
  });

  it("migrates a v1 envelope, keeping its sprite skins on the sculpt", () => {
    const grid = serializedGrid();
    const skin = uniformSpriteMaterial("Brick", { page: 0, tile: 4 });
    const stored = JSON.stringify({
      kind: VOXEL_SIDECAR_KIND,
      version: VOXEL_SIDECAR_V1,
      grid,
      spriteMaterials: [skin],
    });
    const migrated = primaryVoxelAsset(decodeVoxelSidecar(stored))!;
    expect(migrated.grid).toBe(grid);
    expect(migrated.spriteMaterials).toEqual([skin]);
  });

  it("re-encodes an untouched bare-grid cart to the very same bytes", () => {
    const stored = serializedGrid();
    expect(encodeVoxelSidecar(decodeVoxelSidecar(stored))).toBe(stored);
  });

  it("re-encodes an untouched v1 cart to the very same bytes", () => {
    const stored = JSON.stringify({
      kind: VOXEL_SIDECAR_KIND,
      version: VOXEL_SIDECAR_V1,
      grid: serializedGrid(),
      spriteMaterials: [uniformSpriteMaterial("Brick", { page: 0, tile: 4 })],
      mapLayer: "columns-payload",
    });
    expect(encodeVoxelSidecar(decodeVoxelSidecar(stored))).toBe(stored);
  });

  it("still writes v1 when the only change is to the sculpt itself", () => {
    // Editing the model of a pre-assets cart must not force it forward a version.
    const stored = serializedGrid();
    const edited = withPrimaryVoxel(decodeVoxelSidecar(stored), {
      grid: serializedGrid(9),
      spriteMaterials: [],
    });
    expect(encodeVoxelSidecar(edited)).toBe(serializedGrid(9));
  });

  it("upgrades to v2 only once there is something a v1 reader could not hold", () => {
    const base = decodeVoxelSidecar(serializedGrid());

    // A named sprite block cannot be expressed in v1.
    const withBlock = { ...base, assets: [...base.assets, block("b", "Hero")] };
    const blockPayload = JSON.parse(encodeVoxelSidecar(withBlock));
    expect(blockPayload.version).toBe(VOXEL_SIDECAR_VERSION);
    expect(blockPayload.assets).toHaveLength(2);

    // Nor can a second sculpt.
    const twoSculpts = { ...base, assets: [...base.assets, sculpt("second", "Model 2")] };
    expect(JSON.parse(encodeVoxelSidecar(twoSculpts)).version).toBe(VOXEL_SIDECAR_VERSION);

    // Nor a renamed one — the name is new information.
    const renamed = { ...base, assets: renameAsset(base.assets, PRIMARY_VOXEL_ASSET_ID, "Hero ship") };
    expect(JSON.parse(encodeVoxelSidecar(renamed)).version).toBe(VOXEL_SIDECAR_VERSION);
  });

  it("round-trips a v2 cart with both kinds of asset and map columns", () => {
    const original = {
      assets: [sculpt("a", "Hero ship"), block("b", "Hero sprite"), sculpt("c", "Enemy")],
      mapLayer: "columns-payload",
    };
    const decoded = decodeVoxelSidecar(encodeVoxelSidecar(original));
    expect(decoded.assets).toEqual(original.assets);
    expect(decoded.mapLayer).toBe("columns-payload");
  });

  it("re-encodes a v2 cart to the very same bytes", () => {
    const stored = encodeVoxelSidecar({
      assets: [sculpt("a", "Hero ship"), block("b", "Hero sprite")],
      mapLayer: "columns-payload",
    });
    expect(encodeVoxelSidecar(decodeVoxelSidecar(stored))).toBe(stored);
  });

  it("reads a payload from a newer client for its assets, not as an empty v1", () => {
    // A future version bump must not make today's reader see "no sculpt".
    const stored = JSON.stringify({
      kind: VOXEL_SIDECAR_KIND,
      version: VOXEL_SIDECAR_VERSION + 5,
      assets: [sculpt("a", "Model 1")],
      somethingNew: { we: "do not understand" },
    });
    expect(primaryVoxelAsset(decodeVoxelSidecar(stored))?.id).toBe("a");
  });

  it("degrades a v2 envelope with a corrupt asset list rather than throwing", () => {
    const stored = JSON.stringify({ kind: VOXEL_SIDECAR_KIND, version: 2, assets: "not a list" });
    expect(decodeVoxelSidecar(stored)).toEqual(EMPTY_VOXEL_SIDECAR);
  });
});

describe("the stored-payload guard, with assets", () => {
  it("accepts a v2 payload carrying several sculpts", () => {
    const payload = encodeVoxelSidecar({
      assets: [sculpt("a", "Hero"), sculpt("b", "Enemy")],
      mapLayer: null,
    });
    expect(parseVoxelPayload(payload)).toBe(payload);
  });

  it("rejects the whole payload when any one sculpt is impossible", () => {
    // Rejecting beats silently dropping: this is a write path, and storing less
    // than was sent loses the author's work without telling them.
    const bogus: VoxelGridAsset = {
      kind: VOXEL_GRID_KIND,
      id: "bad",
      name: "Impossible",
      grid: JSON.stringify({ version: 3, sizeX: 99999, sizeY: 1, sizeZ: 1, count: 0 }),
      spriteMaterials: [],
    };
    const payload = encodeVoxelSidecar({ assets: [sculpt("a", "Hero"), bogus], mapLayer: null });
    expect(parseVoxelPayload(payload)).toBeNull();
  });

  it("accepts a cart whose only content is named sprite blocks", () => {
    // Sprite blocks are references into the .tic sheet, so a cart can name them
    // with no sculpt at all — that must still be worth storing.
    const payload = encodeVoxelSidecar({ assets: [block("b", "Hero")], mapLayer: null });
    expect(parseVoxelPayload(payload)).toBe(payload);
  });

  it("still rejects a payload carrying nothing", () => {
    expect(parseVoxelPayload(encodeVoxelSidecar(EMPTY_VOXEL_SIDECAR))).toBeNull();
  });
});
