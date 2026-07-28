/**
 * Voxel sidecar tests — the payload the Voxel tab saves.
 *
 * The sculpt's material indices are meaningless without the sprite list they
 * index into, so both travel together; equally, a sculpt that uses no sprite
 * skins must keep saving exactly what it always did. These drive the real codec
 * against real serialized grids (built with the editor's own `VoxelGrid`), and
 * cover the payloads that actually arrive from storage: the v2 envelope, the v1
 * envelope, the older bare grid, and corrupt input.
 *
 * Sculpts are addressed through the real production helpers (`primaryVoxelAsset`
 * / `withPrimaryVoxel`) rather than by reaching into the asset list, so these
 * exercise the path the editor actually takes.
 */

import { describe, expect, it } from "vitest";

import { serializeVoxelGrid, VoxelGrid, MAX_VOXEL_GRID_DIM } from "@cartbox/editor";
import {
  decodeVoxelSidecar,
  encodeVoxelSidecar,
  parseVoxelPayload,
  primaryVoxelAsset,
  withPrimaryVoxel,
  EMPTY_VOXEL_SIDECAR,
  MAX_VOXEL_PAYLOAD_CHARS,
  VOXEL_SIDECAR_KIND,
  type VoxelSidecar,
} from "../apps/web/src/lib/voxelSidecar";
import { uniformSpriteMaterial, type SpriteMaterial } from "../apps/web/src/lib/spriteTiles";

/** A real serialized sculpt: two voxels, one of them wearing a material. */
function serializedGrid(): string {
  const grid = new VoxelGrid(4, 4, 4);
  grid.set(1, 1, 1, 200, 100, 50);
  grid.set(1, 2, 1, 255, 255, 255, 0, 13);
  return serializeVoxelGrid(grid);
}

const MATERIALS: readonly SpriteMaterial[] = [
  uniformSpriteMaterial("Sprite 1", { page: 0, tile: 1 }),
  { name: "Sprite 2 capped", top: { page: 0, tile: 4 }, side: { page: 0, tile: 2 }, bottom: { page: 1, tile: 7 } },
];

/** A one-sculpt cart, the way the editor builds one. */
const sidecarOf = (
  grid: string | null,
  spriteMaterials: readonly SpriteMaterial[] = [],
  mapLayer: string | null = null,
): VoxelSidecar => ({ ...withPrimaryVoxel(EMPTY_VOXEL_SIDECAR, { grid, spriteMaterials }), mapLayer });

const gridOf = (sidecar: VoxelSidecar) => primaryVoxelAsset(sidecar)?.grid ?? null;
const materialsOf = (sidecar: VoxelSidecar) => primaryVoxelAsset(sidecar)?.spriteMaterials ?? [];

describe("encodeVoxelSidecar", () => {
  it("saves the bare grid when no sprite skins are used", () => {
    const grid = serializedGrid();
    expect(encodeVoxelSidecar(sidecarOf(grid))).toBe(grid);
  });

  it("wraps grid and sprite skins together once one is used", () => {
    const grid = serializedGrid();
    const payload = JSON.parse(encodeVoxelSidecar(sidecarOf(grid, MATERIALS)));
    expect(payload.kind).toBe(VOXEL_SIDECAR_KIND);
    expect(payload.grid).toBe(grid);
    expect(payload.spriteMaterials).toHaveLength(2);
  });
});

describe("decodeVoxelSidecar", () => {
  it("round-trips a sculpt with its sprite skins", () => {
    const grid = serializedGrid();
    const decoded = decodeVoxelSidecar(encodeVoxelSidecar(sidecarOf(grid, MATERIALS)));
    expect(gridOf(decoded)).toBe(grid);
    expect(materialsOf(decoded)).toEqual(MATERIALS);
    // The grid survives as a loadable payload, not just as text.
    expect(JSON.parse(gridOf(decoded)!).count).toBe(2);
  });

  it("reads a bare grid payload saved before sprite skins existed", () => {
    const grid = serializedGrid();
    const decoded = decodeVoxelSidecar(grid);
    expect(gridOf(decoded)).toBe(grid);
    expect(materialsOf(decoded)).toEqual([]);
  });

  it("treats nothing saved as an empty sculpt", () => {
    expect(decodeVoxelSidecar(null)).toEqual(EMPTY_VOXEL_SIDECAR);
    expect(decodeVoxelSidecar("")).toEqual(EMPTY_VOXEL_SIDECAR);
  });

  it("hands unreadable text through for the grid loader to reject", () => {
    const decoded = decodeVoxelSidecar("not json at all");
    expect(gridOf(decoded)).toBe("not json at all");
    expect(materialsOf(decoded)).toEqual([]);
  });

  it("drops malformed sprite skins rather than failing the whole sculpt", () => {
    const grid = serializedGrid();
    const payload = JSON.stringify({
      kind: VOXEL_SIDECAR_KIND,
      version: 1,
      grid,
      spriteMaterials: [
        MATERIALS[0],
        { name: "no faces" },
        { name: "bad page", top: { page: 9, tile: 1 }, side: { page: 0, tile: 1 }, bottom: { page: 0, tile: 1 } },
        { top: { page: 0, tile: 1 }, side: { page: 0, tile: 1 }, bottom: { page: 0, tile: 1 } }, // unnamed
        "nonsense",
      ],
    });
    const decoded = decodeVoxelSidecar(payload);
    expect(gridOf(decoded)).toBe(grid);
    expect(materialsOf(decoded)).toEqual([MATERIALS[0]]);
  });

  it("reports an envelope with an empty grid as having no sculpt", () => {
    // The skins go with it: material indices are addresses into a grid, so with
    // no grid there is nothing for them to be indices into. The server-side guard
    // rejects such a payload anyway, so this state was never storable.
    const payload = JSON.stringify({ kind: VOXEL_SIDECAR_KIND, version: 1, grid: "", spriteMaterials: MATERIALS });
    const decoded = decodeVoxelSidecar(payload);
    expect(primaryVoxelAsset(decoded)).toBeNull();
    expect(decoded.assets).toEqual([]);
  });
});

