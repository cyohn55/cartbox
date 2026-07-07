/**
 * Tile pixel codec — reads and writes a tile's palette-index pixels in cart
 * memory at the bit depth the console model uses. Classic packs two 4-bit pixels
 * per byte (low nibble = even pixel, high nibble = odd); Pro stores one 8-bit
 * pixel per byte. Isolating the packing here keeps WasmCartEngine bit-depth
 * agnostic and lets the packing be unit-tested against a plain byte buffer.
 */

export interface TilePixelCodec {
  /** Bytes one tile occupies in memory (pixelsPerTile × bits / 8). */
  readonly bytesPerTile: number;
  /** Palette index of pixel `pixelIndex` in the tile whose first byte is `tileBase`. */
  read(heap: Uint8Array, tileBase: number, pixelIndex: number): number;
  /** Write palette index `value` at pixel `pixelIndex` in the tile at `tileBase`. */
  write(heap: Uint8Array, tileBase: number, pixelIndex: number, value: number): void;
}

/** Build the codec for a given bit depth (4 or 8) and tile pixel count. */
export function createTilePixelCodec(pixelBits: number, pixelsPerTile: number): TilePixelCodec {
  if (pixelBits === 8) {
    return {
      bytesPerTile: pixelsPerTile,
      read: (heap, tileBase, pixelIndex) => heap[tileBase + pixelIndex] ?? 0,
      write: (heap, tileBase, pixelIndex, value) => {
        heap[tileBase + pixelIndex] = value & 0xff;
      },
    };
  }

  if (pixelBits === 4) {
    return {
      bytesPerTile: pixelsPerTile / 2,
      read: (heap, tileBase, pixelIndex) => {
        const byte = heap[tileBase + (pixelIndex >> 1)] ?? 0;
        return pixelIndex & 1 ? (byte >> 4) & 0x0f : byte & 0x0f;
      },
      write: (heap, tileBase, pixelIndex, value) => {
        const offset = tileBase + (pixelIndex >> 1);
        const byte = heap[offset] ?? 0;
        heap[offset] = pixelIndex & 1 ? (byte & 0x0f) | ((value & 0x0f) << 4) : (byte & 0xf0) | (value & 0x0f);
      },
    };
  }

  throw new Error(`Unsupported tile pixel depth: ${pixelBits} (expected 4 or 8)`);
}
