/**
 * Dynamic resolution (AAA_FIDELITY_ROADMAP.md F0d): the AAA tier's 3D renders
 * at a share of its native frame chosen from how long the GPU takes over it,
 * so a heavy scene keeps its frame rate by giving up pixels rather than frames.
 *
 * - **Measured on the GPU.** It reads the frame's GPU time (the scene's passes
 *   and the presenter's, from timestamp queries), smoothed. A browser that
 *   can't time the GPU gives no reading, and the scale holds where it is.
 * - **Down fast, up slow.** Over 95% of the frame's budget it drops at once
 *   to the scale its pixels should fit 85% of the budget at (time goes with
 *   the pixel count, the square of the scale). Well under (70%) for two
 *   seconds, it climbs one step. Each change waits a few frames for the GPU's
 *   late readings to catch up before the next.
 * - **In steps.** The scale moves in twentieths between a half and one, so a
 *   size it has used comes back to the same targets.
 */

/** The fewest of the native frame's pixels across it renders. */
export const MIN_RENDER_SCALE = 0.5;
/** Scale steps: twentieths. */
export const RENDER_SCALE_STEP = 0.05;

/** Over this share of the budget, scale down… */
const OVER = 0.95;
/** …to fit this share. */
const TARGET = 0.85;
/** Under this share for {@link CLIMB_FRAMES} frames, step up. */
const UNDER = 0.7;
const CLIMB_FRAMES = 120;
/** Frames after a change before the next (the GPU's readings arrive a frame or two late). */
const SETTLE_FRAMES = 8;
/** Smoothing of the GPU time (exponential, per reading). */
const SMOOTHING = 0.25;

/** A scale on a step, within range. */
export function quantizeScale(scale: number): number {
  const steps = Math.floor(scale / RENDER_SCALE_STEP + 1e-6);
  return Math.min(1, Math.max(MIN_RENDER_SCALE, steps * RENDER_SCALE_STEP));
}

/** The render size for a frame of `width × height` at `scale`. */
export function scaledSize(width: number, height: number, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export class DynamicResolution {
  /** The share of the native frame's width (and height) the 3D renders at. */
  scale = 1;
  /** The smoothed GPU time (ms), or null before the first reading. */
  gpuMs: number | null = null;
  private sinceChange = 0;
  private underFor = 0;

  constructor(
    /** The frame's budget, ms (1000 / the model's frame rate). */
    readonly budgetMs: number,
  ) {}

  /** One frame: the newest GPU time (null when there's none), and the scale to render the next at. */
  update(gpuMs: number | null): number {
    this.sinceChange += 1;
    if (gpuMs === null || !Number.isFinite(gpuMs) || gpuMs <= 0) return this.scale;
    this.gpuMs = this.gpuMs === null ? gpuMs : this.gpuMs + (gpuMs - this.gpuMs) * SMOOTHING;
    const load = this.gpuMs / this.budgetMs;
    this.underFor = load < UNDER ? this.underFor + 1 : 0;
    if (this.sinceChange < SETTLE_FRAMES) return this.scale;
    if (load > OVER && this.scale > MIN_RENDER_SCALE) {
      // Time goes with the pixels, the square of the scale.
      this.change(quantizeScale(this.scale * Math.sqrt(TARGET / load)));
    } else if (this.underFor >= CLIMB_FRAMES && this.scale < 1) {
      this.change(quantizeScale(this.scale + RENDER_SCALE_STEP));
    }
    return this.scale;
  }

  private change(scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    this.sinceChange = 0;
    this.underFor = 0;
    // The readings so far were of the old size.
    this.gpuMs = null;
  }
}