/**
 * The server-side gate: what a client is allowed to store on a cart. It runs on
 * whatever arrives over the wire, so the cases that matter are the hostile ones —
 * and it must clear a real payload untouched.
 */
describe("parseVoxelPayload", () => {
  it("accepts a real sculpt, returning it byte-for-byte", () => {
    const grid = serializedGrid();
    expect(parseVoxelPayload(grid)).toBe(grid);
  });

  it("accepts a sculpt wrapped with its sprite skins", () => {
    const payload = encodeVoxelSidecar(sidecarOf(serializedGrid(), MATERIALS));
    expect(parseVoxelPayload(payload)).toBe(payload);
  });

  it("rejects anything that is not a non-empty string", () => {
    expect(parseVoxelPayload(null)).toBeNull();
    expect(parseVoxelPayload(undefined)).toBeNull();
    expect(parseVoxelPayload(42)).toBeNull();
    expect(parseVoxelPayload({ grid: serializedGrid() })).toBeNull();
    expect(parseVoxelPayload("")).toBeNull();
    expect(parseVoxelPayload("   ")).toBeNull();
  });

  it("rejects text that is not a serialized sculpt", () => {
    expect(parseVoxelPayload("not json at all")).toBeNull();
    expect(parseVoxelPayload("[1,2,3]")).toBeNull();
    expect(parseVoxelPayload(JSON.stringify({ hello: "world" }))).toBeNull();
  });

  it("rejects a payload past the size ceiling without inspecting it", () => {
    const oversize = `{"sizeX":4,"sizeY":4,"sizeZ":4,"pad":"${"x".repeat(MAX_VOXEL_PAYLOAD_CHARS)}"}`;
    expect(oversize.length).toBeGreaterThan(MAX_VOXEL_PAYLOAD_CHARS);
    expect(parseVoxelPayload(oversize)).toBeNull();
  });

  it("rejects dimensions the editor could never have produced", () => {
    const dims = (sizeX: unknown, sizeY: unknown, sizeZ: unknown) =>
      JSON.stringify({ version: 3, sizeX, sizeY, sizeZ, count: 0 });
    // A volume far past the cap would be allocated on load — refuse it here.
    expect(parseVoxelPayload(dims(MAX_VOXEL_GRID_DIM + 1, 4, 4))).toBeNull();
    expect(parseVoxelPayload(dims(4, 0, 4))).toBeNull();
    expect(parseVoxelPayload(dims(4, 4, -8))).toBeNull();
    expect(parseVoxelPayload(dims(4, 4, 4.5))).toBeNull();
    expect(parseVoxelPayload(dims("4", 4, 4))).toBeNull();
    // ...and the largest grid the editor does allow is fine.
    expect(parseVoxelPayload(dims(MAX_VOXEL_GRID_DIM, 1, 1))).not.toBeNull();
  });

  it("rejects a cell count that cannot fit the declared volume", () => {
    const grid = JSON.stringify({ version: 3, sizeX: 4, sizeY: 4, sizeZ: 4, count: 65 });
    expect(parseVoxelPayload(grid)).toBeNull();
    expect(parseVoxelPayload(JSON.stringify({ version: 3, sizeX: 4, sizeY: 4, sizeZ: 4, count: 64 }))).not.toBeNull();
  });

  it("rejects an envelope carrying no sculpt", () => {
    const payload = JSON.stringify({ kind: VOXEL_SIDECAR_KIND, version: 1, grid: "", spriteMaterials: MATERIALS });
    expect(parseVoxelPayload(payload)).toBeNull();
  });

  it("keeps a sculpt the editor can load straight back", () => {
    const stored = parseVoxelPayload(encodeVoxelSidecar(sidecarOf(serializedGrid(), MATERIALS)))!;
    const decoded = decodeVoxelSidecar(stored);
    expect(JSON.parse(gridOf(decoded)!).count).toBe(2);
    expect(materialsOf(decoded)).toEqual(MATERIALS);
  });
});
