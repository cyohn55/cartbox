/**
 * NormalMap — the editor-facing view of the primary sprite bank's normals,
 * stored in the cart's normal bank (see NORMAL_BANK). Pure, like the other
 * models: read and write a per-pixel direction index, and resolve it to a unit
 * normal for lighting.
 */

import { CartEngine, SpritePage } from "../engine/CartEngine";
import { NORMAL_DIRECTION_COUNT, normalColorHex, normalVector, type Vec3 } from "./normals";

export class NormalMap {
  readonly directionCount = NORMAL_DIRECTION_COUNT;

  constructor(private readonly engine: CartEngine) {}

  getDirection(page: SpritePage, tile: number, x: number, y: number): number {
    return this.engine.getNormal(page, tile, x, y);
  }

  setDirection(page: SpritePage, tile: number, x: number, y: number, direction: number): void {
    this.engine.setNormal(page, tile, x, y, direction);
  }

  /** The unit surface normal at a pixel. */
  vector(page: SpritePage, tile: number, x: number, y: number): Vec3 {
    return normalVector(this.engine.getNormal(page, tile, x, y));
  }

  /** Authoring swatch colour for a direction index. */
  colorHex(direction: number): string {
    return normalColorHex(direction);
  }
}
