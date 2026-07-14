/**
 * LitCanvasSurface — a display surface that relights each frame through the
 * lighting renderer before showing it. It is a drop-in for {@link CanvasSurface}:
 * the run loop still calls `blit(albedo)`; this surface pulls the frame's lights
 * (and optional material) from the host's {@link LightingOptions} and renders
 * them over the cart's own art.
 *
 * Construction is async ({@link create}) because choosing the backend may need
 * to await a WebGPU device. The factory prefers WebGPU and falls back to WebGL;
 * if neither is available this surface falls back to plain 2D, so enabling
 * lighting can never stop a cart from playing.
 */

import { CanvasSurface, computeScaledSize, type DisplaySurface } from "../display.js";
import type { ConsoleModel } from "../models.js";
import type { ScaleMode } from "../types.js";
import { createLightingLayer, type BuiltLightingRenderer } from "./createLightingLayer.js";
import type { LightingBackend, LightingRenderer } from "./LightingRenderer.js";
import type { Light, LightingFrameContext, LightingOptions, MaterialBuffer } from "./types.js";

const DEFAULT_AMBIENT = 0.16;
const DEFAULT_AMBIENT_COLOR: readonly [number, number, number] = [0.5, 0.55, 0.8];

export class LitCanvasSurface implements DisplaySurface {
  private readonly performanceNow: () => number;
  private readonly resizeObserver: ResizeObserver;
  private readonly renderer?: LightingRenderer;
  private readonly canvas?: HTMLCanvasElement;
  private readonly fallback?: CanvasSurface;
  private frame = 0;
  private cartLights: readonly Light[] = [];
  // A stable, non-resizable copy of the framebuffer for GPU upload. The engine's
  // framebuffer is a view over WASM memory whose backing ArrayBuffer is growable,
  // and WebGL/WebGPU texture uploads reject resizable ArrayBufferViews. Copying
  // into a plain buffer once per frame satisfies the upload contract.
  private albedoCopy: Uint8Array | null = null;
  // The per-pixel material the engine emitted for this frame (same growable-buffer
  // caveat as the framebuffer, so it is copied into a stable buffer before upload).
  private cartMaterial: Uint8Array | null = null;
  private cartMaterialCopy: Uint8Array | null = null;
  // Per-pixel emissive (one byte each) the engine emitted this frame. Folded into
  // the albedo copy's alpha, which the shader reads as self-illumination.
  private cartEmissive: Uint8Array | null = null;

