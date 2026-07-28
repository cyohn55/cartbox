/**
 * The map's free-form 3D cells.
 *
 * Two promises matter here and both are load-bearing for shipping this at all:
 *
 * 1. **Nothing already saved changes.** A map whose cells still form plain
 *    columns must serialize to exactly the payload the old column layer wrote,
 *    byte for byte, so adding a third dimension rewrites nobody's stored cart.
 * 2. **Nothing already saved is lost.** Every column payload must load back as
 *    the same shape it described, hexel parity included.
 *
 * Everything is driven through the real store and the real codec — the column
 * layer used for comparison is the production one, so the two cannot agree by
 * accident of a fixture.
 */

import { describe, expect, it } from "vitest";

import {
  COLUMN_MATERIAL_NONE,
  MAX_MAP_VOXEL_HEIGHT,
  MapVoxelLayer,
  MapVoxelSpace,
  deserializeMapVoxelSpace,
  loadMapVoxelSpace,
  mapColumnTarget,
  mapSpaceFromColumns,
  mapSpaceToColumns,
  serializeMapVoxelLayer,
  serializeMapVoxelSpace,
  type MapVoxelCell,
} from "@cartbox/editor";

/** Every occupied site of a space, in a comparable, order-independent form. */
function cellList(space: MapVoxelSpace): string[] {
  const out: string[] = [];
  space.forEachCell((x, y, z, cell) => {
    out.push(`${x},${y},${z}:${cell.kind}:${cell.colorIndex}:${cell.material}`);
  });
  return out.sort();
}

const solid = (colorIndex: number, material = COLUMN_MATERIAL_NONE): MapVoxelCell => ({
  colorIndex,
  material,
  kind: "solid",
});

/** A column layer with a few raised cells, the way the top-down editor builds one. */
function authoredColumns(shape: "cube" | "hexel" = "cube"): MapVoxelLayer {
  const layer = new MapVoxelLayer(12, 9, shape);
  layer.setColumn(1, 1, 3, 5);
  layer.setColumn(4, 2, 7, 2, 6);
  layer.setColumn(10, 8, 3, 9);
  return layer;
}

describe("MapVoxelSpace — addressing single sites", () => {
  it("places, reads back and removes a cell at an arbitrary site", () => {
    const space = new MapVoxelSpace(8, 6);
    const placed = space.set(3, 5, 4, solid(7, 2));

    expect(placed).toBe(true);
    expect(space.cellAt(3, 5, 4)).toEqual({ colorIndex: 7, material: 2, kind: "solid" });
    expect(space.cellCount).toBe(1);

    space.clear(3, 5, 4);
    expect(space.cellAt(3, 5, 4)).toBeNull();
    expect(space.cellCount).toBe(0);
  });

  it("holds an overhang — a cell with nothing beneath it", () => {
    const space = new MapVoxelSpace(8, 6);
    space.set(2, 6, 2, solid(3));

    expect(space.isFilled(2, 6, 2)).toBe(true);
    expect(space.isFilled(2, 0, 2)).toBe(false);
    // The column reading follows the topmost cell, so a floating cell still gives
    // the map cell a height — which is what the top-down view draws.
    expect(space.heightAt(2, 2)).toBe(7);
  });

  it("reports the column height from the topmost cell as sites are carved out", () => {
    const space = new MapVoxelSpace(4, 4);
    for (let y = 0; y < 5; y += 1) space.set(1, y, 1, solid(1));
    expect(space.heightAt(1, 1)).toBe(5);

    // Removing from the middle leaves a cave: the height is unchanged.
    space.clear(1, 2, 1);
    expect(space.heightAt(1, 1)).toBe(5);
    expect(space.isFilled(1, 2, 1)).toBe(false);

    // Removing the top drops the height past the hole to the next cell down.
    space.clear(1, 4, 1);
    expect(space.heightAt(1, 1)).toBe(4);
    space.clear(1, 3, 1);
    expect(space.heightAt(1, 1)).toBe(2);
  });

  it("refuses sites outside the map and above the ceiling", () => {
    const space = new MapVoxelSpace(5, 5);

    expect(space.set(5, 0, 0, solid(1))).toBe(false);
    expect(space.set(0, MAX_MAP_VOXEL_HEIGHT, 0, solid(1))).toBe(false);
    expect(space.set(-1, 0, 0, solid(1))).toBe(false);
    expect(space.cellCount).toBe(0);
  });

  it("keeps a hexel map on the close-packed lattice", () => {
    const space = new MapVoxelSpace(6, 6, "hexel");

    expect(space.set(0, 0, 0, solid(1))).toBe(true); // even coordinate sum
    expect(space.set(1, 0, 0, solid(1))).toBe(false); // odd — off the lattice
    expect(space.cellCount).toBe(1);
  });

  it("round-trips every flat site index back to its coordinates", () => {
    const space = new MapVoxelSpace(7, 5);
    for (const [x, y, z] of [
      [0, 0, 0],
      [6, 0, 4],
      [3, MAX_MAP_VOXEL_HEIGHT - 1, 2],
    ] as const) {
      expect(space.coordsOf(space.index(x, y, z))).toEqual([x, y, z]);
    }
  });
});

