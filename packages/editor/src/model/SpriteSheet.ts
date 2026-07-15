/**
 * SpriteSheet — the editor-facing view of the cart's sprite memory. It is pure
 * (no DOM), so both the React UI and the unit tests drive it the same way: read
 * and write palette indices, resolve those indices to CSS colours, and rasterise
 * a tile to RGBA for a canvas. All state lives in the CartEngine underneath;
 * this class only interprets it.
 */

import type { CartEngine, SpritePage } from "../engine/CartEngine";
import { rgbToHex } from "./palette";
import type { Rgb } from "./paletteImport";

/** An RGBA image the sprite sheet can import from or export to. */
export interface SheetImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** A page rendered as palette indices (one byte per pixel) for indexed export. */
export interface IndexedImage {
  indices: Uint8Array;
  width: number;
  height: number;
}

export class SpriteSheet {
  // Dimensions come from the engine's console model, not hardwired constants.
  readonly tileSize: number;
  readonly tilesPerPage: number;
  readonly paletteSize: number;
  readonly sheetCols: number;
  /** A page rendered as an image is `sheetSize` x `sheetSize` pixels. */
  readonly sheetSize: number;
  private readonly pixelsPerTile: number;

  constructor(private readonly engine: CartEngine) {
    const model = engine.model();
    this.tileSize = model.tileSize;
    this.tilesPerPage = model.tilesPerPage;
    this.paletteSize = model.paletteSize;
    this.sheetCols = model.sheetCols;
    this.sheetSize = model.sheetCols * model.tileSize;
    this.pixelsPerTile = model.tileSize * model.tileSize;
  }

  getPixel(page: SpritePage, tile: number, x: number, y: number): number {
    return this.engine.getPixel(page, tile, x, y);
  }

  setPixel(page: SpritePage, tile: number, x: number, y: number, colorIndex: number): void {
    this.engine.setPixel(page, tile, x, y, colorIndex);
  }

