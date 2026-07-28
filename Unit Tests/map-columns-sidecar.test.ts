/**
 * The Map tab's columns share the cart's 3D payload with the Voxel tab's sculpt.
 * That is only safe if the envelope round-trips both halves and neither tab can
 * drop the other's work when it saves — which is what these cover, driving the
 * real codec with real serialized layers and grids.
 *
 * They also pin the compatibility promise the envelope makes: a cart with
 * nothing but a sculpt still saves the bare grid payload it always did.
 */

import { describe, expect, it } from "vitest";

import {
  MapVoxelLayer,
  serializeMapVoxelLayer,
  deserializeMapVoxelLayer,
  serializeVoxelGrid,
  VoxelGrid,
  COLUMN_MATERIAL_NONE,
} from "@cartbox/editor";
import {
  decodeVoxelSidecar,
  encodeVoxelSidecar,
  mergeVoxelSidecar,
  parseVoxelPayload,
  primaryVoxelAsset,
  withPrimaryVoxel,
  EMPTY_VOXEL_SIDECAR,
  VOXEL_SIDECAR_KIND,
  type VoxelSidecar,
} from "../apps/web/src/lib/voxelSidecar";
import { uniformSpriteMaterial, type SpriteMaterial } from "../apps/web/src/lib/spriteTiles";

/** A one-sculpt cart with map columns, the way the editor builds one. */
const sidecarOf = (
  grid: string | null,
  spriteMaterials: readonly SpriteMaterial[] = [],
  mapLayer: string | null = null,
): VoxelSidecar => ({ ...withPrimaryVoxel(EMPTY_VOXEL_SIDECAR, { grid, spriteMaterials }), mapLayer });

const gridOf = (sidecar: VoxelSidecar) => primaryVoxelAsset(sidecar)?.grid ?? null;
const materialsOf = (sidecar: VoxelSidecar) => primaryVoxelAsset(sidecar)?.spriteMaterials ?? [];

/** A real serialized sculpt. */
function serializedGrid(): string {
  const grid = new VoxelGrid(4, 4, 4);
  grid.set(1, 1, 1, 200, 100, 50);
  grid.set(2, 1, 1, 20, 180, 90);
  return serializeVoxelGrid(grid);
}

/** A real serialized column layer with a handful of raised cells. */
function serializedColumns(shape: "cube" | "hexel" = "cube"): string {
  const layer = new MapVoxelLayer(30, 17, shape);
  layer.setColumn(2, 3, 5, 7);
  layer.setColumn(10, 9, 2, 1);
  layer.setColumn(29, 16, 12, 3);
  return serializeMapVoxelLayer(layer);
}

/** The same layer, skinned — the payload a textured landscape actually saves. */
function serializedSkinnedColumns(): string {
  const layer = new MapVoxelLayer(30, 17);
  layer.setColumn(2, 3, 5, 7, 0); // grass
  layer.setColumn(10, 9, 2, 1, 3); // sand
  layer.setColumn(29, 16, 12, 3); // deliberately flat
  return serializeMapVoxelLayer(layer);
}

