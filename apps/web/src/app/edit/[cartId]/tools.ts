/** Drawing tools available in the sprite editor. */
export type Tool = "pencil" | "eraser" | "fill" | "wand" | "line" | "rect" | "ellipse";

/** Tools that drag out a shape previewed live and committed on release. */
export const SHAPE_TOOLS: ReadonlySet<Tool> = new Set<Tool>(["line", "rect", "ellipse"]);

/** Tools whose stroke thickness (brush size) the artist can adjust. */
export const WEIGHTED_TOOLS: ReadonlySet<Tool> = new Set<Tool>([
  "pencil",
  "eraser",
  "line",
  "rect",
  "ellipse",
]);

/** Tools whose colour tolerance (how much area they affect) the artist can adjust. */
export const TOLERANCE_TOOLS: ReadonlySet<Tool> = new Set<Tool>(["fill", "wand"]);

/** Brush size runs 1px (a single pixel) to this many pixels thick. */
export const MAX_BRUSH_WEIGHT = 8;
/** Tolerance is a 0..100 percentage of the maximum colour distance. */
export const MAX_TOLERANCE = 100;

export interface ToolDef {
  id: Tool;
  label: string;
  glyph: string;
}

export const TOOLS: ToolDef[] = [
  { id: "pencil", label: "Pencil", glyph: "✎" },
  { id: "eraser", label: "Eraser", glyph: "⌫" },
  { id: "fill", label: "Fill", glyph: "▦" },
  { id: "wand", label: "Magic wand", glyph: "✦" },
  { id: "line", label: "Line", glyph: "╱" },
  { id: "rect", label: "Rectangle", glyph: "▭" },
  { id: "ellipse", label: "Ellipse", glyph: "◯" },
];
