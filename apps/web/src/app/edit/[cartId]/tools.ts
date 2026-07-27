/**
 * The sprite editor's 2D drawing tools.
 *
 * The table is the single source of truth: each tool declares the rail controls
 * it drives (see {@link ToolCapabilities}), and the sets below are derived from
 * it rather than maintained beside it — which is what stops a new tool from
 * being added to the palette but forgotten in the brush-size list.
 */

import { toolIdsWith, type ToolDefinition } from "./toolCapabilities";

/** Drawing tools available in the sprite editor. */
export type Tool = "pencil" | "eraser" | "fill" | "wand" | "line" | "rect" | "ellipse";

export const TOOLS: readonly ToolDefinition<Tool>[] = [
  { id: "pencil", label: "Pencil", glyph: "✎", capabilities: { weighted: true } },
  { id: "eraser", label: "Eraser", glyph: "⌫", capabilities: { weighted: true } },
  { id: "fill", label: "Fill", glyph: "▦", capabilities: { tolerant: true } },
  { id: "wand", label: "Magic wand", glyph: "✦", capabilities: { tolerant: true } },
  { id: "line", label: "Line", glyph: "╱", capabilities: { weighted: true, dragged: true } },
  { id: "rect", label: "Rectangle", glyph: "▭", capabilities: { weighted: true, dragged: true } },
  { id: "ellipse", label: "Ellipse", glyph: "◯", capabilities: { weighted: true, dragged: true } },
];

/** Tools that drag out a shape previewed live and committed on release. */
export const SHAPE_TOOLS: ReadonlySet<Tool> = toolIdsWith(TOOLS, "dragged");

/** Tools whose stroke thickness (brush size) the artist can adjust. */
export const WEIGHTED_TOOLS: ReadonlySet<Tool> = toolIdsWith(TOOLS, "weighted");

/** Tools whose colour tolerance (how much area they affect) the artist can adjust. */
export const TOLERANCE_TOOLS: ReadonlySet<Tool> = toolIdsWith(TOOLS, "tolerant");

/** Brush size runs 1px (a single pixel) to this many pixels thick. */
export const MAX_BRUSH_WEIGHT = 8;
/** Tolerance is a 0..100 percentage of the maximum colour distance. */
export const MAX_TOLERANCE = 100;