describe("MapVoxelSpace — the column view the top-down editor drives", () => {
  it("raises and lowers a stack, and keeps an existing column's own look", () => {
    const space = new MapVoxelSpace(6, 6);
    space.raise(2, 2, 3, 4, 5);
    expect(space.heightAt(2, 2)).toBe(3);
    expect(space.cellAt(2, 0, 2)).toEqual({ colorIndex: 4, material: 5, kind: "solid" });

    // Raising further with a different colour armed must not restyle the column.
    space.raise(2, 2, 2, 9, COLUMN_MATERIAL_NONE);
    expect(space.heightAt(2, 2)).toBe(5);
    expect(space.cellAt(2, 4, 2)).toEqual({ colorIndex: 4, material: 5, kind: "solid" });

    space.raise(2, 2, -4, 9);
    expect(space.heightAt(2, 2)).toBe(1);
  });

  it("matches the column layer's raise semantics exactly", () => {
    const space = new MapVoxelSpace(6, 6);
    const layer = new MapVoxelLayer(6, 6);
    for (const [delta, color, material] of [
      [3, 4, 5],
      [2, 9, 1],
      [-1, 2, COLUMN_MATERIAL_NONE],
    ] as const) {
      expect(space.raise(1, 1, delta, color, material)).toBe(layer.raise(1, 1, delta, color, material));
    }
    expect(space.columnAt(1, 1)).toEqual(layer.columnAt(1, 1));
  });

  it("flattening replaces the stack outright, clearing what stood above it", () => {
    const space = new MapVoxelSpace(6, 6);
    space.set(3, 9, 3, solid(1)); // a floating cell high above
    space.setColumn(3, 3, 2, 7);

    expect(space.heightAt(3, 3)).toBe(2);
    expect(space.isFilled(3, 9, 3)).toBe(false);
  });

  it("painting a column recolours every cell in it, including a carved one", () => {
    const space = new MapVoxelSpace(6, 6);
    space.setColumn(2, 3, 4, 1, 2);
    space.clear(2, 1, 3); // carve a hole partway up

    space.paintColumn(2, 3, 8, COLUMN_MATERIAL_NONE);

    const colours = [0, 2, 3].map((y) => space.cellAt(2, y, 3));
    expect(colours.every((cell) => cell?.colorIndex === 8 && cell.material === COLUMN_MATERIAL_NONE)).toBe(true);
    expect(space.cellAt(2, 1, 3)).toBeNull();
  });

  it("exposes the generators' column target with the map's rows as its height", () => {
    const space = new MapVoxelSpace(11, 7);
    const target = mapColumnTarget(space);

    expect(target.width).toBe(space.width);
    expect(target.height).toBe(space.depth);

    target.setColumn(10, 6, 3, 2, 4);
    expect(space.columnAt(10, 6)).toEqual({ height: 3, colorIndex: 2, material: 4 });
  });
});

