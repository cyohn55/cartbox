/**
 * Per-cell material tests for VoxelGrid — the authored storage the editor and the
 * in-world builder assign tiles into. They cover reading/clearing a cell's
 * material, that an authored grid textures its model without a tileForCell
 * override, that clone and the sparse serializer round-trip materials, and that a
 * material-free grid still serializes as the older (v2) payload untouched.
 */

import { describe, expect, it } from "vitest";
import {
  VoxelGrid,
  voxelGridToModel,
  serializeVoxelGrid,
  deserializeVoxelGrid,
  MATERIAL_NONE,
} from "@cartbox/editor";

/** A grid with a single filled cell at the origin. */
function oneCell(tile = MATERIAL_NONE): VoxelGrid {
  const grid = new VoxelGrid(3, 3, 3);
  grid.set(1, 1, 1, 200, 100, 50, 0, tile);
  return grid;
}

describe("VoxelGrid materials", () => {
  it("stores and reads a cell's material", () => {
    const grid = oneCell(7);
    expect(grid.materialAt(1, 1, 1)).toBe(7);
    expect(grid.hasMaterials()).toBe(true);
    // An empty cell has no material.
    expect(grid.materialAt(0, 0, 0)).toBe(MATERIAL_NONE);
  });

  it("only assigns a material to a filled cell", () => {
    const grid = new VoxelGrid(3, 3, 3);
    grid.setMaterial(1, 1, 1, 4); // cell is empty → no-op
    expect(grid.hasMaterials()).toBe(false);
  });

  it("clears a material with a negative index", () => {
    const grid = oneCell(4);
    grid.setMaterial(1, 1, 1, MATERIAL_NONE);
    expect(grid.materialAt(1, 1, 1)).toBe(MATERIAL_NONE);
    expect(grid.hasMaterials()).toBe(false);
  });

  it("clearing a cell drops its material", () => {
    const grid = oneCell(4);
    grid.clear(1, 1, 1);
    expect(grid.hasMaterials()).toBe(false);
  });

  it("carries the grid's own materials into the model without an override", () => {
    const model = voxelGridToModel(oneCell(5), { center: "content" });
    expect(model.tile).toBeDefined();
    expect(model.tile![0]).toBe(5);
  });

  it("builds no tile array for an untextured grid", () => {
    const model = voxelGridToModel(oneCell(), { center: "content" });
    expect(model.tile).toBeUndefined();
  });

  it("lets a tileForCell override win over the grid material", () => {
    const model = voxelGridToModel(oneCell(5), { center: "content", tileForCell: () => 9 });
    expect(model.tile![0]).toBe(9);
  });

  it("clones materials", () => {
    const copy = oneCell(6).clone();
    expect(copy.materialAt(1, 1, 1)).toBe(6);
  });

  it("round-trips materials through serialize/deserialize", () => {
    const grid = new VoxelGrid(4, 4, 4);
    grid.set(0, 0, 0, 10, 20, 30, 0, 2);
    grid.set(3, 3, 3, 40, 50, 60, 128, 11);
    grid.set(1, 2, 1, 70, 80, 90, 0); // deliberately untextured
    const restored = deserializeVoxelGrid(serializeVoxelGrid(grid));
    expect(restored.materialAt(0, 0, 0)).toBe(2);
    expect(restored.materialAt(3, 3, 3)).toBe(11);
    expect(restored.materialAt(1, 2, 1)).toBe(MATERIAL_NONE);
  });

  it("serializes a material-free grid as the v2 payload", () => {
    const json = serializeVoxelGrid(oneCell());
    expect(JSON.parse(json).version).toBe(2);
    expect(JSON.parse(json).tiles).toBeUndefined();
  });

  it("bumps to v3 only when a material is present", () => {
    expect(JSON.parse(serializeVoxelGrid(oneCell(3))).version).toBe(3);
  });
});
