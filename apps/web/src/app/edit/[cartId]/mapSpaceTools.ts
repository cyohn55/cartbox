"use client";

/**
 * What the map's 3D tools actually do, independent of how you are looking at the
 * map.
 *
 * There are two cameras — the orbiting view and the first-person one — and they
 * resolve a pointer to a cell in completely different ways (a rasteriser's pick
 * buffers versus a cast ray). What happens *after* that is identical: place a
 * cell against the face, carve one away, restyle one, stand a plane, adopt a
 * look, paint a texel. Keeping it here means the two views cannot drift into
 * behaving differently, and it is testable without either of them.
 *
 * A tool reports what it changed rather than calling back into React, so the
 * caller decides what to persist and what to redraw.
 */

import {
  CUBE_FACES,
  COLUMN_MATERIAL_NONE,
  geometryFor,
  type MapCellKind,
  type MapVoxelSpace,
} from "@cartbox/editor";

import { MAP_SPRITE_PAGE, materialSpriteTile, spriteTileMaterial } from "@/lib/mapAtlas";

import type { PaintSurface } from "./paintSurface";
import { isPixelSpaceTool, type MapSpaceTool } from "./maptools";

/** A resolved aim: the cell under the cursor, and where on its face it landed. */
export interface SpacePick {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Index into the cell's face table — cube faces for a plane cell. */
  readonly face: number;
  /** Face-local coordinates in 0..1, the same the texture fill samples with. */
  readonly u: number;
  readonly v: number;
  /** Whether the struck quad belongs to a plane cell rather than a solid block. */
  readonly plane: boolean;
}

/** Everything a tool needs to know besides where it was aimed. */
export interface SpaceToolContext {
  readonly space: MapVoxelSpace;
  /** Edge length of a sprite, in pixels. */
  readonly tileSize: number;
  /** How many sprites the page holds, for telling a sprite skin from a world one. */
  readonly tilesPerPage: number;
  /**
   * The surface pixel edits are written through — the composite material brush,
   * so a stroke on a face carries the colour's material profile exactly as a
   * stroke in the Sprites tab does.
   */
  readonly pixels: PaintSurface;
  /** Palette index new cells take, and pixel strokes paint with. */
  readonly colorIndex: number;
  /** Material armed for building, or {@link COLUMN_MATERIAL_NONE} for flat colour. */
  readonly material: number;
  /** The orientation the Plane tool stands its quad in. */
  readonly planeKind: MapCellKind;
  /** The sprite planes are made of, and that pixel tools paint. */
  readonly brushTile: number;
}

/** What a tool did, for the caller to persist and redraw. */
export interface SpaceToolResult {
  /** Cells were added, removed or restyled — the map needs saving. */
  readonly changedCells: boolean;
  /** A sprite's pixels changed — the sheet and the atlas need re-reading. */
  readonly changedPixels: boolean;
  /** A short sentence for the HUD, or null to clear it. */
  readonly note: string | null;
  /** The Picker's find, for the caller to arm. */
  readonly picked?: { readonly colorIndex: number; readonly material: number };
}

const NOTHING: SpaceToolResult = { changedCells: false, changedPixels: false, note: null };

/**
 * The site across the picked face. A plane's faces are cube faces whatever the
 * map's lattice, so it steps by a cube normal; a solid steps by its own
 * geometry's offset, which is what keeps a hexel landing on the FCC lattice.
 */
export function acrossFace(space: MapVoxelSpace, pick: SpacePick): [number, number, number] {
  const geometry = geometryFor(space.shape);
  const offset = pick.plane ? CUBE_FACES[pick.face]?.normal : geometry.faces[pick.face]?.offset;
  const [dx, dy, dz] = offset ?? [0, 0, 0];
  return [pick.x + dx, pick.y + dy, pick.z + dz];
}

/** The cell a tool would act on — the neighbour for the tools that build outward. */
export function targetOfTool(
  tool: MapSpaceTool,
  space: MapVoxelSpace,
  pick: SpacePick,
): [number, number, number] {
  return tool === "place" || tool === "plane" ? acrossFace(space, pick) : [pick.x, pick.y, pick.z];
}

