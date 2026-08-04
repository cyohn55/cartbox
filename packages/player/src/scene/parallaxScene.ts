/**
 * Gap #3 — a runtime parallax + atmosphere compositor.
 *
 * The editor already has a preview-only layered-scene compositor
 * (packages/editor/src/render/layeredScene.ts) with parallax projection, but no
 * *aerial perspective*: the thing that makes REPLACED / THE LAST NIGHT read as
 * deep space rather than stacked stickers — distant layers go dimmer, bluer,
 * lower-contrast and haze toward the sky. Carts hand-roll parallax scroll in Lua
 * today; the atmosphere is the hard part they can't easily fake.
 *
 * This module is the reusable core of the runtime system: pure, DOM-free,
 * RGBA-in / RGBA-out (same shape as renderLitRgba / the editor compositor), so it
 * can be unit-tested and later driven by a cart-facing SDK/sidecar and composited
 * ahead of the lighting + post-FX passes. Intended app home:
 * packages/player/src/scene/parallaxScene.ts.
 */

export type Rgb = readonly [number, number, number];

/** One depth layer of the scene. */
export interface ParallaxLayer {
  /** Straight-alpha RGBA pixels, width*height*4 bytes. */
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  /**
   * Depth, 0 (nearest, on the camera plane) .. 1 (farthest, at the horizon).
   * Drives both how little the layer parallaxes and how much atmosphere it takes.
   */
  depth: number;
  /**
   * How much the layer shifts with the camera: 1 = locked to the world (full
   * parallax), 0 = locked to the screen. Defaults to `1 - depth` so near layers
   * slide under far ones without the author computing anything.
   */
  parallax?: number;
  /** Tile the layer horizontally when the camera scrolls past its edge. Default true. */
  wrapX?: boolean;
  /** Vertical placement in the output, in pixels (align a horizon). Default 0. */
  offsetY?: number;
  /**
   * Horizontal placement in the output, in pixels, ADDED to the parallax shift.
   * Default 0. Lets a layer drift independently of the camera (e.g. animated fog).
   */
  offsetX?: number;
  /** Layer-wide alpha multiplier, 0..1. Default 1 (fully as authored). */
  opacity?: number;
  /**
   * Layer-wide RGB gain. Default 1. Values > 1 brighten the layer's contribution
   * (an animated emissive glow), which the post-FX bloom pass then picks up.
   */
  emissive?: number;
  /**
   * The aerial-perspective haze is already baked into {@link pixels} (see
   * {@link prehazeLayers}), so compositing must not apply it again. A layer's haze
   * is frame-invariant — it depends only on the layer's depth and the scene
   * atmosphere — so the runtime bakes it once and skips it in the per-frame loop.
   */
  hazed?: boolean;
}

/** Aerial-perspective parameters, shared by the whole scene. */
export interface AtmosphereParams {
  /** The haze/sky colour distance fades toward (each channel 0..255). */
  fog: Rgb;
  /** 0..1 — how strongly the farthest layer is pulled toward `fog`. */
  density: number;
  /** 0..1 — how much colour the farthest layer loses (aerial desaturation). */
  desaturate: number;
  /** 0..1 — how much the farthest layer's contrast flattens (haze lifts blacks). */
  lift: number;
}

/** The camera, in world pixels; only its offset matters for parallax. */
export interface ParallaxCamera {
  x: number;
  y: number;
}

const clampUnit = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A layer's default parallax factor: near layers move fully, far ones barely. */
export function parallaxOf(layer: ParallaxLayer): number {
  return layer.parallax ?? clampUnit(1 - layer.depth);
}

/**
 * The aerial-perspective transform for a single colour at a given haze amount.
 * Order matters and mirrors how distance actually degrades a colour: desaturate
 * → lift contrast (raise blacks toward fog) → blend toward the fog colour. Pure;
 * returns a fresh triplet so it is trivially testable.
 */
export function hazeColor(rgb: Rgb, haze: number, atmosphere: AtmosphereParams): Rgb {
  const t = clampUnit(haze);
  const desat = atmosphere.desaturate * t;
  const lift = atmosphere.lift * t;
  const blend = atmosphere.density * t;
  const out: number[] = [rgb[0], rgb[1], rgb[2]];
  const luma = out[0]! * 0.299 + out[1]! * 0.587 + out[2]! * 0.114;
  for (let c = 0; c < 3; c += 1) {
    let v = out[c]!;
    v = lerp(v, luma, desat);                       // aerial desaturation
    v = lerp(v, lerp(v, atmosphere.fog[c]!, 0.5), lift); // flatten contrast toward fog
    v = lerp(v, atmosphere.fog[c]!, blend);         // haze blend
    out[c] = v;
  }
  return [out[0]!, out[1]!, out[2]!];
}

