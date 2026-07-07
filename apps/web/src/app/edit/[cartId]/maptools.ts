/** Tools available in the map editor. */
export type MapTool = "stamp" | "eraser" | "fill";

export interface MapToolDef {
  id: MapTool;
  label: string;
  glyph: string;
}

export const MAP_TOOLS: MapToolDef[] = [
  { id: "stamp", label: "Stamp", glyph: "▣" },
  { id: "eraser", label: "Eraser", glyph: "⌫" },
  { id: "fill", label: "Fill", glyph: "▦" },
];

/** Zoom presets: cell size in screen pixels. */
export interface ZoomDef {
  label: string;
  cell: number;
}

export const MAP_ZOOMS: ZoomDef[] = [
  { label: "S", cell: 8 },
  { label: "M", cell: 16 },
  { label: "L", cell: 24 },
];
