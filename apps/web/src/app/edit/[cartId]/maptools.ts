/**
 * The Map tab's layers and the tools each one offers.
 *
 * A map is authored on four layers over the same grid: the tile art, the pixels
 * inside those tiles, and a column layer that gives the map height — as cubes or
 * as hexels. Each layer has its own tools, so the rail is driven from this table
 * rather than from a switch in the component, and a layer's tools can change
 * without touching the editor.
 *
 * Pure data — no DOM, no React — so the canvas, the editor and the tests all
 * read the same definitions.
 */

import type { CellShape } from "@cartbox/editor";

/** The four things the Map tab can author. */
export type MapLayer = "tiles" | "pixels" | "voxels" | "hexels";

/** Tools available across the map layers; each layer offers a subset. */
export type MapTool =
  | "stamp"
  | "eraser"
  | "fill"
  | "pencil"
  | "pixelFill"
  | "raise"
  | "lower"
  | "paint"
  | "flatten";

export interface MapToolDef {
  id: MapTool;
  label: string;
  glyph: string;
  /** What the tool does, shown as its tooltip. */
  hint: string;
}

export interface MapLayerDef {
  id: MapLayer;
  label: string;
  glyph: string;
  /** One-line description shown under the layer switch. */
  description: string;
  tools: readonly MapToolDef[];
}

const TILE_TOOLS: readonly MapToolDef[] = [
  { id: "stamp", label: "Stamp", glyph: "▣", hint: "Stamp the selected tile block onto the map." },
  { id: "eraser", label: "Eraser", glyph: "⌫", hint: "Clear cells back to tile 0." },
  { id: "fill", label: "Fill", glyph: "▦", hint: "Flood the connected run of matching cells." },
];

const PIXEL_TOOLS: readonly MapToolDef[] = [
  { id: "pencil", label: "Pencil", glyph: "✎", hint: "Paint single pixels straight into the tile under the cursor." },
  { id: "eraser", label: "Eraser", glyph: "⌫", hint: "Paint pixels with colour 0." },
  { id: "pixelFill", label: "Fill", glyph: "▦", hint: "Flood the matching pixels within one tile." },
];

const COLUMN_TOOLS: readonly MapToolDef[] = [
  { id: "raise", label: "Raise", glyph: "▲", hint: "Raise the column under the cursor." },
  { id: "lower", label: "Lower", glyph: "▼", hint: "Lower the column; at zero the cell is cleared." },
  { id: "paint", label: "Paint", glyph: "◧", hint: "Recolour an existing column." },
  { id: "flatten", label: "Flatten", glyph: "▬", hint: "Set the column to the chosen height outright." },
  { id: "eraser", label: "Eraser", glyph: "⌫", hint: "Remove the column entirely." },
];

export const MAP_LAYERS: readonly MapLayerDef[] = [
  {
    id: "tiles",
    label: "Tiles",
    glyph: "▦",
    description: "Stamp tiles from the sprite sheet across the map grid.",
    tools: TILE_TOOLS,
  },
  {
    id: "pixels",
    label: "Pixels",
    glyph: "▪",
    description: "Paint individual pixels into the tiles the map references.",
    tools: PIXEL_TOOLS,
  },
  {
    id: "voxels",
    label: "Voxels",
    glyph: "◼",
    description: "Give the map height as cubes — raise, lower and paint columns.",
    tools: COLUMN_TOOLS,
  },
  {
    id: "hexels",
    label: "Hexels",
    glyph: "⬡",
    description: "The same columns built from close-packed rhombic hexels.",
    tools: COLUMN_TOOLS,
  },
];

/** The layer definition for an id, falling back to tiles so the UI always has one. */
export function layerDef(id: MapLayer): MapLayerDef {
  return MAP_LAYERS.find((layer) => layer.id === id) ?? MAP_LAYERS[0]!;
}

/** Whether a layer edits the column layer (voxels and hexels share one). */
export function isColumnLayer(layer: MapLayer): boolean {
  return layer === "voxels" || layer === "hexels";
}

/** The cell shape a column layer authors. */
export function shapeForLayer(layer: MapLayer): CellShape {
  return layer === "hexels" ? "hexel" : "cube";
}

/** The layer that authors a given cell shape — the inverse of {@link shapeForLayer}. */
export function layerForShape(shape: CellShape): MapLayer {
  return shape === "hexel" ? "hexels" : "voxels";
}

/** The default tool when a layer is selected: the first one it lists. */
export function defaultToolFor(layer: MapLayer): MapTool {
  return layerDef(layer).tools[0]!.id;
}

/** Zoom presets: cell size in screen pixels. */
export interface ZoomDef {
  label: string;
  cell: number;
}

export const MAP_ZOOMS: ZoomDef[] = [
  { label: "S", cell: 8 },
  { label: "M", cell: 16 },
  { label: "L", cell: 24 },
  { label: "XL", cell: 40 },
];

/** Zoom index the pixel layer needs to be usable — a tile must be legible. */
export const PIXEL_ZOOM_INDEX = 3;