describe("the cart's 3D payload carries the map's columns", () => {
  it("round-trips columns alongside a sculpt and its sprite skins", () => {
    const payload = encodeVoxelSidecar(sidecarOf(serializedGrid(), [uniformSpriteMaterial("Brick", { page: 0, tile: 4 })], serializedColumns()));
    const decoded = decodeVoxelSidecar(payload);

    expect(gridOf(decoded)).toBe(serializedGrid());
    expect(materialsOf(decoded)).toHaveLength(1);
    expect(decoded.mapLayer).toBe(serializedColumns());

    // The layer that comes back out must rebuild to the same columns.
    const layer = deserializeMapVoxelLayer(decoded.mapLayer!);
    expect(layer.columnAt(2, 3)).toEqual({ height: 5, colorIndex: 7, material: COLUMN_MATERIAL_NONE });
    expect(layer.columnAt(29, 16)).toEqual({ height: 12, colorIndex: 3, material: COLUMN_MATERIAL_NONE });
    expect(layer.columnCount).toBe(3);
  });

  it("carries each column's material through the cart payload", () => {
    const payload = encodeVoxelSidecar(sidecarOf(serializedGrid(), [], serializedSkinnedColumns()));
    const layer = deserializeMapVoxelLayer(decodeVoxelSidecar(payload).mapLayer!);

    expect(layer.hasMaterials()).toBe(true);
    expect(layer.columnAt(2, 3)).toEqual({ height: 5, colorIndex: 7, material: 0 });
    expect(layer.columnAt(10, 9)).toEqual({ height: 2, colorIndex: 1, material: 3 });
    // A flat column in a skinned layer stays flat.
    expect(layer.materialAt(29, 16)).toBe(COLUMN_MATERIAL_NONE);
  });

  it("keeps a hexel layer's cell shape across the round trip", () => {
    const payload = encodeVoxelSidecar(sidecarOf(null, [], serializedColumns("hexel")));
    const layer = deserializeMapVoxelLayer(decodeVoxelSidecar(payload).mapLayer!);
    expect(layer.shape).toBe("hexel");
  });

  it("still saves the bare grid payload when there are no columns or skins", () => {
    const grid = serializedGrid();
    expect(encodeVoxelSidecar(sidecarOf(grid))).toBe(grid);
  });

  it("wraps the payload as soon as columns exist, even with no sculpt", () => {
    const payload = encodeVoxelSidecar(sidecarOf(null, [], serializedColumns()));
    expect(JSON.parse(payload).kind).toBe(VOXEL_SIDECAR_KIND);
    expect(gridOf(decodeVoxelSidecar(payload))).toBeNull();
    expect(decodeVoxelSidecar(payload).mapLayer).toBe(serializedColumns());
  });

  it("reads a payload written before columns existed as having none", () => {
    const decoded = decodeVoxelSidecar(serializedGrid());
    expect(gridOf(decoded)).toBe(serializedGrid());
    expect(decoded.mapLayer).toBeNull();
  });

  it("degrades a corrupt envelope to no columns rather than throwing", () => {
    expect(decodeVoxelSidecar("{not json").mapLayer).toBeNull();
    expect(decodeVoxelSidecar(null).mapLayer).toBeNull();
    const wrongType = JSON.stringify({ kind: VOXEL_SIDECAR_KIND, grid: "", mapLayer: 42 });
    expect(decodeVoxelSidecar(wrongType).mapLayer).toBeNull();
  });
});

describe("merging keeps one tab from dropping the other's work", () => {
  it("preserves columns when the sculpt is re-saved", () => {
    const withColumns = encodeVoxelSidecar(sidecarOf(serializedGrid(), [], serializedColumns()));

    // Exactly what the Voxel tab does on every edit: decode what is stored,
    // replace the sculpt, re-encode. Anything it does not own must survive.
    const newGrid = new VoxelGrid(4, 4, 4);
    newGrid.set(0, 0, 0, 10, 20, 30);
    const merged = encodeVoxelSidecar(
      withPrimaryVoxel(decodeVoxelSidecar(withColumns), {
        grid: serializeVoxelGrid(newGrid),
        spriteMaterials: [],
      }),
    );

    const decoded = decodeVoxelSidecar(merged);
    expect(gridOf(decoded)).toBe(serializeVoxelGrid(newGrid));
    expect(decoded.mapLayer).toBe(serializedColumns());
  });

  it("preserves the sculpt and its skins when the columns are re-saved", () => {
    const skin = uniformSpriteMaterial("Brick", { page: 0, tile: 4 });
    const original = encodeVoxelSidecar(sidecarOf(serializedGrid(), [skin], null));

    const merged = mergeVoxelSidecar(original, { mapLayer: serializedColumns() });
    const decoded = decodeVoxelSidecar(merged);
    expect(gridOf(decoded)).toBe(serializedGrid());
    expect(materialsOf(decoded)).toEqual([skin]);
    expect(decoded.mapLayer).toBe(serializedColumns());
  });

  it("merging into an empty cart produces a columns-only payload", () => {
    const decoded = decodeVoxelSidecar(mergeVoxelSidecar(null, { mapLayer: serializedColumns() }));
    expect(gridOf(decoded)).toBeNull();
    expect(decoded.mapLayer).toBe(serializedColumns());
  });
});

describe("the stored-payload guard accepts columns without a sculpt", () => {
  it("keeps a payload whose only content is map columns", () => {
    const payload = encodeVoxelSidecar(sidecarOf(null, [], serializedColumns()));
    expect(parseVoxelPayload(payload)).toBe(payload);
  });

  it("still rejects an envelope carrying nothing at all", () => {
    expect(parseVoxelPayload(encodeVoxelSidecar(sidecarOf(null, [], null)))).toBeNull();
    expect(parseVoxelPayload("")).toBeNull();
    expect(parseVoxelPayload(42)).toBeNull();
  });

  it("still rejects a sculpt whose declared dimensions are impossible", () => {
    const bogus = JSON.stringify({ version: 2, sizeX: 9999, sizeY: 1, sizeZ: 1, count: 0 });
    expect(parseVoxelPayload(bogus)).toBeNull();
  });
});
