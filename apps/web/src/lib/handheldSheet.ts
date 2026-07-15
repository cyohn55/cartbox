/**
 * Horizontal sprite-sheet helpers for animated handheld skins. An animation is
 * stored as one image `frames` frames wide (each `width × height`), which the
 * console slices back into per-frame images to play. Kept in one module so the
 * editor (which assembles the sheet on save), the picker (which previews it),
 * and the console (which plays it) share the exact same layout.
 *
 * Browser-only: both helpers use a 2D canvas. The layout itself is trivial —
 * frame `i` occupies the horizontal band starting at `i * width`.
 */

/**
 * Draw single-frame RGBA composites side by side into one canvas — a horizontal
 * sprite sheet `width * composites.length` by `height`. A single composite makes
 * an ordinary `width × height` image, so static skins are unchanged.
 */
export function assembleSheetCanvas(
  composites: ReadonlyArray<Uint8ClampedArray>,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width * Math.max(1, composites.length);
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) {
    composites.forEach((rgba, index) => {
      const image = new ImageData(new Uint8ClampedArray(rgba), width, height);
      context.putImageData(image, index * width, 0);
    });
  }
  return canvas;
}

/**
 * Slice a loaded horizontal sprite-sheet image into `frames` per-frame PNG data
 * URLs (each `width × height`), ready to swap as an `<img>` source while
 * animating.
 */
export function sliceSheet(image: HTMLImageElement, width: number, height: number, frames: number): string[] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return [];
  const urls: string[] = [];
  for (let index = 0; index < frames; index += 1) {
    context.clearRect(0, 0, width, height);
    context.drawImage(image, index * width, 0, width, height, 0, 0, width, height);
    urls.push(canvas.toDataURL());
  }
  return urls;
}
