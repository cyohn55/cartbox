/**
 * Sprite rig — binds the segmented-character model to real cart sprites. Where
 * demoCharacterRig paints parts procedurally, a SpriteRig points each part at a
 * sprite block (a page + base tile + block size) and a depth, so authors rig the
 * sprites they actually draw. Reading a block honours the cart's colour key so
 * blank pixels stay transparent and parts composite cleanly.
 *
 * Pure and DOM-free like the rest of the render/model layer: it turns a rig plus
 * a SpriteSheet into compositor planes, and the same planes drive the CPU
 * preview and the tests.
 */

import type { SpritePage } from "../engine/CartEngine";
import type { ScenePlane } from "../render/layeredScene";
import type { SpriteSheet } from "./SpriteSheet";

/** One rig layer: a sprite block placed at a depth relative to the pivot. */
export interface SpriteRigPart {
  /** Part id from RIG_PART_TEMPLATES (e.g. "foreArm"). */
  readonly name: string;
  /** Which sprite page the block lives on. */
  readonly page: SpritePage;
  /** Top-left tile of the block. */
  readonly baseTile: number;
  /** Tiles per side of the block (1 = a single 8×8 tile). */
  readonly blockTiles: number;
  /** Depth relative to the pivot: negative = toward the camera (foreground). */
  readonly depthOffset: number;
  /** Anchor offset from the rig origin, world units. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** World units per source pixel — the part's on-screen size. */
  readonly unitsPerPixel: number;
}

/** A character rigged from sprite blocks, plus the shared pivot and colour key. */
export interface SpriteRig {
  readonly parts: readonly SpriteRigPart[];
  readonly pivotDepth: number;
  /** Palette index treated as transparent when reading blocks (TIC colour key). */
  readonly colorKey: number;
}

/** A composited sprite block: square RGBA plus its edge length in pixels. */
export interface BlockImage {
  readonly data: Uint8ClampedArray;
  readonly dim: number;
}

/** The standard part set, ordered back-to-front, with sensible default depths. */
export interface RigPartTemplate {
  readonly name: string;
  readonly depthOffset: number;
}

export const RIG_PART_TEMPLATES: readonly RigPartTemplate[] = [
  { name: "cape", depthOffset: 6 },
  { name: "backArm", depthOffset: 3 },
  { name: "torso", depthOffset: 0 },
  { name: "head", depthOffset: -1 },
  { name: "foreArm", depthOffset: -4 },
];

export const DEFAULT_RIG_PIVOT_DEPTH = 10;
export const DEFAULT_RIG_UNITS_PER_PIXEL = 0.06;

/** Index of a part name in the template order; unknown names sort to the end. */
function templateOrder(name: string): number {
  const index = RIG_PART_TEMPLATES.findIndex((template) => template.name === name);
  return index === -1 ? RIG_PART_TEMPLATES.length : index;
}

/**
 * Composite an N×N sprite block into one square RGBA buffer, mapping the colour
 * key to full transparency so blank sprite pixels don't paint over lower layers.
 * Block sub-tiles advance across the sheet row then wrap, matching the draw call.
 */
export function readBlockRgba(
  sheet: SpriteSheet,
  page: SpritePage,
  baseTile: number,
  blockTiles: number,
  colorKey = 0,
): BlockImage {
  const edge = sheet.tileSize;
  const dim = edge * blockTiles;
  const data = new Uint8ClampedArray(dim * dim * 4);
  const tileRgba = new Uint8ClampedArray(edge * edge * 4);

  for (let tileRow = 0; tileRow < blockTiles; tileRow += 1) {
    for (let tileColumn = 0; tileColumn < blockTiles; tileColumn += 1) {
      const subTile = baseTile + tileRow * sheet.sheetCols + tileColumn;
      sheet.renderTileRgba(page, subTile, tileRgba);
      for (let y = 0; y < edge; y += 1) {
        for (let x = 0; x < edge; x += 1) {
          const source = (y * edge + x) * 4;
          const target = ((tileRow * edge + y) * dim + (tileColumn * edge + x)) * 4;
          const transparent = sheet.getPixel(page, subTile, x, y) === colorKey;
          data[target] = tileRgba[source] ?? 0;
          data[target + 1] = tileRgba[source + 1] ?? 0;
          data[target + 2] = tileRgba[source + 2] ?? 0;
          data[target + 3] = transparent ? 0 : 255;
        }
      }
    }
  }
  return { data, dim };
}

/** Turn a sprite rig into compositor planes by reading each part's block. */
export function spriteRigToPlanes(
  sheet: SpriteSheet,
  rig: SpriteRig,
  originX = 0,
  originY = 0,
): ScenePlane[] {
  return rig.parts.map((part) => {
    const { data, dim } = readBlockRgba(sheet, part.page, part.baseTile, part.blockTiles, rig.colorKey);
    return {
      image: data,
      imageWidth: dim,
      imageHeight: dim,
      x: originX + part.offsetX,
      y: originY + part.offsetY,
      depth: rig.pivotDepth + part.depthOffset,
      unitsPerPixel: part.unitsPerPixel,
    };
  });
}

/** An empty rig to start authoring from. */
export function emptySpriteRig(pivotDepth = DEFAULT_RIG_PIVOT_DEPTH, colorKey = 0): SpriteRig {
  return { parts: [], pivotDepth, colorKey };
}

/** Add or replace a part (matched by name), keeping parts in template order. */
export function upsertRigPart(rig: SpriteRig, part: SpriteRigPart): SpriteRig {
  const others = rig.parts.filter((existing) => existing.name !== part.name);
  const parts = [...others, part].sort((a, b) => templateOrder(a.name) - templateOrder(b.name));
  return { ...rig, parts };
}

/** Remove the part with the given name, if present. */
export function removeRigPart(rig: SpriteRig, name: string): SpriteRig {
  return { ...rig, parts: rig.parts.filter((part) => part.name !== name) };
}

/** Look up a part by name, or undefined when the rig has no such part. */
export function findSpriteRigPart(rig: SpriteRig, name: string): SpriteRigPart | undefined {
  return rig.parts.find((part) => part.name === name);
}
