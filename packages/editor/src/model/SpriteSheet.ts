/**
 * SpriteSheet — the editor-facing view of the cart's sprite memory. It is pure
 * (no DOM), so both the React UI and the unit tests drive it the same way: read
 * and write palette indices, resolve those indices to CSS colours, and rasterise
 * a tile to RGBA for a canvas. All state lives in the CartEngine underneath;
 * this class only interprets it.
 */

import { CartEngine, SpritePage } from "../engine/CartEngine";
import { rgbToHex } from "./palette";

/** An RGBA image the sprite sheet can import from or export to. */
export interface SheetImage {
  data: Uint8ClampedArray;
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
   * Import an RGBA image into a page: each pixel is snapped to the nearest
   * palette colour (transparent pixels become colour 0) and written into the
   * 8x8 tile grid. The image is cropped to the page's `sheetSize`.
   */
  importImage(image: SheetImage, page: SpritePage): void {
    const limit = this.sheetSize;
    const width = Math.min(image.width, limit);
    const height = Math.min(image.height, limit);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const base = (y * image.width + x) * 4;
        const alpha = image.data[base + 3] ?? 0;
        const index =
          alpha < 128
            ? 0
            : this.nearestColorIndex(image.data[base] ?? 0, image.data[base + 1] ?? 0, image.data[base + 2] ?? 0);
        const tile = Math.floor(y / this.tileSize) * this.sheetCols + Math.floor(x / this.tileSize);
        this.setPixel(page, tile, x % this.tileSize, y % this.tileSize, index);
      }
    }
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
