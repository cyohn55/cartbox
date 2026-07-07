/**
 * TileMap — the editor-facing view of the cart's map memory. Each cell holds a
 * tile index into the tiles page (page 0); the map editor stamps those indices
 * and renders each cell by drawing the referenced tile. Pure (no DOM), like
 * SpriteSheet, so the UI and the tests drive it identically.
 */

import {
  CartEngine,
} from "../engine/CartEngine";

export class TileMap {
  // Map dimensions come from the engine's console model.
  readonly width: number;
  readonly height: number;
  readonly screenWidth: number;
  readonly screenHeight: number;

  constructor(private readonly engine: CartEngine) {
    const model = engine.model();
    this.width = model.mapWidth;
    this.height = model.mapHeight;
    this.screenWidth = model.screenWidth;
    this.screenHeight = model.screenHeight;
  }

  getCell(x: number, y: number): number {
    return this.engine.getMapCell(x, y);
  }

  setCell(x: number, y: number, tile: number): void {
    this.engine.setMapCell(x, y, tile);
  }

  /** Flood-fill the contiguous region of cells sharing the start cell's tile. */
  fill(x: number, y: number, tile: number): void {
    const target = this.engine.getMapCell(x, y);
    if (target === tile) return;

    const stack: Array<[number, number]> = [[x, y]];
    while (stack.length > 0) {
      const [cx, cy] = stack.pop()!;
      if (cx < 0 || cx >= this.width || cy < 0 || cy >= this.height) continue;
      if (this.engine.getMapCell(cx, cy) !== target) continue;
      this.engine.setMapCell(cx, cy, tile);
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  /** Which 30x17 screen a cell falls in, as [column, row]. */
  screenOf(x: number, y: number): [number, number] {
    return [Math.floor(x / this.screenWidth), Math.floor(y / this.screenHeight)];
  }
}
