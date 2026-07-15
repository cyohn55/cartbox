/**
 * Minimal PNG metadata reader — validate the file signature and read the pixel
 * dimensions straight from the IHDR chunk, with no image-decoding library.
 *
 * Kept as its own pure module so the untrusted-upload gate in the handheld-art
 * route has one directly-testable place that reads bytes off the wire, mirroring
 * how `handheldArt.ts` isolates the stored-art gate. Reading only the header
 * keeps the server from ever decoding attacker-supplied image data.
 */

/** The 8-byte PNG file signature that opens every PNG. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True when the buffer begins with the PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * Read width/height from a PNG's IHDR chunk. In every valid PNG the IHDR is the
 * first chunk, so width is the big-endian uint32 at byte 16 and height at 20.
 * Returns null for a non-PNG, a header shorter than the IHDR fields, or
 * dimensions outside `[1, maxDimension]` on either axis.
 */
export function readPngSize(bytes: Uint8Array, maxDimension: number): { w: number; h: number } | null {
  if (!isPng(bytes) || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width < 1 || height < 1 || width > maxDimension || height > maxDimension) return null;
  return { w: width, h: height };
}
