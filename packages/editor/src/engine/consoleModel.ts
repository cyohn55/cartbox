/**
 * Console model specs — the authoring-side dimensions each console model gives
 * the editor. A CartEngine reports its model via `model()`, and the editor
 * models (SpriteSheet, TileMap) read their sizes from it instead of hardwiring
 * the classic values. This is the seam a higher-resolution "pro" engine plugs
 * into: a different engine returns a different spec and every editor follows.
 *
 * The classic spec is exact (it matches the shipped TIC-80 core). The pro and
 * voxel specs are provisional until their engines exist; the runtime dimensions
 * live in @cartbox/player's model registry, which these mirror.
 */

export type ConsoleModelId = "classic" | "pro" | "voxel";
export type RasterKind = "raster2d" | "voxel3d";

export interface ConsoleModelSpec {
  id: ConsoleModelId;
  label: string;
  kind: RasterKind;
  /** Framebuffer size in pixels. */
  width: number;
  height: number;
  /** Sprite/tile edge in pixels. */
  tileSize: number;
  /**
   * Bits per tile pixel in cart memory (the engine's TIC_PALETTE_BPP): 4 = two
   * pixels per byte (Classic), 8 = one byte per pixel (Pro). This sets how tile
   * pixels are packed, independent of `paletteSize` (the authoring colour limit).
   */
  tilePixelBits: number;
  /** Palette entries. */
  paletteSize: number;
  /** Tiles per sprite page, and the number of pages. */
  tilesPerPage: number;
  spritePages: number;
  /** Sprite sheet width in tiles (a page renders sheetCols x sheetCols). */
  sheetCols: number;
  /** Map size and screen size, in tile cells. */
  mapWidth: number;
  mapHeight: number;
  screenWidth: number;
  screenHeight: number;
}

export const CLASSIC_MODEL: ConsoleModelSpec = {
  id: "classic",
  label: "Classic",
  kind: "raster2d",
  width: 240,
  height: 136,
  tileSize: 8,
  tilePixelBits: 4,
  paletteSize: 16,
  tilesPerPage: 256,
  spritePages: 2,
  sheetCols: 16,
  mapWidth: 240,
  mapHeight: 136,
  screenWidth: 30,
  screenHeight: 17,
};

/**
 * Pro — a 16:9 640x360 display (3x to 1080p, 6x to 4K), with 4x Classic's
 * palette (16 -> 64) and 2x its audio channels (4 -> 8, in the player spec).
 * Classic content is 30:17, so it can't fill a 16:9 frame; instead a Classic
 * cart composites at pixel-perfect integer 2x (480x272) pillarboxed inside the
 * Pro frame with even 80px side / 44px top-bottom margins.
 *
 * Sprite sheet: the built pro engine shares Classic's 128x128 sheet geometry
 * (16 cols, 256 tiles/page, 2 pages), but each tile is 8bpp so it carries 256
 * colors instead of 16. A larger sheet (the earlier provisional 384px/2304-tile
 * target) is NOT a constant bump: TIC-80's tile addressing uses power-of-2 masks
 * (128px sheet, 256 tiles/bank), and enlarging it means changing TIC_BANK_SPRITES
 * — which ripples into struct sizes, the cart binary format, and the editor shim.
 * Deferred to a focused, separately-verified change; these numbers reflect what
 * the engine actually stores today so authored tiles always fit.
 *
 * Core #defines the built pro engine uses: TIC80_WIDTH=640/TIC80_HEIGHT=360,
 * TIC_PALETTE_BPP=8 (256-capable framebuffer; paletteSize below is the authoring
 * limit), TIC_SOUND_CHANNELS=8, enlarged TIC_VRAM_SIZE/TIC_RAM_SIZE.
 */
export const PRO_MODEL: ConsoleModelSpec = {
  id: "pro",
  label: "Pro",
  kind: "raster2d",
  width: 640,
  height: 360,
  tileSize: 8,
  tilePixelBits: 8,
  paletteSize: 64,
  tilesPerPage: 256,
  spritePages: 2,
  sheetCols: 16,
  mapWidth: 640,
  mapHeight: 360,
  screenWidth: 80,
  screenHeight: 45,
};

/** Provisional — finalised when the voxel engine is built. */
export const VOXEL_MODEL: ConsoleModelSpec = {
  id: "voxel",
  label: "Voxel",
  kind: "voxel3d",
  width: 320,
  height: 180,
  tileSize: 8,
  tilePixelBits: 8,
  paletteSize: 256,
  tilesPerPage: 256,
  spritePages: 2,
  sheetCols: 16,
  mapWidth: 320,
  mapHeight: 176,
  screenWidth: 40,
  screenHeight: 22,
};

export const CONSOLE_MODELS: Record<ConsoleModelId, ConsoleModelSpec> = {
  classic: CLASSIC_MODEL,
  pro: PRO_MODEL,
  voxel: VOXEL_MODEL,
};