describe("MapVoxelSpace — planes", () => {
  it("stores a plane's orientation and skin alongside solid cells", () => {
    const space = new MapVoxelSpace(6, 6);
    space.set(1, 1, 1, solid(2));
    space.set(1, 2, 1, { colorIndex: 3, material: 20, kind: "cross" });

    expect(space.cellAt(1, 2, 1)).toEqual({ colorIndex: 3, material: 20, kind: "cross" });
    // A plane still counts toward the column reading, so the top-down view shows
    // that something stands there.
    expect(space.heightAt(1, 1)).toBe(3);
  });

  it("round-trips every plane orientation through the codec", () => {
    const space = new MapVoxelSpace(8, 8);
    const kinds = ["planeX", "planeY", "planeZ", "cross"] as const;
    kinds.forEach((kind, index) => {
      space.set(index, 0, 0, { colorIndex: index + 1, material: 30 + index, kind });
    });

    const restored = deserializeMapVoxelSpace(serializeMapVoxelSpace(space));
    expect(cellList(restored)).toEqual(cellList(space));
  });
});

describe("MapVoxelSpace — the saved payload", () => {
  it("writes a columnar map as the column payload it always did, byte for byte", () => {
    const layer = authoredColumns();
    const space = mapSpaceFromColumns(layer);

    expect(serializeMapVoxelSpace(space)).toBe(serializeMapVoxelLayer(layer));
  });

  it("writes a columnar hexel map as its column payload too, parity and all", () => {
    // Every column here tops out on a real hexel site, which is the case the
    // byte-identity promise covers; the two tests below pin what happens when a
    // stored height names a level the lattice does not have.
    const layer = authoredColumns("hexel");
    const space = mapSpaceFromColumns(layer);

    expect(mapSpaceToColumns(space)).not.toBeNull();
    expect(serializeMapVoxelSpace(space)).toBe(serializeMapVoxelLayer(layer));
  });

  it("reports a hexel column's height as its topmost real site", () => {
    // A stored height of two over an even-sum site puts a hexel at y=0 and
    // nothing at y=1 — which is exactly what the layer always rendered. The space
    // records the cell that exists rather than the level that was asked for, so
    // the two views of the map agree about how tall the column is.
    const layer = new MapVoxelLayer(12, 9, "hexel");
    layer.setColumn(10, 8, 2, 9);
    const space = mapSpaceFromColumns(layer);

    expect(space.heightAt(10, 8)).toBe(1);
    expect(space.cellCount).toBe(1);
    expect(cellList(deserializeMapVoxelSpace(serializeMapVoxelSpace(space)))).toEqual(cellList(space));
  });

  it("raises a hexel column with no site on the lattice rather than dropping it", () => {
    // A height of one over a site whose coordinates sum odd names a range that
    // holds no valid hexel at all. The column was authored and is drawn from
    // above, so it has to survive the round trip as *something*.
    const layer = new MapVoxelLayer(12, 9, "hexel");
    layer.setColumn(11, 8, 1, 4);
    const space = mapSpaceFromColumns(layer);

    expect(space.columnCount).toBe(1);
    expect(space.cellAt(11, 1, 8)).toEqual({ colorIndex: 4, material: COLUMN_MATERIAL_NONE, kind: "solid" });
    // Round-tripping it is then stable: what comes back is what was stored.
    const restored = deserializeMapVoxelSpace(serializeMapVoxelSpace(space));
    expect(cellList(restored)).toEqual(cellList(space));
  });

  it("stops calling a map columnar once anything overhangs, and round-trips it", () => {
    const space = mapSpaceFromColumns(authoredColumns());
    const before = cellList(space);
    space.set(6, 5, 5, solid(3, 2)); // a floating slab with air beneath it

    expect(mapSpaceToColumns(space)).toBeNull();

    const restored = deserializeMapVoxelSpace(serializeMapVoxelSpace(space));
    expect(cellList(restored)).toEqual(cellList(space));
    // And the columns that were already there survived the change of format.
    expect(before.every((entry) => cellList(restored).includes(entry))).toBe(true);
  });

  it("stops calling a map columnar once a stack is carved through", () => {
    const space = new MapVoxelSpace(6, 6);
    space.setColumn(2, 2, 4, 1);
    expect(mapSpaceToColumns(space)).not.toBeNull();

    space.clear(2, 1, 2); // a cave
    expect(mapSpaceToColumns(space)).toBeNull();
  });

  it("stops calling a map columnar once one cell of a stack is repainted", () => {
    const space = new MapVoxelSpace(6, 6);
    space.setColumn(2, 2, 4, 1);
    space.recolor(2, 2, 2, 9);

    expect(mapSpaceToColumns(space)).toBeNull();
    expect(cellList(deserializeMapVoxelSpace(serializeMapVoxelSpace(space)))).toEqual(cellList(space));
  });

  it("loads a column payload saved before free-form cells existed", () => {
    const layer = authoredColumns();
    const restored = deserializeMapVoxelSpace(serializeMapVoxelLayer(layer));

    expect(cellList(restored)).toEqual(cellList(mapSpaceFromColumns(layer)));
    expect(restored.columnAt(4, 2)).toEqual(layer.columnAt(4, 2));
  });

  it("preserves materials across the sparse format", () => {
    const space = new MapVoxelSpace(6, 6);
    space.setColumn(1, 1, 2, 3, 7);
    space.set(1, 5, 1, solid(4, 11)); // breaks columnarity, forcing the sparse write

    const restored = deserializeMapVoxelSpace(serializeMapVoxelSpace(space));
    expect(restored.cellAt(1, 0, 1)?.material).toBe(7);
    expect(restored.cellAt(1, 5, 1)?.material).toBe(11);
  });

  it("rejects a payload whose cell count contradicts its own arrays", () => {
    const space = new MapVoxelSpace(6, 6);
    space.setColumn(1, 1, 2, 3);
    space.set(1, 5, 1, solid(4));
    const payload = JSON.parse(serializeMapVoxelSpace(space)) as { count: number };
    payload.count += 5;

    expect(() => deserializeMapVoxelSpace(JSON.stringify(payload))).toThrow();
  });

  it("rejects a payload from a format it does not know", () => {
    expect(() => deserializeMapVoxelSpace(JSON.stringify({ version: 99, width: 4, depth: 4 }))).toThrow();
  });
});

