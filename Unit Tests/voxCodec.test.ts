/**
 * Unit tests for the MagicaVoxel `.vox` import/export codec.
 *
 * Nothing here is stubbed. Two complementary paths are exercised:
 *
 * 1. **Round-trip** — a real {@link VoxelGrid} is encoded and parsed back, so the
 *    encoder and parser check each other on the coordinates and colours that a
 *    creator would actually author. Because MagicaVoxel is Z-up and a grid is
 *    Y-up, the codec swaps two axes on each leg; the round-trip proves the swap
 *    is its own inverse.
 * 2. **Independent files** — buffers assembled by hand to the published wire
 *    format (`buildVoxFile`) drive the parser directly, so the palette-index
 *    offset, the Z-up→Y-up mapping, and the default-palette fallback are verified
 *    against files the encoder did not produce (not a mirror of its own logic).
 */

import { describe, expect, it } from "vitest";

import { VoxelGrid, parseVox, encodeVox, DEFAULT_VOX_PALETTE, MAX_VOXEL_GRID_DIM } from "@cartbox/editor";

/** ASCII "VOX " as a little-endian u32 — the file's magic bytes. */
const VOX_MAGIC = 0x20584f56;
const CHUNK_HEADER = 12;

const fourCC = (text: string): number =>
  text.charCodeAt(0) | (text.charCodeAt(1) << 8) | (text.charCodeAt(2) << 16) | (text.charCodeAt(3) << 24);

/** An `(x, y, z, colorIndex)` voxel record in the file's own Z-up space. */
type VoxRecord = readonly [number, number, number, number];
/** An `(r, g, b, a)` palette entry written to the RGBA chunk. */
type RgbaEntry = readonly [number, number, number, number];

/**
 * Assemble a minimal but valid `.vox` file to the published format: header,
 * MAIN, SIZE, XYZI, and an optional RGBA palette. `rgbaEntries[p]` is written to
 * palette slot `p`, which the format maps to colour index `p + 1` — so a voxel
 * with colour index `c` reads `rgbaEntries[c - 1]`. Independent of the encoder,
 * so parsing it is a real test of the reader.
 */
function buildVoxFile(
  size: readonly [number, number, number],
  voxels: readonly VoxRecord[],
  rgbaEntries?: readonly RgbaEntry[],
): Uint8Array {
  const sizeContent = 12;
  const xyziContent = 4 + voxels.length * 4;
  const rgbaContent = rgbaEntries ? 256 * 4 : 0;
  const rgbaChunk = rgbaEntries ? CHUNK_HEADER + rgbaContent : 0;
  const children = CHUNK_HEADER + sizeContent + CHUNK_HEADER + xyziContent + rgbaChunk;
  const total = 8 + CHUNK_HEADER + children;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, VOX_MAGIC, true);
  view.setInt32(4, 150, true);

  view.setInt32(8, fourCC("MAIN"), true);
  view.setInt32(12, 0, true);
  view.setInt32(16, children, true);

  let offset = 8 + CHUNK_HEADER;
  const header = (id: string, content: number): void => {
    view.setInt32(offset, fourCC(id), true);
    view.setInt32(offset + 4, content, true);
    view.setInt32(offset + 8, 0, true);
    offset += CHUNK_HEADER;
  };

  header("SIZE", sizeContent);
  view.setInt32(offset, size[0], true);
  view.setInt32(offset + 4, size[1], true);
  view.setInt32(offset + 8, size[2], true);
  offset += sizeContent;

  header("XYZI", xyziContent);
  view.setInt32(offset, voxels.length, true);
  offset += 4;
  for (const [x, y, z, colorIndex] of voxels) {
    out[offset] = x;
    out[offset + 1] = y;
    out[offset + 2] = z;
    out[offset + 3] = colorIndex;
    offset += 4;
  }

  if (rgbaEntries) {
    header("RGBA", rgbaContent);
    for (let p = 0; p < rgbaEntries.length; p += 1) {
      const [r, g, b, a] = rgbaEntries[p]!;
      out[offset + p * 4] = r;
      out[offset + p * 4 + 1] = g;
      out[offset + p * 4 + 2] = b;
      out[offset + p * 4 + 3] = a;
    }
  }
  return out;
}

/** Collect a grid's filled cells as sortable `x,y,z,r,g,b` tuples for comparison. */
function filledTuples(grid: VoxelGrid): string[] {
  const tuples: string[] = [];
  grid.forEachFilled((x, y, z, cell) => tuples.push(`${x},${y},${z},${cell.r},${cell.g},${cell.b}`));
  return tuples.sort();
}

