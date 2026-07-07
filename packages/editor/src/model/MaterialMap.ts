/**
 * MaterialMap — the editor-facing view of a scalar material channel (height,
 * specular, roughness, or emissive) for the primary sprite bank, stored per-pixel in the
 * channel's bank (see MATERIAL_BANK). Pure, like the other models: read and write
 * a per-pixel level, and resolve a level to a greyscale swatch for the palette.
 *
 * Normals are the one non-scalar channel (a direction resolves to a vector) and
 * keep their own {@link NormalMap}; this covers the ramp-valued channels.
 */

import { MATERIAL_LEVELS } from "../engine/CartEngine";
import type { CartEngine, MaterialChannel, SpritePage } from "../engine/CartEngine";

export class MaterialMap {
  /** Number of distinct levels (0..levels-1). */
  readonly levels = MATERIAL_LEVELS;

  constructor(
    private readonly engine: CartEngine,
    readonly channel: MaterialChannel,
  ) {}

  getValue(page: SpritePage, tile: number, x: number, y: number): number {
    return this.engine.getMaterial(this.channel, page, tile, x, y);
  }

  setValue(page: SpritePage, tile: number, x: number, y: number, value: number): void {
    this.engine.setMaterial(this.channel, page, tile, x, y, value);
  }

  /** Greyscale swatch for a level: black at 0, white at the top level. */
  colorHex(level: number): string {
    const clamped = Math.max(0, Math.min(this.levels - 1, level));
    const channel = Math.round((clamped / (this.levels - 1)) * 255)
      .toString(16)
      .padStart(2, "0");
    return `#${channel}${channel}${channel}`;
  }
}
