/**
 * AnimatedForegroundSurface — a display surface that draws animated placements
 * (foreground set-dressing) over the presented frame, then hands off to an inner
 * surface.
 *
 * Each placement is one frame of an AnimClip drawn from the cart's OWN sprite
 * sheet (via a {@link SpriteRegionSource}) at a position, scale, and opacity the
 * animation resolved for this tick (see animPlayer's `evaluate`). It decorates any
 * {@link DisplaySurface} and sits INSIDE the scene backdrop but OUTSIDE lighting/
 * post-FX: placements land in front of the cart + parallax backdrop, and the
 * inner surface's lighting/FX finish them together with the rest of the frame.
 *
 * Region pixels are static for the cart's life, so they are read once and cached;
 * per-frame cost is a frame copy plus the composited placement footprints (nothing
 * when there are no placements — the pass-through fast path).
 */

import type { DisplaySurface } from "../display.js";
import type { RegionImage, SpriteRegionSource } from "../scene/sceneRender.js";
import type { ResolvedPlacement } from "./animPlayer.js";

export class AnimatedForegroundSurface implements DisplaySurface {
  private placements: readonly ResolvedPlacement[] = [];
  /** Static region pixels cached by region key (page:tile:tilesW:tilesH). */
  private readonly regionCache = new Map<string, RegionImage>();
  private readonly output: Uint8ClampedArray;
  private readonly presented: Uint8Array;

  constructor(
    private readonly inner: DisplaySurface,
    private readonly width: number,
    private readonly height: number,
    private readonly source: SpriteRegionSource,
  ) {
    this.output = new Uint8ClampedArray(width * height * 4);
    this.presented = new Uint8Array(this.output.buffer);
  }

  /** Set the placements resolved for this frame (empty for none). */
  setPlacements(placements: readonly ResolvedPlacement[]): void {
    this.placements = placements;
  }

  private region(placement: ResolvedPlacement): RegionImage {
    const { page, tile, tilesW, tilesH } = placement.region;
    const key = `${page}:${tile}:${tilesW}:${tilesH}`;
    let image = this.regionCache.get(key);
    if (!image) {
      image = this.source.readRegion(page, tile, tilesW, tilesH);
      this.regionCache.set(key, image);
    }
    return image;
  }

  blit(rgba: Uint8Array): void {
    if (this.placements.length === 0) {
      this.inner.blit(rgba); // nothing to draw — pass the frame straight through
      return;
    }
    this.output.set(rgba);
    // Painter's order: far placements first so nearer ones land on top.
    const ordered = [...this.placements].sort((a, b) => b.depth - a.depth);
    for (const placement of ordered) this.drawPlacement(placement);
    this.inner.blit(this.presented);
  }

  /** Nearest-neighbour scale + straight-alpha composite of one placement. */
  private drawPlacement(placement: ResolvedPlacement): void {
    const opacity = Math.max(0, Math.min(1, placement.opacity));
    if (opacity <= 0) return;
    const scale = placement.scale > 0 ? placement.scale : 1;

    const image = this.region(placement);
    const destWidth = Math.max(1, Math.round(image.width * scale));
    const destHeight = Math.max(1, Math.round(image.height * scale));
    const originX = Math.round(placement.x);
    const originY = Math.round(placement.y);

    for (let dy = 0; dy < destHeight; dy += 1) {
      const y = originY + dy;
      if (y < 0 || y >= this.height) continue;
      const sy = Math.min(image.height - 1, Math.floor(dy / scale));
      for (let dx = 0; dx < destWidth; dx += 1) {
        const x = originX + dx;
        if (x < 0 || x >= this.width) continue;
        const sx = Math.min(image.width - 1, Math.floor(dx / scale));

        const si = (sy * image.width + sx) * 4;
        const alpha = (image.pixels[si + 3]! / 255) * opacity;
        if (alpha <= 0) continue;

        const di = (y * this.width + x) * 4;
        this.output[di] = lerp(this.output[di]!, image.pixels[si]!, alpha);
        this.output[di + 1] = lerp(this.output[di + 1]!, image.pixels[si + 1]!, alpha);
        this.output[di + 2] = lerp(this.output[di + 2]!, image.pixels[si + 2]!, alpha);
        this.output[di + 3] = 255;
      }
    }
  }

  destroy(): void {
    this.inner.destroy();
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