describe("vox codec round-trip", () => {
  it("preserves every voxel's position and colour through encode → parse", () => {
    const grid = new VoxelGrid(16, 24, 8); // deliberately non-cubic to catch axis mix-ups
    grid.set(0, 0, 0, 200, 30, 40);
    grid.set(1, 5, 2, 30, 200, 40);
    grid.set(15, 23, 7, 40, 30, 200); // the far corner of every axis
    grid.set(4, 4, 4, 200, 30, 40); // a colour repeat — must share one palette entry

    const restored = parseVox(encodeVox(grid));

    expect(restored.sizeX).toBe(grid.sizeX);
    expect(restored.sizeY).toBe(grid.sizeY);
    expect(restored.sizeZ).toBe(grid.sizeZ);
    expect(restored.filledCount).toBe(grid.filledCount);
    expect(filledTuples(restored)).toEqual(filledTuples(grid));
  });

  it("emits a valid header and a MAIN chunk", () => {
    const grid = new VoxelGrid(4, 4, 4);
    grid.set(1, 1, 1, 10, 20, 30);
    const bytes = encodeVox(grid);
    const view = new DataView(bytes.buffer);

    expect(view.getUint32(0, true)).toBe(VOX_MAGIC);
    expect(view.getInt32(4, true)).toBe(150);
    expect(view.getInt32(8, true)).toBe(fourCC("MAIN"));
  });

  it("drops emissive and materials, which the format cannot carry", () => {
    const grid = new VoxelGrid(4, 4, 4);
    grid.set(1, 1, 1, 10, 20, 30, 255, 2); // emissive 255, material index 2
    const restored = parseVox(encodeVox(grid));
    const cell = restored.get(1, 1, 1)!;
    expect(cell.emissive).toBe(0);
    expect(cell.tile).toBe(-1); // MATERIAL_NONE
  });

  it("keeps every voxel when a sculpt exceeds the 255-colour palette limit", () => {
    // 300 distinct colours: the encoder must fold the overflow onto existing
    // palette entries rather than dropping voxels.
    const grid = new VoxelGrid(32, 32, 32);
    let placed = 0;
    for (let i = 0; i < 300; i += 1) {
      const x = i % 32;
      const y = Math.floor(i / 32) % 32;
      const z = Math.floor(i / 1024);
      grid.set(x, y, z, i & 0xff, (i * 3) & 0xff, (i * 7) & 0xff);
      placed += 1;
    }
    const restored = parseVox(encodeVox(grid));
    expect(restored.filledCount).toBe(placed);
  });
});

describe("vox parser on hand-built files", () => {
  it("maps a colour index through the palette's +1 offset", () => {
    // Colour index 2 → RGBA slot 1 (the second entry).
    const file = buildVoxFile(
      [2, 2, 2],
      [[0, 0, 0, 2]],
      [
        [11, 22, 33, 255], // slot 0 → colour index 1 (unused here)
        [123, 45, 67, 255], // slot 1 → colour index 2 (the voxel's)
      ],
    );
    const grid = parseVox(file);
    const cell = grid.get(0, 0, 0)!;
    expect([cell.r, cell.g, cell.b]).toEqual([123, 45, 67]);
  });

  it("swaps Z-up to Y-up: a vox voxel at (x,y,z) lands at grid (x,z,y)", () => {
    // SIZE (3,5,7) is Z-up; the parsed grid must be (3,7,5).
    const file = buildVoxFile([3, 5, 7], [[1, 4, 6, 1]], [[80, 90, 100, 255]]);
    const grid = parseVox(file);
    expect([grid.sizeX, grid.sizeY, grid.sizeZ]).toEqual([3, 7, 5]);
    expect(grid.isFilled(1, 6, 4)).toBe(true); // (x, z, y)
    expect(grid.isFilled(1, 4, 6)).toBe(false); // not the un-swapped position
  });

  it("falls back to the built-in palette when a file omits its RGBA chunk", () => {
    const file = buildVoxFile([2, 2, 2], [[0, 0, 0, 5]]); // colour index 5, no palette
    const grid = parseVox(file);
    const cell = grid.get(0, 0, 0)!;
    // The default palette word is 0xAABBGGRR — red is the low byte.
    const expected = DEFAULT_VOX_PALETTE[5]!;
    expect(cell.r).toBe(expected & 0xff);
    expect(cell.g).toBe((expected >> 8) & 0xff);
    expect(cell.b).toBe((expected >> 16) & 0xff);
  });

  it("skips voxels that carry the empty colour index (0)", () => {
    const file = buildVoxFile([2, 2, 2], [[0, 0, 0, 0], [1, 1, 1, 1]], [[10, 20, 30, 255]]);
    const grid = parseVox(file);
    expect(grid.filledCount).toBe(1);
    expect(grid.isFilled(1, 1, 1)).toBe(true);
  });
});

describe("vox parser rejects malformed input", () => {
  it("throws on bad magic bytes", () => {
    expect(() => parseVox(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/magic/i);
  });

  it("throws on a file too short to hold a header", () => {
    expect(() => parseVox(new Uint8Array([0x56, 0x4f, 0x58]))).toThrow();
  });

  it("throws on a model dimension beyond the supported maximum", () => {
    const file = buildVoxFile([MAX_VOXEL_GRID_DIM + 1, 1, 1], [[0, 0, 0, 1]], [[1, 2, 3, 255]]);
    expect(() => parseVox(file)).toThrow(/dimension/i);
  });

  it("does not read past a truncated XYZI record count", () => {
    // Claim two voxels but supply the bytes for only one; the parser must not
    // read past the chunk, and must decode the one real voxel.
    const file = buildVoxFile([4, 4, 4], [[1, 1, 1, 1]], [[9, 8, 7, 255]]);
    const view = new DataView(file.buffer);
    // The XYZI count sits right after its 12-byte header, which follows the
    // 8-byte file header, the 12-byte MAIN header, and the 24-byte SIZE chunk.
    const xyziCountOffset = 8 + CHUNK_HEADER + CHUNK_HEADER + 12 + CHUNK_HEADER;
    view.setInt32(xyziCountOffset, 2, true); // lie: say there are two voxels
    const grid = parseVox(file);
    expect(grid.filledCount).toBe(1);
  });
});
