/**
 * A paintable 8x8 surface the pixel canvas edits. SpriteSheet already matches
 * this shape (albedo); NormalSurface adapts a NormalMap (direction indices) and
 * MaterialSurface adapts a MaterialMap (height/specular/roughness ramp levels),
 * so the same canvas paints any of them — the value is a palette/direction/ramp
 * index, and cssColor turns it into a swatch colour.
 */

import { MaterialMap, NormalMap, normalColorHex, type SpritePage } from "@cartbox/editor";

export interface PaintSurface {
  readonly tileSize: number;
  getPixel(page: SpritePage, tile: number, x: number, y: number): number;
  setPixel(page: SpritePage, tile: number, x: number, y: number, value: number): void;
  fill(page: SpritePage, tile: number, x: number, y: number, value: number): void;
  cssColor(value: number): string;
}

/** Flood-fills a surface's contiguous region of one value with another. Shared
 * by every non-albedo surface so the bucket tool behaves identically. */
export function floodFill(
  surface: PaintSurface,
  page: SpritePage,
  tile: number,
  x: number,
  y: number,
  value: number,
): void {
  const target = surface.getPixel(page, tile, x, y);
  if (target === value) return;
  const stack: Array<[number, number]> = [[x, y]];
  while (stack.length > 0) {
    const [px, py] = stack.pop()!;
    if (px < 0 || px >= surface.tileSize || py < 0 || py >= surface.tileSize) continue;
    if (surface.getPixel(page, tile, px, py) !== target) continue;
    surface.setPixel(page, tile, px, py, value);
    stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
}

/** Adapts a NormalMap to the paint surface: values are direction indices. */
export class NormalSurface implements PaintSurface {
  constructor(private readonly normals: NormalMap, readonly tileSize: number) {}

  getPixel(page: SpritePage, tile: number, x: number, y: number): number {
    return this.normals.getDirection(page, tile, x, y);
  }

  setPixel(page: SpritePage, tile: number, x: number, y: number, value: number): void {
    this.normals.setDirection(page, tile, x, y, value);
  }

  fill(page: SpritePage, tile: number, x: number, y: number, value: number): void {
    floodFill(this, page, tile, x, y, value);
  }

  cssColor(value: number): string {
    return normalColorHex(value);
  }
}

/** Adapts a MaterialMap to the paint surface: values are ramp levels, shown as
 * greyscale (dark = low, white = high). */
export class MaterialSurface implements PaintSurface {
  constructor(private readonly map: MaterialMap, readonly tileSize: number) {}

  getPixel(page: SpritePage, tile: number, x: number, y: number): number {
    return this.map.getValue(page, tile, x, y);
  }

  setPixel(page: SpritePage, tile: number, x: number, y: number, value: number): void {
    this.map.setValue(page, tile, x, y, value);
  }

  fill(page: SpritePage, tile: number, x: number, y: number, value: number): void {
    floodFill(this, page, tile, x, y, value);
  }

  cssColor(value: number): string {
    return this.map.colorHex(value);
  }
}
