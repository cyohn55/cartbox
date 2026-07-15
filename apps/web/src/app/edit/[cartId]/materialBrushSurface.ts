/**
 * MaterialBrushSurface — a paint surface whose value is an albedo palette index,
 * but whose every write fans out to the material channels according to that
 * colour's swatch profile. It is what makes a "highlight" colour paint albedo +
 * normal + height + specular + roughness + emissive in one stroke.
 *
 * Read side (getPixel/cssColor) delegates to the albedo surface, so the canvas
 * shows true colours and every tool that keys off pixel identity — flood fill,
 * magic wand, shape preview — behaves exactly as in the plain albedo layer. Only
 * the write side is enriched: a colour with an enabled profile also stamps its
 * channel values at the same pixel; a colour without one paints albedo alone.
 *
 * Because the channel surfaces address pixels the same way as the albedo surface
 * (parallel banks, same tile/x/y), this composes cleanly under SpriteBlockSurface
 * for multi-tile sprites: the block wrapper resolves the address once and this
 * surface fans that single address across the parallel banks.
 */

import type { SpritePage } from "@cartbox/editor";
import type { MaterialProfile } from "@cartbox/editor";

import { floodFill, type PaintSurface } from "./paintSurface";

/** The four ramp channels plus the normal channel a swatch stamps. */
export interface MaterialChannelSurfaces {
  readonly normal: PaintSurface;
  readonly height: PaintSurface;
  readonly specular: PaintSurface;
  readonly roughness: PaintSurface;
  readonly emissive: PaintSurface;
}

export class MaterialBrushSurface implements PaintSurface {
  readonly tileSize: number;

  constructor(
    /** The albedo surface — the read/display side and the palette-index domain. */
    private readonly albedo: PaintSurface,
    /** The material channel surfaces written when a colour's profile is enabled. */
    private readonly channels: MaterialChannelSurfaces,
    /** Resolves a palette index to the profile its brush should stamp. */
    private readonly profileFor: (colorIndex: number) => MaterialProfile,
  ) {
    this.tileSize = albedo.tileSize;
  }

  getPixel(page: SpritePage, tile: number, x: number, y: number): number {
    return this.albedo.getPixel(page, tile, x, y);
  }

  setPixel(page: SpritePage, tile: number, x: number, y: number, value: number): void {
    this.albedo.setPixel(page, tile, x, y, value);
    const profile = this.profileFor(value);
    if (!profile.enabled) return;
    this.channels.normal.setPixel(page, tile, x, y, profile.normal);
    this.channels.height.setPixel(page, tile, x, y, profile.height);
    this.channels.specular.setPixel(page, tile, x, y, profile.specular);
    this.channels.roughness.setPixel(page, tile, x, y, profile.roughness);
    this.channels.emissive.setPixel(page, tile, x, y, profile.emissive);
  }

  fill(page: SpritePage, tile: number, x: number, y: number, value: number): void {
    floodFill(this, page, tile, x, y, value);
  }

  cssColor(value: number): string {
    return this.albedo.cssColor(value);
  }
}