  /** Flood-fill the contiguous region of matching colour starting at (x, y). */
  fill(page: SpritePage, tile: number, x: number, y: number, colorIndex: number): void {
    const target = this.engine.getPixel(page, tile, x, y);
    if (target === colorIndex) return;

    const stack: Array<[number, number]> = [[x, y]];
    while (stack.length > 0) {
      const [px, py] = stack.pop()!;
      if (px < 0 || px >= this.tileSize || py < 0 || py >= this.tileSize) continue;
      if (this.engine.getPixel(page, tile, px, py) !== target) continue;
      this.engine.setPixel(page, tile, px, py, colorIndex);
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }

  /**
   * Overwrite palette entries from a list of RGB triplets (e.g. an imported
   * Lospec palette), starting at index 0 and clamped to the model's palette
   * size. Returns how many entries were applied so the UI can report it.
   */
  applyPalette(colors: ReadonlyArray<readonly [number, number, number]>): number {
    const count = Math.min(colors.length, this.paletteSize);
    for (let index = 0; index < count; index += 1) {
      const color = colors[index];
      if (!color) continue;
      const [red, green, blue] = color;
      this.engine.setPaletteColor(index, red, green, blue);
    }
    return count;
  }

  /** CSS colour for a palette index, e.g. `#ffcd75`. */
  cssColor(index: number): string {
    const palette = this.engine.getPalette();
    const base = index * 3;
    return rgbToHex(palette[base] ?? 0, palette[base + 1] ?? 0, palette[base + 2] ?? 0);
  }

  /** All palette entries as CSS colours, index order. */
  cssPalette(): string[] {
    return Array.from({ length: this.paletteSize }, (_unused, index) => this.cssColor(index));
  }

  /** All palette entries as RGB triplets, index order (for indexed export). */
  paletteRgb(): Rgb[] {
    const palette = this.engine.getPalette();
    return Array.from({ length: this.paletteSize }, (_unused, index) => {
      const base = index * 3;
      return [palette[base] ?? 0, palette[base + 1] ?? 0, palette[base + 2] ?? 0] as Rgb;
    });
  }

  /** Palette index whose colour is closest to an RGB triplet (squared distance). */
  nearestColorIndex(red: number, green: number, blue: number): number {
    const palette = this.engine.getPalette();
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < this.paletteSize; index += 1) {
      const base = index * 3;
      const dr = red - (palette[base] ?? 0);
      const dg = green - (palette[base + 1] ?? 0);
      const db = blue - (palette[base + 2] ?? 0);
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  }

  /**
   * Import an RGBA image into a page at a pixel offset: each pixel is snapped to
   * the nearest palette colour (transparent pixels become colour 0) and written
   * into the 8x8 tile grid. Anything past the page's `sheetSize` is cropped.
   */
  importImageAt(image: SheetImage, page: SpritePage, offsetX: number, offsetY: number): void {
    const limit = this.sheetSize;
    const width = Math.min(image.width, limit - offsetX);
    const height = Math.min(image.height, limit - offsetY);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const base = (y * image.width + x) * 4;
        const alpha = image.data[base + 3] ?? 0;
        const index =
          alpha < 128
            ? 0
            : this.nearestColorIndex(image.data[base] ?? 0, image.data[base + 1] ?? 0, image.data[base + 2] ?? 0);
        const canvasX = offsetX + x;
        const canvasY = offsetY + y;
        const tile = Math.floor(canvasY / this.tileSize) * this.sheetCols + Math.floor(canvasX / this.tileSize);
        this.setPixel(page, tile, canvasX % this.tileSize, canvasY % this.tileSize, index);
      }
    }
  }

  /**
   * Import an RGBA image into a page at the top-left origin (the common case).
   */
  importImage(image: SheetImage, page: SpritePage): void {
    this.importImageAt(image, page, 0, 0);
  }

  /**
   * Lay a run of same-size animation frames onto a page as consecutive tile
   * blocks — frame 0 top-left, each next frame in the next block slot going left
   * to right then wrapping down — so an imported animation becomes a sequence of
   * sprite tiles the cart can flip through (e.g. `spr(base + frame)`). Frames are
   * cropped to the page and any that no longer fit are skipped. A frame larger
   * than the whole sheet still imports its top-left region (`cropped: true`) so
   * an oversized source is never silently dropped. Returns the placed/skipped
   * counts, each frame's size in tiles, and whether cropping occurred.
   */
  importFrames(
    frames: ReadonlyArray<SheetImage>,
    page: SpritePage,
  ): { placed: number; skipped: number; tilesWide: number; tilesHigh: number; cropped: boolean } {
    const first = frames[0];
    if (!first) return { placed: 0, skipped: 0, tilesWide: 0, tilesHigh: 0, cropped: false };

    const tilesWide = Math.max(1, Math.ceil(first.width / this.tileSize));
    const tilesHigh = Math.max(1, Math.ceil(first.height / this.tileSize));
    const tileRows = Math.floor(this.tilesPerPage / this.sheetCols);
    // Clamp block counts to at least one so a frame bigger than the sheet still
    // gets the origin slot (cropped) instead of yielding zero capacity.
    const blocksPerRow = Math.max(1, Math.floor(this.sheetCols / tilesWide));
    const blockRows = Math.max(1, Math.floor(tileRows / tilesHigh));
    const capacity = blocksPerRow * blockRows;
    const cropped = first.width > this.sheetSize || first.height > this.sheetSize;

    let placed = 0;
    for (let index = 0; index < frames.length && index < capacity; index += 1) {
      const frame = frames[index];
      if (!frame) continue;
      const originX = (index % blocksPerRow) * tilesWide * this.tileSize;
      const originY = Math.floor(index / blocksPerRow) * tilesHigh * this.tileSize;
      // Stop once a block would start past the sheet (oversized frames overflow).
      if (originX >= this.sheetSize || originY >= this.sheetSize) break;
      this.importImageAt(frame, page, originX, originY);
      placed += 1;
    }
    return { placed, skipped: frames.length - placed, tilesWide, tilesHigh, cropped };
  }

  /** Render a whole page to one RGBA image (sheetSize x sheetSize) for export. */
  exportImage(page: SpritePage): SheetImage {
    const size = this.sheetSize;
    const data = new Uint8ClampedArray(size * size * 4);
    const tileRgba = new Uint8ClampedArray(this.pixelsPerTile * 4);
    for (let tile = 0; tile < this.tilesPerPage; tile += 1) {
      const originX = (tile % this.sheetCols) * this.tileSize;
      const originY = Math.floor(tile / this.sheetCols) * this.tileSize;
      this.renderTileRgba(page, tile, tileRgba);
      for (let y = 0; y < this.tileSize; y += 1) {
        for (let x = 0; x < this.tileSize; x += 1) {
          const source = (y * this.tileSize + x) * 4;
          const destination = ((originY + y) * size + (originX + x)) * 4;
          data[destination] = tileRgba[source] ?? 0;
          data[destination + 1] = tileRgba[source + 1] ?? 0;
          data[destination + 2] = tileRgba[source + 2] ?? 0;
          data[destination + 3] = tileRgba[source + 3] ?? 255;
        }
      }
    }
    return { data, width: size, height: size };
  }

  /**
   * Render a whole page as palette indices (one byte per pixel, sheetSize x
   * sheetSize), the form an indexed export (e.g. Aseprite) writes directly. This
   * preserves the exact palette index of every pixel, unlike RGBA export.
   */
  exportIndexed(page: SpritePage): IndexedImage {
    const size = this.sheetSize;
    const indices = new Uint8Array(size * size);
    const tileIndices = new Uint8Array(this.pixelsPerTile);
    for (let tile = 0; tile < this.tilesPerPage; tile += 1) {
      const originX = (tile % this.sheetCols) * this.tileSize;
      const originY = Math.floor(tile / this.sheetCols) * this.tileSize;
      this.engine.readTile(page, tile, tileIndices);
      for (let y = 0; y < this.tileSize; y += 1) {
        for (let x = 0; x < this.tileSize; x += 1) {
          indices[(originY + y) * size + (originX + x)] = tileIndices[y * this.tileSize + x] ?? 0;
        }
      }
    }
    return { indices, width: size, height: size };
  }

  /** Rasterise a tile to RGBA bytes (length this.pixelsPerTile * 4) for a canvas. */
  renderTileRgba(page: SpritePage, tile: number, out?: Uint8ClampedArray): Uint8ClampedArray {
    const target = out ?? new Uint8ClampedArray(this.pixelsPerTile * 4);
    const palette = this.engine.getPalette();
    const indices = this.engine.readTile(page, tile);
    for (let pixel = 0; pixel < this.pixelsPerTile; pixel += 1) {
      const paletteBase = (indices[pixel] ?? 0) * 3;
      const rgbaBase = pixel * 4;
      target[rgbaBase] = palette[paletteBase] ?? 0;
      target[rgbaBase + 1] = palette[paletteBase + 1] ?? 0;
      target[rgbaBase + 2] = palette[paletteBase + 2] ?? 0;
      target[rgbaBase + 3] = 255;
    }
    return target;
  }
}
