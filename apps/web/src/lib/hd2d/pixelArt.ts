// Tiny pixel-art authoring helpers — a straight-alpha RGBA canvas with a few
// primitives, used to hand-author the world's face tiles and the character's
// sprite layers for the HD-2D vertical slice. Pure and DOM-free so the browser
// preview and the unit tests build identical art.

export interface PixelCanvas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray; // RGBA, row-major, straight alpha
}

export type Rgb = readonly [number, number, number];

export function makeCanvas(width: number, height: number): PixelCanvas {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Set one pixel (no-op out of bounds). alpha defaults to fully opaque. */
export function setPixel(canvas: PixelCanvas, x: number, y: number, [r, g, b]: Rgb, a = 255): void {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const i = (y * canvas.width + x) * 4;
  canvas.data[i] = r;
  canvas.data[i + 1] = g;
  canvas.data[i + 2] = b;
  canvas.data[i + 3] = a;
}

export function fillRect(canvas: PixelCanvas, x: number, y: number, w: number, h: number, rgb: Rgb, a = 255): void {
  for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) setPixel(canvas, x + dx, y + dy, rgb, a);
}

/** A filled ellipse centred at (cx, cy) with radii (rx, ry). */
export function fillEllipse(canvas: PixelCanvas, cx: number, cy: number, rx: number, ry: number, rgb: Rgb, a = 255): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) setPixel(canvas, x, y, rgb, a);
    }
  }
}

/** Deterministic value noise in [0,1) so authored texture speckle repeats. */
export function hashNoise(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Is a pixel opaque (part of the silhouette)? Used for edge/rim detection. */
export function isOpaque(canvas: PixelCanvas, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
  return canvas.data[(y * canvas.width + x) * 4 + 3]! > 0;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export interface ShadeOptions {
  /** Colour on the lit side of a form. */
  readonly lit: Rgb;
  /** Colour on the shadow side. */
  readonly shadow: Rgb;
  /** Cool rim (top / back edge — moonlight). */
  readonly rimCool: Rgb;
  /** Warm rim (front edge — lamp light). */
  readonly rimWarm: Rgb;
  /** Which side the key light comes from. Default "left". */
  readonly litFrom?: "left" | "right";
}

/**
 * Shade an already-drawn silhouette so it reads as a solid volume, not an outline:
 * each interior pixel is lit by a per-row LOCAL cylindrical gradient (bright on the
 * lit side of that row's span, dark on the far side — so a limb curves and the coat
 * has form), and the 1px edge takes a cool rim on its top/back side and a warm rim
 * on its front side. Operates on whatever pixels are already opaque.
 */
export function shadeSilhouette(canvas: PixelCanvas, options: ShadeOptions): void {
  const { width: w, height: h } = canvas;
  const snapshot = canvas.data.slice();
  const op = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && snapshot[(y * w + x) * 4 + 3]! > 0;
  const litLeft = (options.litFrom ?? "left") === "left";
  for (let y = 0; y < h; y += 1) {
    // Local horizontal span of this row, so each part curves across its own width.
    let minX = -1, maxX = -1;
    for (let x = 0; x < w; x += 1) if (op(x, y)) { if (minX < 0) minX = x; maxX = x; }
    if (minX < 0) continue;
    const span = Math.max(1, maxX - minX);
    for (let x = minX; x <= maxX; x += 1) {
      if (!op(x, y)) continue;
      const top = !op(x, y - 1), left = !op(x - 1, y), right = !op(x + 1, y);
      if (top || left) { setPixel(canvas, x, y, options.rimCool); continue; }
      if (right) { setPixel(canvas, x, y, options.rimWarm); continue; }
      const across = (x - minX) / span;               // 0 at left edge → 1 at right edge
      const t = litLeft ? across : 1 - across;         // 0 = lit → 1 = shadow
      setPixel(canvas, x, y, mix(options.lit, options.shadow, t * t)); // t² deepens the core shadow
    }
  }
}
