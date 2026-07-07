/**
 * Framebuffer pixel operations. Pure and dependency-free so the scaling is
 * deterministic and unit-testable without an engine or an image encoder.
 */

/**
 * Upscales an RGBA framebuffer by an integer factor using nearest-neighbor
 * sampling. Nearest-neighbor (rather than smoothing) preserves the hard pixel
 * edges that define the fantasy-console look.
 *
 * @param source RGBA bytes, length must equal `srcWidth * srcHeight * 4`.
 * @param srcWidth Source width in pixels.
 * @param srcHeight Source height in pixels.
 * @param factor Positive integer scale factor.
 * @returns A new RGBA buffer of size `(srcWidth*factor) * (srcHeight*factor) * 4`.
 * @throws {RangeError} if the factor is not a positive integer or the source
 *         length does not match the stated dimensions.
 */
export function upscaleNearestNeighbor(
  source: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  factor: number,
): Uint8Array {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new RangeError(`factor must be a positive integer, got ${factor}`);
  }
  const expectedLength = srcWidth * srcHeight * 4;
  if (source.length !== expectedLength) {
    throw new RangeError(`source length ${source.length} does not match ${expectedLength}`);
  }

  const dstWidth = srcWidth * factor;
  const dstHeight = srcHeight * factor;
  const out = new Uint8Array(dstWidth * dstHeight * 4);

  for (let dstY = 0; dstY < dstHeight; dstY++) {
    const srcY = Math.floor(dstY / factor);
    for (let dstX = 0; dstX < dstWidth; dstX++) {
      const srcX = Math.floor(dstX / factor);
      const srcIndex = (srcY * srcWidth + srcX) * 4;
      const dstIndex = (dstY * dstWidth + dstX) * 4;
      out[dstIndex] = source[srcIndex] ?? 0;
      out[dstIndex + 1] = source[srcIndex + 1] ?? 0;
      out[dstIndex + 2] = source[srcIndex + 2] ?? 0;
      out[dstIndex + 3] = source[srcIndex + 3] ?? 0;
    }
  }
  return out;
}
