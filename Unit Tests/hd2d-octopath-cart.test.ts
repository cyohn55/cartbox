/**
 * Contract tests for the committed "Octopath — Cartbox HD-2D" cart fixtures,
 * whose world is composed from the asset library (built by
 * `scripts/build-hd2d-octopath.mjs`).
 *
 * These validate the ACTUAL shipped fixtures — the `.tic` bytes and the world
 * sidecar — rather than any in-test literals: every sprite id the sidecar
 * references must be a legal 32×32 tile-block base, and the `.tic` must actually
 * carry baked, non-empty art in that block. So the test proves the sidecar points
 * at real library art baked into the sheet, and would fail if a rebake dropped a
 * block or the sidecar drifted to reference an empty one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseWorldScene } from "@cartbox/player";

const fixture = (rel: string) =>
  fileURLToPath(new URL(`../scripts/fixtures/${rel}`, import.meta.url));

const TILES_PER_SIDE = 4;
const SHEET_COLS = 16;
const TILE_BYTES = 32; // 8×8 at 4bpp
const CHUNK_TILES = 1;
const CHUNK_PALETTE = 12;

/** Parse a .tic into its chunks (type/bank/data). */
function parseChunks(bytes: Uint8Array): Array<{ type: number; bank: number; data: Uint8Array }> {
  const chunks: Array<{ type: number; bank: number; data: Uint8Array }> = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset]!;
    const type = header & 0x1f;
    const bank = (header >> 5) & 0x7;
    const size = bytes[offset + 1]! | (bytes[offset + 2]! << 8) | (bytes[offset + 3]! << 16);
    const start = offset + 4;
    chunks.push({ type, bank, data: bytes.slice(start, start + size) });
    offset = start + size;
  }
  return chunks;
}

/** Is `id` a legal base for a tilesPerSide×tilesPerSide block in a 16-wide sheet?
 *  A block occupies 4 columns and 4 rows, so its base column and row must both
 *  leave room for the block, and the base tile must align to a block cell. */
function isLegalBlockBase(id: number): boolean {
  if (id < 0 || !Number.isInteger(id)) return false;
  const col = id % SHEET_COLS;
  const row = Math.floor(id / SHEET_COLS);
  return col % TILES_PER_SIDE === 0 && row % TILES_PER_SIDE === 0 && col + TILES_PER_SIDE <= SHEET_COLS;
}

/** Count non-zero (non-transparent) pixels in the 4×4 tile block at `base`. */
function nonEmptyPixels(tiles: Uint8Array, base: number): number {
  let count = 0;
  for (let ty = 0; ty < TILES_PER_SIDE; ty += 1) {
    for (let tx = 0; tx < TILES_PER_SIDE; tx += 1) {
      const tileIndex = base + ty * SHEET_COLS + tx;
      for (let p = 0; p < 64; p += 1) {
        const byte = tiles[tileIndex * TILE_BYTES + (p >> 1)] ?? 0;
        const idx = p & 1 ? (byte >> 4) & 0x0f : byte & 0x0f;
        if (idx !== 0) count += 1;
      }
    }
  }
  return count;
}

describe("Octopath cart fixtures (library-composed world)", () => {
  const worldRaw = readFileSync(fixture("hd2d-octopath.world.json"), "utf8");
  const ticBytes = new Uint8Array(readFileSync(fixture("hd2d-octopath.tic")));
  const scene = parseWorldScene(worldRaw);
  const chunks = parseChunks(ticBytes);
  const tiles = chunks.find((c) => c.type === CHUNK_TILES && c.bank === 0)?.data ?? new Uint8Array();

  it("parses as a valid 8×8, 4-tiles-per-side world", () => {
    expect(scene).not.toBeNull();
    expect(scene!.cols).toBe(8);
    expect(scene!.rows).toBe(8);
    expect(scene!.tilesPerSide).toBe(TILES_PER_SIDE);
    expect(scene!.cells).toHaveLength(scene!.cols * scene!.rows);
  });

  it("carries a 16-colour palette and a non-empty page-0 tile sheet", () => {
    const palette = chunks.find((c) => c.type === CHUNK_PALETTE);
    expect(palette?.data.length).toBe(16 * 3);
    expect(tiles.length).toBeGreaterThan(0);
  });

  it("references only legal block bases, each backed by baked art in the .tic", () => {
    const referenced = new Set<number>();
    for (const cell of scene!.cells) referenced.add(cell.sprite);
    for (const prop of scene!.props) referenced.add(prop.sprite);
    for (const bb of scene!.billboards) referenced.add(bb.sprite);

    expect(referenced.size).toBeGreaterThan(0);
    for (const id of referenced) {
      expect(isLegalBlockBase(id), `sprite id ${id} must be a legal 32×32 block base`).toBe(true);
      expect(nonEmptyPixels(tiles, id), `block ${id} must carry baked art`).toBeGreaterThan(0);
    }
  });

  it("uses a variety of terrain tiles and scenery, not a single repeated block", () => {
    const terrain = new Set(scene!.cells.map((c) => c.sprite));
    const propArt = new Set(scene!.props.map((p) => p.sprite));
    // The village draws on several distinct library tiles and several props.
    expect(terrain.size).toBeGreaterThanOrEqual(3);
    expect(propArt.size).toBeGreaterThanOrEqual(4);
  });

  it("places every prop within the world's grid footprint", () => {
    for (const prop of scene!.props) {
      expect(prop.x).toBeGreaterThanOrEqual(0);
      expect(prop.x).toBeLessThanOrEqual(scene!.cols);
      expect(prop.z).toBeGreaterThanOrEqual(0);
      expect(prop.z).toBeLessThanOrEqual(scene!.rows);
    }
  });
});
