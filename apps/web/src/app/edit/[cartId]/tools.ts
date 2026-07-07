/** Drawing tools available in the sprite editor. */
export type Tool = "pencil" | "eraser" | "fill" | "wand" | "line" | "rect" | "ellipse";

/** Tools that drag out a shape previewed live and committed on release. */
export const SHAPE_TOOLS: ReadonlySet<Tool> = new Set<Tool>(["line", "rect", "ellipse"]);

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
