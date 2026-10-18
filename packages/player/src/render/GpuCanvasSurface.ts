/**
 * GpuCanvasSurface — the base display surface of a GPU-presented frame
 * (AAA_FIDELITY_ROADMAP.md F0a): a WebGPU canvas on the scene renderer's own
 * device, which the mesh overlay presents each frame into through a
 * {@link GpuPresenter}, so the 3D frame never leaves the GPU.
 *
 * It is the {@link CanvasSurface} of that path: native resolution, scaled up
 * with CSS, and a plain `blit` that shows a CPU frame (the cart's own) through
 * the same compositor. It is also the post-FX stack of that path (the
 * {@link PostFxSurface} API: settings and the sun to follow), which the
 * presenter runs on the GPU rather than in a WebGL context that would have to
 * copy this canvas first.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { computeScaledSize, type DisplaySurface } from "../display.js";
import type { ConsoleModel } from "../models.js";
import type { ScaleMode } from "../types.js";
import { anyPostFxEnabled, uniformsFromSettings, type PostFxSettings, type PostFxUniforms } from "../fx/postfx.js";
import type { ScreenSun } from "../fx/PostFxSurface.js";
import { GpuPresenter, type PresentFrame, type PresentStats } from "./gpuPresent.js";

export class GpuCanvasSurface implements DisplaySurface {
  private readonly resizeObserver: ResizeObserver;
  private destroyed = false;
  /** The post stack's uniforms, or null with no effect on. */
  private post: PostFxUniforms | null = null;
  /** The sun a 3D scene reports; the lens flare follows it (null: the effect's own source point). */
  private sun: ScreenSun | null = null;
  /** When this surface started, so animated effects get a monotonic clock. */
  private readonly startedAt = performance.now();

  private constructor(
    private readonly container: HTMLElement,
    private readonly scaleMode: ScaleMode,
    private readonly model: ConsoleModel,
    private readonly canvas: HTMLCanvasElement,
    private readonly context: any,
    private readonly format: string,
    /** The compositor every frame goes through. */
    readonly presenter: GpuPresenter,
  ) {
    container.appendChild(canvas);
    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(container);
    this.applyScale();
  }

  /**
   * A WebGPU canvas on `device`, or null when the page can't give one (no
   * WebGPU canvas context): the caller then mounts the 2D canvas, and the
   * frame takes the byte path.
   */
  static create(container: HTMLElement, scaleMode: ScaleMode, model: ConsoleModel, device: any): GpuCanvasSurface | null {
    try {
      const canvas = container.ownerDocument.createElement("canvas");
      canvas.width = model.width;
      canvas.height = model.height;
      canvas.style.imageRendering = "pixelated";
      canvas.style.display = "block";
      canvas.style.margin = "auto";
      const context = canvas.getContext("webgpu" as any) as any;
      const gpu = (globalThis as any).navigator?.gpu;
      if (!context || !gpu) return null;
      const format: string = gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm";
      context.configure({ device, format, alphaMode: "opaque" });
      return new GpuCanvasSurface(container, scaleMode, model, canvas, context, format, new GpuPresenter(device, model.width, model.height));
    } catch {
      return null;
    }
  }

  /** The newest measurements the presenter has read back (luminance, the sun's visibility). */
  get stats(): PresentStats {
    return this.presenter.stats;
  }

  /** Set the post-process stack (null, or nothing enabled, for none). */
  setSettings(settings: PostFxSettings | null): void {
    this.post = settings && anyPostFxEnabled(settings) ? uniformsFromSettings(settings) : null;
  }

  /** Follow a 3D scene's sun with the lens flare, or null for the effect's own source point. */
  setSun(sun: ScreenSun | null): void {
    this.sun = sun;
  }

  /** Composite and show one frame, through the post stack when one is set. */
  present(frame: PresentFrame): void {
    if (this.destroyed) return;
    const post = this.post;
    const sun = this.sun;
    const uniforms = post && sun ? { ...post, flareOrigin: [sun.x, sun.y] as [number, number], flareVisible: sun.visible } : post;
    this.presenter.present(
      uniforms ? { ...frame, post: { uniforms, time: (performance.now() - this.startedAt) / 1000 } } : frame,
      this.context.getCurrentTexture(),
      this.format,
    );
  }

  /** Show a CPU frame as it is (the cart's own, before any 3D draws). */
  blit(rgba: Uint8Array): void {
    this.present({ base: { kind: "frame", rgba }, scene: null });
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.presenter.dispose();
    try {
      this.context.unconfigure?.();
    } catch {
      // Already gone with its device.
    }
    this.canvas.remove();
  }

  private applyScale(): void {
    const { width, height } = computeScaledSize(this.container.clientWidth, this.container.clientHeight, this.model.width, this.model.height, this.scaleMode);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }
}
