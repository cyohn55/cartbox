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