describe("loadMapVoxelSpace — mounting the editor", () => {
  it("starts empty when the cart has no map payload", () => {
    const space = loadMapVoxelSpace(null, 20, 10);

    expect(space.isEmpty).toBe(true);
    expect([space.width, space.depth]).toEqual([20, 10]);
  });

  it("degrades a corrupt payload to an empty map rather than failing the mount", () => {
    const space = loadMapVoxelSpace("{not json", 20, 10);

    expect(space.isEmpty).toBe(true);
    expect([space.width, space.depth]).toEqual([20, 10]);
  });

  it("rebuilds a payload authored at another footprint, keeping what still fits", () => {
    const wide = new MapVoxelSpace(20, 20);
    wide.set(2, 0, 2, solid(1));
    wide.set(19, 0, 19, solid(2)); // past the edge of the smaller map

    const space = loadMapVoxelSpace(serializeMapVoxelSpace(wide), 10, 10);

    expect([space.width, space.depth]).toEqual([10, 10]);
    expect(space.cellAt(2, 0, 2)).toEqual({ colorIndex: 1, material: COLUMN_MATERIAL_NONE, kind: "solid" });
    expect(space.cellCount).toBe(1);
  });
});

describe("MapVoxelSpace — cloning", () => {
  it("re-shaping to hexels keeps only the cells the lattice can hold", () => {
    const space = new MapVoxelSpace(6, 6);
    space.set(0, 0, 0, solid(1)); // even sum — valid as a hexel
    space.set(1, 0, 0, solid(2)); // odd sum — not

    const hexels = space.clone({ shape: "hexel" });

    expect(hexels.shape).toBe("hexel");
    expect(hexels.cellAt(0, 0, 0)).not.toBeNull();
    expect(hexels.cellAt(1, 0, 0)).toBeNull();
  });

  it("a plain clone is independent of the original", () => {
    const space = new MapVoxelSpace(6, 6);
    space.set(1, 1, 1, solid(1));
    const copy = space.clone();

    copy.clear(1, 1, 1);
    expect(space.isFilled(1, 1, 1)).toBe(true);
    expect(copy.isFilled(1, 1, 1)).toBe(false);
  });
});
