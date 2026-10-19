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

/** The most pixels a native-resolution frame renders (F0d): 4K, on the densest display. */
export const MAX_NATIVE_PIXELS = 3840 * 2160;

/**
 * The backing size of a native-resolution canvas shown at `cssWidth × cssHeight`
 * on a display of `pixelRatio` (F0d): its device pixels, scaled down evenly to
 * at most {@link MAX_NATIVE_PIXELS}.
 */
export function nativeBackingSize(cssWidth: number, cssHeight: number, pixelRatio: number): { width: number; height: number } {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  let width = Math.max(1, cssWidth * ratio);
  let height = Math.max(1, cssHeight * ratio);
  const over = (width * height) / MAX_NATIVE_PIXELS;
  if (over > 1) {
    width /= Math.sqrt(over);
    height /= Math.sqrt(over);
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/** A presented frame, read back (F11a): its display pixels, 8-bit RGBA, top row first. */
export interface CapturedFrame {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export class GpuCanvasSurface implements DisplaySurface {
  private readonly resizeObserver: ResizeObserver;
  /** Who waits on the next presented frame's pixels. */
  private captures: Array<{ resolve: (frame: CapturedFrame | null) => void }> = [];
  /** Whether the canvas's textures can be copied from (configured once a capture asks). */
  private copyable = false;
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
    private readonly device: any,
    private readonly format: string,
    /** The canvas configuration's tone mapping (extended on an HDR display). */
    private readonly toneMapping: unknown,
    /** The compositor every frame goes through. */
    readonly presenter: GpuPresenter,
    /** Render at the display's own resolution (F0d), not the model's frame. */
    readonly native = false,
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
  static create(
    container: HTMLElement,
    scaleMode: ScaleMode,
    model: ConsoleModel,
    device: any,
    options: { readonly hdr?: boolean; readonly native?: boolean } = {},
  ): GpuCanvasSurface | null {
    try {
      const canvas = container.ownerDocument.createElement("canvas");
      canvas.width = model.width;
      canvas.height = model.height;
      // A frame at the model's size is scaled up crisply; a native one is shown pixel for pixel.
      if (options.native !== true) canvas.style.imageRendering = "pixelated";
      canvas.style.display = "block";
      canvas.style.margin = "auto";
      const context = canvas.getContext("webgpu" as any) as any;
      const gpu = (globalThis as any).navigator?.gpu;
      if (!context || !gpu) return null;
      // A linear frame on a display that shows past SDR white (F4d-2): a half-float canvas
      // with extended tone mapping, kept only where the browser says it took.
      const extended = options.hdr === true && wantsExtended(context, device);
      const format: string = extended ? "rgba16float" : (gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm");
      if (!extended) context.configure({ device, format, alphaMode: "opaque" });
      return new GpuCanvasSurface(container, scaleMode, model, canvas, context, device, format, extended ? { mode: "extended" } : undefined, new GpuPresenter(device, model.width, model.height, { hdr: options.hdr, extended }), options.native === true);
    } catch {
      return null;
    }
  }

  /** The size frames show at: the model's, or with a native frame the display's device pixels (F0d). */
  get outputSize(): { readonly width: number; readonly height: number } {
    return { width: this.presenter.width, height: this.presenter.height };
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
    const texture = this.context.getCurrentTexture();
    this.presenter.present(uniforms ? { ...frame, post: { uniforms, time: (performance.now() - this.startedAt) / 1000 } } : frame, texture, this.format);
    if (this.captures.length > 0) this.readBack(texture);
  }

  /**
   * The next presented frame's pixels, as the display shows them (F11a): what
   * a screenshot of a WebGPU canvas can't be relied on to catch. An extended
   * (HDR) frame is clipped at SDR white. Null if the device can't copy it.
   */
  capture(): Promise<CapturedFrame | null> {
    if (this.destroyed) return Promise.resolve(null);
    if (!this.copyable) {
      try {
        // RENDER_ATTACHMENT | COPY_SRC: the presenter draws it, a capture copies it.
        this.context.configure({ device: this.device, format: this.format, usage: 0x10 | 0x01, alphaMode: "opaque", ...(this.toneMapping ? { toneMapping: this.toneMapping } : {}) });
        this.copyable = true;
      } catch {
        return Promise.resolve(null);
      }
    }
    return new Promise((resolve) => this.captures.push({ resolve }));
  }

  /** Copy the frame just presented (still the canvas's current texture) to the waiting captures. */
  private readBack(texture: any): void {
    const waiting = this.captures;
    this.captures = [];
    const width: number = texture.width;
    const height: number = texture.height;
    const half = this.format === "rgba16float";
    const bytesPerRow = Math.ceil((width * (half ? 8 : 4)) / 256) * 256;
    let buffer: any = null;
    try {
      // MAP_READ | COPY_DST.
      buffer = this.device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height });
      this.device.queue.submit([encoder.finish()]);
    } catch {
      buffer?.destroy?.();
      for (const w of waiting) w.resolve(null);
      return;
    }
    void buffer.mapAsync(0x01).then(
      () => {
        const frame = { width, height, rgba: framePixels(new Uint8Array(buffer.getMappedRange()), width, height, bytesPerRow, this.format) };
        buffer.unmap();
        buffer.destroy();
        for (const w of waiting) w.resolve(frame);
      },
      () => {
        buffer.destroy();
        for (const w of waiting) w.resolve(null);
      },
    );
  }

  /** Show a CPU frame as it is (the cart's own, before any 3D draws). */
  blit(rgba: Uint8Array): void {
    this.present({ base: { kind: "frame", rgba }, scene: null });
  }

  destroy(): void {
    this.destroyed = true;
    for (const w of this.captures) w.resolve(null);
    this.captures = [];
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
    if (this.native && width > 0 && height > 0) {
      // The frame follows the display (F0d): the canvas's device pixels, and the presenter's frame with it.
      const backing = nativeBackingSize(width, height, (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1);
      if (this.canvas.width !== backing.width || this.canvas.height !== backing.height) {
        this.canvas.width = backing.width;
        this.canvas.height = backing.height;
      }
      this.presenter.resize(backing.width, backing.height);
    }
  }
}

/**
 * Whether the page shows high dynamic range and the canvas took an extended,
 * half-float configuration (AAA_FIDELITY_ROADMAP.md F4d-2). A browser that
 * doesn't know `toneMapping` ignores it and would clip the frame at SDR white,
 * so the configuration is only trusted when it reads back.
 */
function wantsExtended(context: any, device: any): boolean {
  try {
    if (!(globalThis as any).matchMedia?.("(dynamic-range: high)")?.matches) return false;
    context.configure({ device, format: "rgba16float", toneMapping: { mode: "extended" }, alphaMode: "opaque" });
    if (context.getConfiguration?.()?.toneMapping?.mode === "extended") return true;
    context.unconfigure?.();
    return false;
  } catch {
    return false;
  }
}

/** A canvas texture's rows (padded to `bytesPerRow`), as tight 8-bit RGBA: swizzled from BGRA, or half floats clipped to [0, 1]. */
export function framePixels(bytes: Uint8Array, width: number, height: number, bytesPerRow: number, format: string): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  if (format === "rgba16float") {
    const halves = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    for (let y = 0; y < height; y += 1) {
      for (let i = 0; i < width * 4; i += 1) {
        const v = halfToFloat(halves[(y * bytesPerRow) / 2 + i]!);
        out[(y * width) * 4 + i] = (i & 3) === 3 ? 255 : Math.round(Math.min(1, Math.max(0, v)) * 255);
      }
    }
    return out;
  }
  const bgra = format === "bgra8unorm";
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = y * bytesPerRow + x * 4;
      const to = (y * width + x) * 4;
      out[to] = bytes[from + (bgra ? 2 : 0)]!;
      out[to + 1] = bytes[from + 1]!;
      out[to + 2] = bytes[from + (bgra ? 0 : 2)]!;
      out[to + 3] = 255;
    }
  }
  return out;
}

function halfToFloat(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const sign = h & 0x8000 ? -1 : 1;
  if (e === 0x1f) return m ? Number.NaN : sign * Infinity;
  return e === 0 ? sign * 2 ** -14 * (m / 1024) : sign * 2 ** (e - 15) * (1 + m / 1024);
}
