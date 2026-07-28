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

import type { CellShape, MapCellKind } from "@cartbox/editor";

import type { ToolDefinition } from "./toolCapabilities";

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

/** A map tool as the shared rail renders it; `hint` becomes its tooltip. */
export type MapToolDef = ToolDefinition<MapTool>;

/**
 * A map layer. Shares the rail's tool shape — the layer switch is itself a tool
 * rail, so a layer needs the same id/label/glyph/hint — and adds the tools that
 * layer offers.
 */
export interface MapLayerDef extends ToolDefinition<MapLayer> {
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
    hint: "Stamp tiles from the sprite sheet across the map grid.",
    tools: TILE_TOOLS,
  },
  {
    id: "pixels",
    label: "Pixels",
    glyph: "▪",
    hint: "Paint individual pixels into the tiles the map references.",
    tools: PIXEL_TOOLS,
  },
  {
    id: "voxels",
    label: "Voxels",
    glyph: "◼",
    hint: "Give the map height as cubes — raise, lower and paint columns.",
    tools: COLUMN_TOOLS,
  },
  {
    id: "hexels",
    label: "Hexels",
    glyph: "⬡",
    hint: "The same columns built from close-packed rhombic hexels.",
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

// --- The 3D view ------------------------------------------------------------
// The map is authored from two vantage points over one store: looking straight
// down at it, and standing inside it. The tools differ because the gestures do —
// from above you raise a whole column at a cell, from inside you place one block
// against the face you clicked — so each view declares its own table rather than
// bending one set of tools to mean two things.

/** Which vantage point the map stage is showing. */
export type MapViewMode = "top" | "space";

export const MAP_VIEW_MODES: readonly { id: MapViewMode; label: string; hint: string }[] = [
  { id: "top", label: "2D", hint: "Look straight down at the map and paint it as a grid." },
  { id: "space", label: "3D", hint: "Move through the map and build in it — place and remove cells on any face." },
];

/** Tools available while standing in the map. */
export type MapSpaceTool =
  | "place"
  | "remove"
  | "paintCell"
  | "plane"
  | "picker"
  | "pencil"
  | "pixelFill"
  | "pixelEraser";

export type MapSpaceToolDef = ToolDefinition<MapSpaceTool>;

/** Building tools: what the voxel and hexel layers offer in the 3D view. */
const SPACE_BUILD_TOOLS: readonly MapSpaceToolDef[] = [
  { id: "place", label: "Place", glyph: "▣", hint: "Grow a cell against the face you click. Right-click removes." },
  { id: "remove", label: "Remove", glyph: "⌫", hint: "Carve away the cell you click." },
  { id: "paintCell", label: "Paint", glyph: "◧", hint: "Recolour and re-skin the cell you click." },
  {
    id: "plane",
    label: "Plane",
    glyph: "▤",
    hint: "Stand a flat sprite quad against the face you click — grass, wires, banners.",
  },
  { id: "picker", label: "Picker", glyph: "⌖", hint: "Adopt the colour and skin of the cell you click." },
];

/**
 * Pixel tools: what the pixel layer offers in the 3D view. They paint the sprite
 * a cell is skinned with, on the face you clicked, at the texel under the cursor —
 * so a texture is touched up where it is actually seen.
 */
const SPACE_PIXEL_TOOLS: readonly MapSpaceToolDef[] = [
  { id: "pencil", label: "Pencil", glyph: "✎", hint: "Paint the pixel under the cursor, in place on the face." },
  { id: "pixelFill", label: "Fill", glyph: "▦", hint: "Flood the matching pixels of that face's sprite." },
  { id: "pixelEraser", label: "Eraser", glyph: "⌫", hint: "Paint pixels transparent, so the face shows through." },
];

/**
 * The 3D tools a layer offers on a map of a given cell shape.
 *
 * Planes are square quads standing across an axis, which only lands on the
 * integer lattice — a hexel's neighbours are all diagonal steps, so a plane
 * placed on one would sit off the lattice. Rather than let the tool fail on
 * every click, a hexel map simply does not offer it.
 */
export function spaceToolsFor(layer: MapLayer, shape: CellShape = "cube"): readonly MapSpaceToolDef[] {
  if (layer === "pixels") return SPACE_PIXEL_TOOLS;
  return shape === "hexel" ? SPACE_BUILD_TOOLS.filter((entry) => entry.id !== "plane") : SPACE_BUILD_TOOLS;
}

/** The default 3D tool for a layer: the first one it offers. */
export function defaultSpaceToolFor(layer: MapLayer): MapSpaceTool {
  return spaceToolsFor(layer)[0]!.id;
}

/** Whether a 3D tool paints sprite texels rather than placing or styling cells. */
export function isPixelSpaceTool(tool: MapSpaceTool): boolean {
  return tool === "pencil" || tool === "pixelFill" || tool === "pixelEraser";
}

/**
 * The layer the 3D view opens on when the current one has nothing to do there.
 * Tiles are the ground plan, authored from above; stepping into the map with that
 * layer selected would leave the rail with no usable tool at all.
 */
export function spaceLayerFor(layer: MapLayer): MapLayer {
  return layer === "tiles" ? "voxels" : layer;
}

/**
 * How the 3D stage is looking at the map. Orbiting keeps the whole build in
 * frame and is the better view for shaping terrain; walking puts you inside it at
 * eye level, which is the only way to judge what a place will actually feel like
 * — and the only way to reach the inside of something you have enclosed.
 */
export type MapCameraMode = "orbit" | "walk";

export const MAP_CAMERA_MODES: readonly { id: MapCameraMode; label: string; hint: string }[] = [
  { id: "orbit", label: "Orbit", hint: "Circle the map from outside and build on the faces you can see." },
  { id: "walk", label: "Walk", hint: "Stand in the map in first person: mouse to look, W A S D to move, Space and Shift for height." },
];

/** Render sizes the first-person view offers, as the rail selects them. */
export const WALK_DETAIL_LEVELS: readonly { id: number; label: string; hint: string }[] = [
  { id: 160, label: "S", hint: "Coarsest and fastest — best while you are getting somewhere." },
  { id: 224, label: "M", hint: "A balance of sharpness and frame rate." },
  { id: 320, label: "L", hint: "Sharpest, and the heaviest to cast." },
];

/** The plane orientations the Plane tool can stand, as the rail selects them. */
export const PLANE_KINDS: readonly { id: MapCellKind; label: string; hint: string }[] = [
  { id: "planeZ", label: "Z", hint: "A quad facing along the map's rows." },
  { id: "planeX", label: "X", hint: "A quad facing along the map's columns." },
  { id: "planeY", label: "Y", hint: "A quad lying flat — decals, puddles, ground detail." },
  { id: "cross", label: "✚", hint: "Two crossed quads — the shape grass and foliage are drawn with." },
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
  { label: "XL", cell: 40 },
];

/** Zoom index the pixel layer needs to be usable — a tile must be legible. */
export const PIXEL_ZOOM_INDEX = 3;
