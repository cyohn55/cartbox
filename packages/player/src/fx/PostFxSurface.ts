/**
 * PostFxSurface — a display surface that draws every presented frame through
 * the post-process shader chain. It decorates the real surface (plain 2D or
 * the lighting surface): the inner surface renders into a detached, offscreen
 * container, and each `blit` re-samples its canvas GPU-side into the visible
 * FX canvas. Decorating (rather than merging into the lighting pipeline) keeps
 * lighting and FX orthogonal — any combination of the two just works.
 *
 * Construction can fail (no WebGL, no inner canvas); the factory returns null
 * and the caller mounts the inner surface directly, so enabling FX can never
 * stop a cart from playing.
 */

import { computeScaledSize, type DisplaySurface } from "../display.js";
import type { ConsoleModel } from "../models.js";
import type { ScaleMode } from "../types.js";
import { PostFxPass } from "./PostFxPass.js";
import { uniformsFromSettings, type PostFxSettings, type PostFxUniforms } from "./postfx.js";

/**
 * The FX canvas renders above native resolution so curvature and scanlines
 * have pixels to live in, capped so a large-model cart doesn't allocate an
 * oversized backbuffer.
 */
const MAX_RENDER_SCALE = 3;
const MAX_RENDER_WIDTH = 1280;

/** Builds the inner (decorated) surface into the given offscreen container. */
export type InnerSurfaceFactory = (container: HTMLElement) => Promise<DisplaySurface> | DisplaySurface;

export class PostFxSurface implements DisplaySurface {
  private readonly resizeObserver: ResizeObserver;
  private uniforms: PostFxUniforms;

  private constructor(
    private readonly container: HTMLElement,
    private readonly scaleMode: ScaleMode,
    private readonly model: ConsoleModel,
    private readonly inner: DisplaySurface,
    private readonly innerCanvas: HTMLCanvasElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly pass: PostFxPass,
    settings: PostFxSettings,
  ) {
    this.uniforms = uniformsFromSettings(settings);
    this.canvas.style.imageRendering = "pixelated";
    this.canvas.style.display = "block";
    this.canvas.style.margin = "auto";
    container.appendChild(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(container);
    this.applyScale();
  }

  /**
   * Builds the FX surface, or returns null when post-processing cannot run
   * (the caller should then mount the inner surface directly). The inner
   * factory is only invoked once the FX pass itself is viable.
   */
  static async create(
    container: HTMLElement,
    scaleMode: ScaleMode,
    model: ConsoleModel,
    settings: PostFxSettings,
    makeInner: InnerSurfaceFactory,
  ): Promise<PostFxSurface | null> {
    const document = container.ownerDocument;
    const canvas = document.createElement("canvas");
    const renderScale = Math.max(1, Math.min(MAX_RENDER_SCALE, Math.floor(MAX_RENDER_WIDTH / model.width)));
    canvas.width = model.width * renderScale;
    canvas.height = model.height * renderScale;
    const pass = PostFxPass.create(canvas);
    if (!pass) return null;

    // The inner surface renders offscreen: its canvas is the FX texture source.
    const innerContainer = document.createElement("div");
    const inner = await makeInner(innerContainer);
    const innerCanvas = innerContainer.querySelector("canvas");
    if (!innerCanvas) {
      inner.destroy();
      pass.dispose();
      return null;
    }

    return new PostFxSurface(container, scaleMode, model, inner, innerCanvas, canvas, pass, settings);
  }

  /** Swap the effect stack without rebuilding the pipeline. */
  setSettings(settings: PostFxSettings): void {
    this.uniforms = uniformsFromSettings(settings);
  }

  blit(rgba: Uint8Array): void {
    this.inner.blit(rgba);
    this.pass.render(this.innerCanvas, this.model.width, this.model.height, this.uniforms);
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.pass.dispose();
    this.canvas.remove();
    this.inner.destroy();
  }

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
}
