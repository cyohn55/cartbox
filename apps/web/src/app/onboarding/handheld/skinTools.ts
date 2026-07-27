/**
 * The handheld skin editor's drawing tools.
 *
 * A superset of the sprite editor's tools — same pencil/eraser/fill/shapes, plus
 * an eyedropper and a pan grip the skin canvas needs — declared with the same
 * {@link ToolDefinition} shape so both the toolbar and the canvas read one table.
 *
 * They were previously two tables and two hand-written "which tools are
 * weighted?" sets, one in the toolbar and one in the canvas, which is precisely
 * the drift this consolidates. The markup stays local (this editor has its own
 * stylesheet, not the workbench rail's), so only the vocabulary is shared.
 */

import { toolIdsWith, type ToolDefinition } from "../../edit/[cartId]/toolCapabilities";

export type SkinTool = "pencil" | "eraser" | "fill" | "line" | "rect" | "ellipse" | "eyedropper" | "pan";

export const SKIN_TOOLS: readonly ToolDefinition<SkinTool>[] = [
  { id: "pencil", label: "Pencil", glyph: "✎", capabilities: { weighted: true } },
  { id: "eraser", label: "Eraser", glyph: "⌫", capabilities: { weighted: true } },
  { id: "fill", label: "Fill", glyph: "▦", capabilities: { tolerant: true } },
  { id: "line", label: "Line", glyph: "╱", capabilities: { weighted: true, dragged: true } },
  { id: "rect", label: "Rectangle", glyph: "▭", capabilities: { weighted: true, dragged: true } },
  { id: "ellipse", label: "Ellipse", glyph: "◯", capabilities: { weighted: true, dragged: true } },
  { id: "eyedropper", label: "Eyedropper", glyph: "⦿" },
  { id: "pan", label: "Pan", glyph: "✋" },
];

/** Tools that drag out a shape previewed live and committed on release. */
export const SHAPE_TOOLS: ReadonlySet<SkinTool> = toolIdsWith(SKIN_TOOLS, "dragged");

/** Tools whose stroke thickness the artist can adjust. */
export const WEIGHTED_TOOLS: ReadonlySet<SkinTool> = toolIdsWith(SKIN_TOOLS, "weighted");

/** Tools whose colour tolerance the artist can adjust. */
export const TOLERANCE_TOOLS: ReadonlySet<SkinTool> = toolIdsWith(SKIN_TOOLS, "tolerant");
