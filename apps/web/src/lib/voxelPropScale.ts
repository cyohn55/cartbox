/**
 * Adapts placed backdrop props to a higher-resolution backdrop buffer.
 *
 * The backdrop renders into a low-resolution buffer that CSS upscales with
 * nearest-neighbour, so one buffer pixel becomes several screen pixels. A prop's
 * vertical bob is composited at whole-buffer-pixel positions, which at that
 * upscale means the prop *hops* a chunk of screen pixels per step instead of
 * gliding — the "stepping up and down" artifact.
 *
 * Raising the buffer resolution by an integer factor shrinks each buffer pixel,
 * so the same bob advances in finer sub-steps and reads as smooth motion. To
 * keep every prop the same on-screen size and its bob the same visual height in
 * that larger buffer, the per-voxel `cell` and the bob `amplitude` scale by the
 * same factor; placement (`fx`, `fy`) is a buffer *fraction*, so it is already
 * resolution-independent and left untouched. Cell stays an integer (the factor
 * is an integer) so each prop's tile canvas keeps an integer pixel size.
 *
 * Pure and DOM-free — it only rewrites plain numeric fields and shares each
 * prop's immutable voxel model by reference — so both render paths (CPU and
 * WebGPU) and the unit tests consume identical, deterministically scaled props.
 */

import type { VoxelProp } from "./retroVoxels";

/**
 * Return copies of `props` sized for a backdrop buffer scaled by `scale`. A
 * `scale` of 1 is the identity (fresh copies, originals unmodified).
 *
 * @param scale Positive integer buffer magnification (e.g. 2 = a 2× buffer).
 * @throws RangeError if `scale` is not a positive integer.
 */
export function scaleVoxelProps(props: readonly VoxelProp[], scale: number): VoxelProp[] {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new RangeError(`Backdrop resolution scale must be a positive integer, received ${scale}`);
  }

  return props.map((prop) => ({
    ...prop,
    cell: prop.cell * scale,
    motion: { ...prop.motion, bobAmplitude: prop.motion.bobAmplitude * scale },
  }));
}
