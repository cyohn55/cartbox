/**
 * The retro-arcade props as rotatable 3D voxel models. Each original pixel-art
 * sprite (retroSprites.ts) is extruded into a chunky voxel slab that carries its
 * colour and emissive glow, so it can spin in 3D while its screens and LEDs keep
 * glowing. Placement, motion, and the pixel decode live in the dep-free
 * retroVoxelSpecs.ts; this module adds only the extrusion, which needs the
 * editor's voxel core.
 */

import { extrudeSprite, type VoxelModel, type ModelLight } from "@cartbox/editor";

import type { MotionParams } from "./bobSpin";
import { decodePropArt, type BackdropPropSet } from "./backdropProps";
import { BACKDROP_LIGHT as LIGHT_SPEC, PROP_SPECS, spriteToPixels } from "./retroVoxelSpecs";

/** A prop placed in the backdrop: its model, centre anchor, size, and motion. */
export interface VoxelProp {
  readonly model: VoxelModel;
  /** Centre position as a fraction of the backdrop buffer (0..1). */
  readonly fx: number;
  readonly fy: number;
  /** Backdrop-buffer pixels per voxel. */
  readonly cell: number;
  readonly motion: MotionParams;
}

/** The world-fixed key light the props are lit by. */
export const BACKDROP_LIGHT: ModelLight = LIGHT_SPEC;

/**
 * Build the placed voxel props from the code-defined defaults. Used as the
 * guaranteed fallback; the live backdrop prefers {@link propSetToVoxelProps}.
 */
export function buildRetroProps(): VoxelProp[] {
  return PROP_SPECS.map(({ sprite, depth, fx, fy, cell, motion }) => {
    const { albedo, emissive, width, height } = spriteToPixels(sprite);
    return {
      model: extrudeSprite(albedo, width, height, { depth, emissive }),
      fx,
      fy,
      cell,
      motion,
    };
  });
}

/**
 * Extrude an editable {@link BackdropPropSet} into placed voxel props. This is
 * the path the live backdrop uses once a published/working set is loaded, so
 * edits to the props flow straight into the rendered 3D scene.
 */
export function propSetToVoxelProps(set: BackdropPropSet): VoxelProp[] {
  return set.props.map((prop) => {
    const { albedo, emissive, width, height } = decodePropArt(prop.art);
    return {
      model: extrudeSprite(albedo, width, height, { depth: prop.depth, emissive }),
      fx: prop.fx,
      fy: prop.fy,
      cell: prop.cell,
      motion: prop.motion,
    };
  });
}
