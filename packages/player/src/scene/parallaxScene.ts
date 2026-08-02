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
    const shiftX = Math.round(-camera.x * factor);
    const shiftY = Math.round(-camera.y * factor) + (layer.offsetY ?? 0);
    const wrapX = layer.wrapX ?? true;
    const haze = clampUnit(layer.depth);

    for (let y = 0; y < outH; y += 1) {
      let sy = y - shiftY;
      if (sy < 0 || sy >= layer.height) continue;
      for (let x = 0; x < outW; x += 1) {
        let sx = x - shiftX;
        if (wrapX) sx = ((sx % layer.width) + layer.width) % layer.width;
        else if (sx < 0 || sx >= layer.width) continue;

        const si = (sy * layer.width + sx) * 4;
        const alpha = layer.pixels[si + 3]! / 255;
        if (alpha <= 0) continue;

        const src: Rgb = [layer.pixels[si]!, layer.pixels[si + 1]!, layer.pixels[si + 2]!];
        const hazed = haze > 0 ? hazeColor(src, haze, atmosphere) : src;
        const di = (y * outW + x) * 4;
        // straight-alpha over
        out[di] = lerp(out[di]!, hazed[0], alpha);
        out[di + 1] = lerp(out[di + 1]!, hazed[1], alpha);
        out[di + 2] = lerp(out[di + 2]!, hazed[2], alpha);
        out[di + 3] = 255;
      }
    }
  }
}