/** Apply a tool at a resolved aim. The secondary (right) button removes. */
export function applySpaceTool(
  tool: MapSpaceTool,
  pick: SpacePick,
  secondary: boolean,
  context: SpaceToolContext,
): SpaceToolResult {
  if (isPixelSpaceTool(tool)) return paintTexel(tool, pick, context);

  switch (tool) {
    case "place":
      return secondary ? removeCell(pick, context) : placeCell(pick, "solid", context);
    case "plane":
      return secondary ? removeCell(pick, context) : placeCell(pick, context.planeKind, context);
    case "remove":
      return removeCell(pick, context);
    case "paintCell":
      return restyleCell(pick, secondary, context);
    case "picker": {
      const cell = context.space.cellAt(pick.x, pick.y, pick.z);
      if (!cell) return NOTHING;
      const tile = materialSpriteTile(cell.material, context.tilesPerPage);
      return {
        ...NOTHING,
        picked: { colorIndex: cell.colorIndex, material: cell.material },
        note: tile === null ? null : `Picked up sprite #${tile}.`,
      };
    }
    default:
      return NOTHING;
  }
}

function placeCell(pick: SpacePick, kind: MapCellKind, context: SpaceToolContext): SpaceToolResult {
  const { space } = context;
  const [x, y, z] = acrossFace(space, pick);
  if (!space.isValidSite(x, y, z)) {
    return {
      ...NOTHING,
      note: space.inBounds(x, y, z)
        ? "That site is off the hexel lattice — try an adjacent face."
        : "That is past the edge of the map.",
    };
  }

  // A plane *is* sprite art standing in space — a flat-coloured quad would just
  // be a rectangle — so it always wears the sprite the tile picker has armed.
  // Solid blocks take the material palette's choice instead.
  const skin = kind === "solid" ? context.material : spriteTileMaterial(context.brushTile);
  space.set(x, y, z, { colorIndex: context.colorIndex, material: skin, kind });
  return {
    changedCells: true,
    changedPixels: false,
    note: kind === "solid" ? null : `Stood sprite #${context.brushTile} here.`,
  };
}

function removeCell(pick: SpacePick, context: SpaceToolContext): SpaceToolResult {
  context.space.clear(pick.x, pick.y, pick.z);
  return { changedCells: true, changedPixels: false, note: null };
}

function restyleCell(pick: SpacePick, strip: boolean, context: SpaceToolContext): SpaceToolResult {
  if (!context.space.isFilled(pick.x, pick.y, pick.z)) return NOTHING;
  context.space.recolor(
    pick.x,
    pick.y,
    pick.z,
    context.colorIndex,
    strip ? COLUMN_MATERIAL_NONE : context.material,
  );
  return {
    changedCells: true,
    changedPixels: false,
    note: strip ? "Stripped back to flat colour." : null,
  };
}

/**
 * Paint one texel of the sprite skinning the picked face, at the point on that
 * face the cursor is over.
 *
 * A cell with no sprite has no pixels to paint, so one is given the armed sprite
 * *and* painted in the same action. Doing it in two clicks — skin, then paint —
 * reads as the tool silently ignoring the first click and then repainting the
 * whole face, which is not what "draw a pixel here" should feel like. The note
 * says what happened, so the change is explained rather than surprising.
 */
function paintTexel(tool: MapSpaceTool, pick: SpacePick, context: SpaceToolContext): SpaceToolResult {
  const { space, tileSize, tilesPerPage, pixels } = context;
  const cell = space.cellAt(pick.x, pick.y, pick.z);
  if (!cell) return NOTHING;

  let tile = materialSpriteTile(cell.material, tilesPerPage);
  let note: string | null = null;
  let changedCells = false;
  if (tile === null) {
    tile = context.brushTile;
    space.recolor(pick.x, pick.y, pick.z, cell.colorIndex, spriteTileMaterial(tile));
    changedCells = true;
    note = `This cell had no sprite, so it now wears #${tile} — and every cell wearing #${tile} shares these pixels.`;
  }

  const texelX = Math.max(0, Math.min(tileSize - 1, Math.floor(pick.u * tileSize)));
  const texelY = Math.max(0, Math.min(tileSize - 1, Math.floor(pick.v * tileSize)));
  const value = tool === "pixelEraser" ? 0 : context.colorIndex;
  if (tool === "pixelFill") pixels.fill(MAP_SPRITE_PAGE, tile, texelX, texelY, value);
  else pixels.setPixel(MAP_SPRITE_PAGE, tile, texelX, texelY, value);

  return { changedCells, changedPixels: true, note };
}