/**
 * Bake each layer's aerial-perspective haze into its pixels once, returning new
 * layers flagged {@link ParallaxLayer.hazed} so {@link composeParallax} skips the
 * per-pixel haze in the hot path.
 *
 * A layer's haze depends only on its depth and the (constant) atmosphere, so it
 * is identical every frame — computing it once here instead of per pixel per
 * frame is what keeps an N-layer scene inside the 60fps budget. The input layers
 * are not mutated; a layer that takes no haze is returned with its pixels shared.
 */
export function prehazeLayers(
  layers: readonly ParallaxLayer[],
  atmosphere: AtmosphereParams,
): ParallaxLayer[] {
  return layers.map((layer) => {
    const haze = clampUnit(layer.depth);
    if (haze <= 0) {
      return { ...layer, hazed: true }; // nearest layer: no haze to bake in
    }
    const src = layer.pixels;
    const pixels = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
      const [r, g, b] = hazeColor([src[i]!, src[i + 1]!, src[i + 2]!], haze, atmosphere);
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = src[i + 3]!; // alpha is untouched by haze
    }
    return { ...layer, pixels, hazed: true };
  });
}

/**
 * Composite parallax layers into `out` (outW×outH RGBA), far to near, applying
 * per-layer aerial perspective by depth. `out` should already hold the sky /
 * clear colour; layers blend over it by their own alpha.
 *
 * Parallax: a layer shifts by `-camera * parallaxOf(layer)`, so the nearest
 * layers slide fastest. Horizontal wrap tiles a layer seamlessly; vertical uses
 * `offsetY` and clips.
 */
export function composeParallax(
  out: Uint8ClampedArray,
  outW: number,
  outH: number,
  layers: readonly ParallaxLayer[],
  camera: ParallaxCamera,
  atmosphere: AtmosphereParams,
): void {
  const ordered = [...layers].sort((a, b) => b.depth - a.depth); // far first (painter's)
  for (const layer of ordered) {
    const factor = parallaxOf(layer);
    // Round the TOTAL shift (not just the camera term): a layer's offsetX/offsetY
    // can be fractional — an animation track drives them with an eased generator —
    // and a fractional shift makes the source index (sy*width+sx) fractional, which
    // reads `undefined` from the pixel array → NaN → a black band. Flooring to whole
    // pixels keeps sampling on the integer grid.
    const shiftX = Math.round(-camera.x * factor + (layer.offsetX ?? 0));
    const shiftY = Math.round(-camera.y * factor + (layer.offsetY ?? 0));
    const wrapX = layer.wrapX ?? true;
    // A pre-hazed layer already carries its aerial perspective in its pixels, so
    // skip the per-pixel haze here — this is the per-frame cost the runtime avoids.
    const haze = layer.hazed ? 0 : clampUnit(layer.depth);
    const opacity = layer.opacity ?? 1;
    const emissive = layer.emissive ?? 1;

    for (let y = 0; y < outH; y += 1) {
      let sy = y - shiftY;
      if (sy < 0 || sy >= layer.height) continue;
      for (let x = 0; x < outW; x += 1) {
        let sx = x - shiftX;
        if (wrapX) sx = ((sx % layer.width) + layer.width) % layer.width;
        else if (sx < 0 || sx >= layer.width) continue;

        const si = (sy * layer.width + sx) * 4;
        const alpha = (layer.pixels[si + 3]! / 255) * opacity;
        if (alpha <= 0) continue;

        const src: Rgb = [layer.pixels[si]!, layer.pixels[si + 1]!, layer.pixels[si + 2]!];
        const hazed = haze > 0 ? hazeColor(src, haze, atmosphere) : src;
        const di = (y * outW + x) * 4;
        // straight-alpha over (emissive gain brightens the source; the clamped
        // output array caps any overshoot, and bloom later blooms the hot pixels)
        out[di] = lerp(out[di]!, hazed[0] * emissive, alpha);
        out[di + 1] = lerp(out[di + 1]!, hazed[1] * emissive, alpha);
        out[di + 2] = lerp(out[di + 2]!, hazed[2] * emissive, alpha);
        out[di + 3] = 255;
      }
    }
  }
}
