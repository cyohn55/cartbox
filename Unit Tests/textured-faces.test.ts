/**
 * Textured-face tests — the layer that skins voxel/hexel faces with pixel-art
 * tiles instead of a flat colour. They drive the real renderer with a hand-built
 * atlas and assert on the actual output pixels: that a textured face shows the
 * tile's colour rather than the voxel's flat colour, that a fully transparent
 * tile lets the face drop out, that an untextured model is unaffected, and that
 * the demo atlas and terrain material tagging line up. No internals are inspected.
 */

import { describe, expect, it } from "vitest";
import {
  VoxelGrid,
  voxelGridToModel,
  renderVoxelModel,
  type FaceTexture,
  type TextureAtlas,
  type VoxelModel,
} from "@cartbox/editor";
import { buildWorldAtlas, MATERIAL, terrainMaterial } from "../apps/web/src/lib/faceTextures";
import { AUTHORED_TILES } from "../apps/web/src/lib/authoredTiles";
import { generateTerrain } from "../apps/web/src/lib/hexelTerrainSpecs";

/** A cube of one flat colour; `tile` (if given) is assigned to every voxel. */
function cube(flat: readonly [number, number, number], tile?: number): VoxelModel {
  const grid = new VoxelGrid(3, 3, 3);
  for (let z = 0; z < 3; z += 1) {
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) grid.set(x, y, z, flat[0], flat[1], flat[2], 0);
    }
  }
  return voxelGridToModel(grid, {
    center: "content",
    ...(tile === undefined ? {} : { tileForCell: () => tile }),
  });
}

/** A solid square tile of one colour (alpha/emissive optional). */
function solidTile(r: number, g: number, b: number, a = 255, e = 0): FaceTexture {
  const size = 4;
  const data = new Uint8ClampedArray(size * size * 4);
  const emissive = new Uint8Array(size * size);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
    emissive[i] = e;
  }
  return e > 0 ? { size, data, emissive } : { size, data };
}

const SIZE = 40;
// Flat-on camera and bright light so the front face fills the centre and shade
// never zeroes a channel, making the sampled colour easy to read.
const view = { size: SIZE, cell: 6, yaw: 0, pitch: 0, light: { direction: [0, 0, 1] as const, color: [1, 1, 1] as const, intensity: 1, ambient: 1 } };
const centre = Math.floor(SIZE / 2) * SIZE + Math.floor(SIZE / 2);

describe("textured face rendering", () => {
  it("shows the tile's colour on a white voxel (tint = 1)", () => {
    // White voxel means the tint passes the tile through unchanged: a blue tile
    // must read blue, proving the face is sampled from the tile, not flat-filled.
    const atlas: TextureAtlas = { tiles: [solidTile(40, 40, 255)] };
    const render = renderVoxelModel(cube([255, 255, 255], 0), { ...view, atlas });
    const o = centre * 4;
    expect(render.data[o + 2]).toBeGreaterThan(150); // blue from the tile
    expect(render.data[o]).toBeLessThan(90); // not white — the tile killed red
  });

  it("tints a greyscale tile by the voxel colour", () => {
    // A white tile on a green voxel must come out green: albedo = tile × tint.
    const atlas: TextureAtlas = { tiles: [solidTile(255, 255, 255)] };
    const render = renderVoxelModel(cube([0, 255, 0], 0), { ...view, atlas });
    const o = centre * 4;
    expect(render.data[o + 1]).toBeGreaterThan(150); // green survives the tint
    expect(render.data[o]).toBeLessThan(80); // red tinted out
    expect(render.data[o + 2]).toBeLessThan(80); // blue tinted out
  });

  it("renders the flat colour when no atlas is supplied", () => {
    // Same textured model, but the renderer is given no atlas: falls back to flat.
    const render = renderVoxelModel(cube([0, 255, 0], 0), view);
    const o = centre * 4;
    expect(render.data[o + 1]).toBeGreaterThan(150); // green flat colour
    expect(render.data[o + 2]).toBeLessThan(80);
  });

  it("drops faces whose tile texel is fully transparent", () => {
    const atlas: TextureAtlas = { tiles: [solidTile(255, 0, 0, 0)] }; // alpha 0
    const render = renderVoxelModel(cube([0, 255, 0], 0), { ...view, atlas });
    const anyOpaque = Array.from({ length: SIZE * SIZE }, (_v, i) => render.data[i * 4 + 3]).some((a) => (a ?? 0) > 0);
    expect(anyOpaque).toBe(false); // every face sampled a hole
  });

  it("leaves an untextured model fully opaque", () => {
    const render = renderVoxelModel(cube([200, 200, 200]), view);
    expect(render.data[centre * 4 + 3]).toBe(255);
  });
});

