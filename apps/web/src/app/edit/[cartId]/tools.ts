/**
 * The sprite editor's 2D drawing tools.
 *
 * The table is the single source of truth: each tool declares the rail controls
 * it drives (see {@link ToolCapabilities}) and the key that selects it, and the
 * sets below are derived from it rather than maintained beside it — which is
 * what stops a new tool from being added to the palette but forgotten in the
 * brush-size list, or bound to a key the help overlay never mentions.
 */

import { toolIdsWith, type ToolDefinition } from "./toolCapabilities";

/** Drawing tools available in the sprite editor. */
export type Tool = "pencil" | "eraser" | "fill" | "wand" | "marquee" | "picker" | "line" | "rect" | "ellipse";

export const TOOLS: readonly ToolDefinition<Tool>[] = [
  { id: "pencil", label: "Pencil", glyph: "✎", key: "b", capabilities: { weighted: true } },
  { id: "eraser", label: "Eraser", glyph: "⌫", key: "e", capabilities: { weighted: true } },
  { id: "fill", label: "Fill", glyph: "▦", key: "g", capabilities: { tolerant: true } },
  {
    id: "picker",
    label: "Pick colour",
    glyph: "⊙",
    key: "i",
    hint: "Take the colour under the cursor as the active one. Alt-click does this with any tool.",
  },
  { id: "wand", label: "Magic wand", glyph: "✦", key: "w", capabilities: { tolerant: true } },
  // Deliberately not `dragged`: that capability means "previews a shape while
  // dragging and paints it on release", and every tool carrying it must offer a
  // brush weight. The marquee drags out a box and paints nothing, so it handles
  // its own pointer gesture instead of borrowing the shape machinery.
  {
    id: "marquee",
    label: "Select",
    glyph: "▢",
    key: "m",
    hint: "Drag a box, then move it, copy it, flip it or rotate it.",
  },
  { id: "line", label: "Line", glyph: "╱", key: "l", capabilities: { weighted: true, dragged: true } },
  { id: "rect", label: "Rectangle", glyph: "▭", key: "u", capabilities: { weighted: true, dragged: true } },
  { id: "ellipse", label: "Ellipse", glyph: "◯", key: "o", capabilities: { weighted: true, dragged: true } },
];

/** Tools that drag out a shape previewed live and committed on release. */
export const SHAPE_TOOLS: ReadonlySet<Tool> = toolIdsWith(TOOLS, "dragged");

/** Tools whose stroke thickness (brush size) the artist can adjust. */
export const WEIGHTED_TOOLS: ReadonlySet<Tool> = toolIdsWith(TOOLS, "weighted");

/** Tools whose colour tolerance (how much area they affect) the artist can adjust. */
export const TOLERANCE_TOOLS: ReadonlySet<Tool> = toolIdsWith(TOOLS, "tolerant");

/** Tools that select rather than paint, so a stroke must not draw. */
export const SELECTION_TOOLS: ReadonlySet<Tool> = new Set<Tool>(["wand", "marquee"]);

/** Brush size runs 1px (a single pixel) to this many pixels thick. */
export const MAX_BRUSH_WEIGHT = 8;
/** Tolerance is a 0..100 percentage of the maximum colour distance. */
export const MAX_TOLERANCE = 100;

/** The single-key bindings, for the shortcut handler and the help overlay. */
export const SPRITE_TOOL_SHORTCUTS: ReadonlyArray<{ key: string; tool: Tool; label: string }> = TOOLS.filter(
  (tool): tool is ToolDefinition<Tool> & { key: string } => typeof tool.key === "string",
).map((tool) => ({ key: tool.key, tool: tool.id, label: tool.label }));
