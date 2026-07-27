/**
 * The voxel sculptor's 3D tools.
 *
 * The 3D counterpart to {@link ./tools}: the same {@link ToolDefinition} shape,
 * so one rail renders either set, with the capability flags that decide which
 * sliders appear. What stays here is what only means something in a voxel grid —
 * the brush/tolerance ranges, and which tools can apply a material.
 */

import { toolIdsWith, type ToolDefinition } from "./toolCapabilities";

export type VoxelTool = "add" | "remove" | "paint" | "fill" | "select" | "wand" | "shape" | "material";

export const VOXEL_TOOLS: readonly ToolDefinition<VoxelTool>[] = [
  { id: "add", label: "Add", glyph: "＋", capabilities: { weighted: true } },
  { id: "remove", label: "Remove", glyph: "－", capabilities: { weighted: true } },
  { id: "paint", label: "Paint", glyph: "🖌", capabilities: { weighted: true } },
  { id: "fill", label: "Fill", glyph: "🪣", capabilities: { tolerant: true } },
  { id: "select", label: "Select", glyph: "⬚" },
  { id: "wand", label: "Wand", glyph: "✨", capabilities: { tolerant: true } },
  { id: "shape", label: "Shape", glyph: "◫" },
  { id: "material", label: "Tiles", glyph: "🧱" },
];

/**
 * Tools that stamp a solid cube "brush" around the target cell, sized by
 * {@link BRUSH_RADIUS_MIN}..{@link BRUSH_RADIUS_MAX}. Derived from the table so
 * it cannot drift from the slider the rail shows.
 */
export const BRUSH_TOOLS: ReadonlySet<VoxelTool> = toolIdsWith(VOXEL_TOOLS, "weighted");

/** Tools that flood by colour match, sized by a 0..100% tolerance. */
export const TOLERANCE_TOOLS: ReadonlySet<VoxelTool> = toolIdsWith(VOXEL_TOOLS, "tolerant");

// Radius 0 = a single voxel, the classic one-cube edit. Kept small so even the
// largest brush is a cheap stamp.
export const BRUSH_RADIUS_MIN = 0;
export const BRUSH_RADIUS_MAX = 8;
export const DEFAULT_BRUSH_RADIUS = 0;

// The Magic Wand and Paint Bucket share one colour-matching flood; this is its
// tolerance, as a 0..100% slider mapped to the 0..1 the flood expects. 0 = an
// exact colour match, higher grabs progressively more of a shaded region.
export const DEFAULT_TOLERANCE_PCT = 0;

/**
 * Tools that write cells, and so can apply the armed material. Keeping the
 * material palette visible for all of them is what lets "fill this run with
 * grass" or "stamp a brick shape" work at all — before, a material could only be
 * assigned one voxel at a time with the Tiles tool.
 *
 * Not a shared capability: applying a material is a voxel-grid idea with no 2D
 * counterpart, so it stays a local list rather than a term in the common
 * vocabulary every editor has to carry.
 */
export const MATERIAL_TOOLS: readonly VoxelTool[] = ["add", "paint", "fill", "shape", "select", "material"];