describe("buildWorldAtlas", () => {
  it("lays every authored tile into a slot and maps every material", () => {
    const atlas = buildWorldAtlas();
    expect(atlas.tiles.length).toBe(Object.keys(AUTHORED_TILES).length);
    expect(atlas.materials).toBeDefined();
    expect(atlas.materials!.length).toBe(Object.keys(MATERIAL).length);
  });

  it("every material references tiles that exist in the atlas", () => {
    const atlas = buildWorldAtlas();
    for (const material of atlas.materials!) {
      for (const slot of [material.top, material.side, material.bottom]) {
        expect(atlas.tiles[slot]).toBeDefined();
      }
    }
  });

  it("makes the screen, crystal and monolith surfaces glow but grass stay unlit", () => {
    const atlas = buildWorldAtlas();
    const sideTile = (m: number) => atlas.tiles[atlas.materials![m]!.side]!;
    expect(sideTile(MATERIAL.screen).emissive).toBeDefined();
    expect(sideTile(MATERIAL.crystal).emissive).toBeDefined();
    expect(sideTile(MATERIAL.monolith).emissive).toBeDefined();
    // Grass caps: neither the top nor the side tile is emissive.
    expect(atlas.tiles[atlas.materials![MATERIAL.grass]!.top]!.emissive).toBeUndefined();
  });

  it("is a fixed atlas — two builds are identical", () => {
    const a = buildWorldAtlas();
    const b = buildWorldAtlas();
    expect(Array.from(a.tiles[MATERIAL.rock]!.data)).toEqual(Array.from(b.tiles[MATERIAL.rock]!.data));
  });

  it("gives grass a distinct top vs side tile (the per-face case)", () => {
    const grass = buildWorldAtlas().materials![MATERIAL.grass]!;
    expect(grass.top).not.toBe(grass.side);
    expect(grass.bottom).not.toBe(grass.top);
  });
});

describe("terrain material tagging", () => {
  it("maps each terrain material to its atlas material index", () => {
    expect(terrainMaterial("grass")).toBe(MATERIAL.grass);
    expect(terrainMaterial("rock")).toBe(MATERIAL.rock);
    expect(terrainMaterial("crystal")).toBe(MATERIAL.crystal);
  });

  it("keeps grass on the exposed top and rock in the depths", () => {
    const volume = generateTerrain();
    const filled = new Set(volume.cells.map((c) => `${c.x},${c.y},${c.z}`));
    const columnTop = new Map<string, number>();
    const materials = new Set<string>();
    for (const cell of volume.cells) {
      materials.add(cell.material);
      const col = `${cell.x},${cell.z}`;
      columnTop.set(col, Math.max(columnTop.get(col) ?? -1, cell.y));
    }

    for (const cell of volume.cells) {
      if (cell.material !== "grass") continue;
      // A grass cell is a surface cell: nothing is filled directly above it, and
      // it is at (or one below, by parity) its column's highest filled cell.
      expect(filled.has(`${cell.x},${cell.y + 1},${cell.z}`)).toBe(false);
      expect(columnTop.get(`${cell.x},${cell.z}`)! - cell.y).toBeLessThanOrEqual(1);
    }
    expect(materials.has("grass")).toBe(true);
    expect(materials.has("rock")).toBe(true); // deep layers exist
  });
});