  private constructor(
    private readonly container: HTMLElement,
    private readonly scaleMode: ScaleMode,
    private readonly model: ConsoleModel,
    private readonly options: LightingOptions,
    built: BuiltLightingRenderer | null,
  ) {
    const view = container.ownerDocument.defaultView;
    this.performanceNow = () => view?.performance.now() ?? Date.now();

    if (!built) {
      // Neither WebGPU nor WebGL: play the cart unlit rather than not at all.
      this.fallback = new CanvasSurface(container, scaleMode, model);
      this.resizeObserver = new ResizeObserver(() => {});
      return;
    }

    this.renderer = built.renderer;
    this.canvas = built.canvas;
    this.canvas.style.imageRendering = "pixelated";
    this.canvas.style.display = "block";
    this.canvas.style.margin = "auto";
    container.appendChild(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(container);
    this.applyScale();
  }

  /** Builds the surface, choosing the best available lighting backend. */
  static async create(
    container: HTMLElement,
    scaleMode: ScaleMode,
    model: ConsoleModel,
    options: LightingOptions,
  ): Promise<LitCanvasSurface> {
    const built = await createLightingLayer(container.ownerDocument, model.width, model.height);
    return new LitCanvasSurface(container, scaleMode, model, options, built);
  }

  /** Whether the lit path is active (false means it fell back to plain 2D). */
  get isLit(): boolean {
    return !this.fallback;
  }

  /** The active backend: "webgpu", "webgl", or "2d" when unlit. */
  get backend(): LightingBackend | "2d" {
    return this.renderer?.backend ?? "2d";
  }

  /**
   * Sets the lights the running cart emitted this frame (via `cartbox.light`).
   * They are combined with any host-provided lights on the next {@link blit}.
   */
  setCartLights(lights: readonly Light[]): void {
    this.cartLights = lights;
  }

  /**
   * Sets the per-pixel material buffer the engine emitted for this frame's
   * sprites (RGBA: normal index, height, specular, roughness). Copied into a
   * stable buffer on {@link blit}; an empty buffer falls back to host material.
   */
  setCartMaterial(material: Uint8Array): void {
    this.cartMaterial = material.length ? material : null;
  }

  /**
   * Sets the per-pixel emissive plane (one byte each) the engine emitted this
   * frame. It is folded into the albedo copy's alpha channel on {@link blit},
   * which both lighting backends read as self-illumination. An empty buffer
   * leaves the framebuffer's own alpha untouched.
   */
  setCartEmissive(emissive: Uint8Array): void {
    this.cartEmissive = emissive.length ? emissive : null;
  }

  blit(albedo: Uint8Array): void {
    if (this.fallback || !this.renderer) {
      this.fallback?.blit(albedo);
      return;
    }
    const context: LightingFrameContext = {
      frame: this.frame,
      timeMs: this.performanceNow(),
      width: this.model.width,
      height: this.model.height,
    };
    const hostLights = this.options.lights?.(context) ?? [];
    const lights = this.cartLights.length ? [...this.cartLights, ...hostLights] : hostLights;
    const material = this.resolveMaterial(context);
    // Auto-detect: with no lights, show the cart unlit so ordinary carts are
    // untouched and only lighting-aware carts change.
    const unlit = (this.options.autoDetect ?? false) && lights.length === 0;
    if (!this.albedoCopy || this.albedoCopy.length !== albedo.length) {
      this.albedoCopy = new Uint8Array(albedo.length);
    }
    this.albedoCopy.set(albedo);
    // Fold per-pixel emissive into the albedo alpha the shader reads. The engine
    // forces the framebuffer alpha opaque, so without this every pixel would read
    // as fully self-illuminated; the emissive plane restores real 0-lit pixels.
    if (this.cartEmissive && this.cartEmissive.length * 4 === this.albedoCopy.length) {
      for (let i = 0; i < this.cartEmissive.length; i += 1) {
        this.albedoCopy[i * 4 + 3] = this.cartEmissive[i] ?? 0;
      }
    }
    this.renderer.render(this.albedoCopy, material, {
      lights,
      ambient: this.options.ambient ?? DEFAULT_AMBIENT,
      ambientColor: this.options.ambientColor ?? DEFAULT_AMBIENT_COLOR,
      bloom: this.options.bloom ?? true,
      shadows: this.options.shadows ?? false,
      unlit,
    });
    this.frame += 1;
  }

  destroy(): void {
    if (this.fallback) {
      this.fallback.destroy();
      return;
    }
    this.resizeObserver.disconnect();
    this.renderer?.dispose();
    this.canvas?.remove();
  }

  private resolveMaterial(context: LightingFrameContext): MaterialBuffer | null {
    // The engine's material (from the cart's authored maps) takes precedence;
    // it must be copied off the growable WASM buffer before GPU upload, exactly
    // like the framebuffer. Host-supplied material is the fallback.
    if (this.cartMaterial) {
      if (!this.cartMaterialCopy || this.cartMaterialCopy.length !== this.cartMaterial.length) {
        this.cartMaterialCopy = new Uint8Array(this.cartMaterial.length);
      }
      this.cartMaterialCopy.set(this.cartMaterial);
      return this.cartMaterialCopy;
    }
    const source = this.options.material;
    if (typeof source === "function") return source(context);
    return source ?? null;
  }

  private applyScale(): void {
    if (!this.canvas) return;
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
