/**
 * Display surface: owns the <canvas>, computes scaling, and blits engine
 * framebuffers. The scaling math is a pure function so it can be unit-tested
 * without a DOM.
 */

import type { ConsoleModel } from "./models.js";
import type { ScaleMode } from "./types.js";

/**
 * A display surface the player can present frames to. Both the plain 2D
 * {@link CanvasSurface} and the WebGL {@link LitCanvasSurface} implement it, so
 * the run loop presents frames the same way regardless of lighting.
 */
export interface DisplaySurface {
  /** Present one RGBA framebuffer. */
  blit(rgba: Uint8Array): void;
  /** Release the canvas and any observers. */
  destroy(): void;
}

/** A computed on-screen size for the console image. */
export interface ScaledSize {
  /** Rendered width in CSS pixels. */
  width: number;
  /** Rendered height in CSS pixels. */
  height: number;
  /** Multiplier applied to the native resolution. */
  scale: number;
}

/**
 * Computes the on-screen size of the console image for a given container.
 *
 * Pure and DOM-free: given the same inputs it always returns the same size,
 * which is what makes it unit-testable.
 *
 * @param containerWidth Available width in CSS pixels.
 * @param containerHeight Available height in CSS pixels.
 * @param nativeWidth Native console width in pixels.
 * @param nativeHeight Native console height in pixels.
 * @param mode Scaling policy (see {@link ScaleMode}).
 */
export function computeScaledSize(
  containerWidth: number,
  containerHeight: number,
  nativeWidth: number,
  nativeHeight: number,
  mode: ScaleMode,
): ScaledSize {
  let scale: number;

  if (typeof mode === "number") {
    scale = mode;
  } else {
    // Largest uniform scale that keeps the whole image inside the container.
    const bestFitScale = Math.min(containerWidth / nativeWidth, containerHeight / nativeHeight);
    scale = mode === "integer" ? Math.max(1, Math.floor(bestFitScale)) : bestFitScale;
  }

  return {
    width: nativeWidth * scale,
    height: nativeHeight * scale,
    scale,
  };
}

/**
 * Wraps a <canvas> at native resolution and scales it up with CSS. Rendering at
 * native resolution and letting the browser upscale keeps pixels crisp and the
 * blit cheap regardless of on-screen size.
 */
export class CanvasSurface implements DisplaySurface {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly frame: ImageData;
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly container: HTMLElement,
    private readonly scaleMode: ScaleMode,
    private readonly model: ConsoleModel,
  ) {
    this.canvas = container.ownerDocument.createElement("canvas");
    this.canvas.width = model.width;
    this.canvas.height = model.height;
    // Preserve hard pixel edges when the browser upscales the canvas.
    this.canvas.style.imageRendering = "pixelated";
    this.canvas.style.display = "block";
    this.canvas.style.margin = "auto";

    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("2D canvas context unavailable in this environment");
    }
    this.context = context;
    this.frame = context.createImageData(model.width, model.height);

    container.appendChild(this.canvas);

    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(container);
    this.applyScale();
  }

  /** Copies an RGBA framebuffer from the engine to the canvas. */
  blit(rgba: Uint8Array): void {
    const expected = this.model.width * this.model.height * this.model.pixelBytes;
    if (rgba.byteLength !== expected) {
      throw new Error(`Framebuffer size mismatch: expected ${expected}, got ${rgba.byteLength}`);
    }
    this.frame.data.set(rgba);
    this.context.putImageData(this.frame, 0, 0);
  }

  /** Recomputes CSS size from the current container dimensions. */
  private applyScale(): void {
    const { width, height } = computeScaledSize(
      this.container.clientWidth,
      this.container.clientHeight,
      this.model.width,
      this.model.height,
      this.scaleMode,
    );
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  /** Removes the canvas and stops observing resizes. */
  destroy(): void {
    this.resizeObserver.disconnect();
    this.canvas.remove();
  }
}
