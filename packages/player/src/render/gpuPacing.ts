/**
 * Pacing a GPU that reads its frames back (the default WebGPU path and WebGL2):
 * the 3D renders at a share of the frame chosen from how often its frames come
 * back, so a GPU that can't keep up gives up pixels rather than showing the
 * scene a frame a second.
 *
 * Why it's needed. Those renderers submit a frame, composite the newest one
 * that has come back, and skip a submit while every readback buffer is still in
 * flight (back-pressure). That keeps the run loop at speed — but it also hides a
 * slow GPU from everything that times the run loop: the cart ticks at 60 while
 * the 3D it shows changes once a second. So this watches the frames that land.
 *
 * - **GPU-bound only.** It acts when the frames land markedly slower than the
 *   run loop presents them (the GPU is behind). A run loop that is slow itself
 *   is the CPU's to fix; fewer pixels wouldn't help it.
 * - **A stall counts.** A GPU that hasn't returned a frame for a while counts as
 *   that slow already, so a frame taking seconds is acted on within a second
 *   rather than after a window of them.
 * - **Down fast, up slow.** Fill time goes with the pixels, the square of the
 *   scale, so it drops straight to the step the measurement says fits. Well
 *   inside the budget for three seconds, it climbs one step.
 */

/** The render scales, largest first. The 3D at 0.35 is 448 × 252 of a 720p frame. */
export const GPU_RENDER_SCALES = [1, 0.85, 0.7, 0.6, 0.5, 0.42, 0.35] as const;

/** A landed-frame interval over this (ms) is slow: under ~22 frames a second. */
export const GPU_SLOW_MS = 45;
/** Under this (ms) for {@link GPU_CLIMB_MS} it steps back up. */
export const GPU_FAST_MS = 22;
const GPU_CLIMB_MS = 3000;
/** What a step down aims for (ms per landed frame). */
const GPU_TARGET_MS = 30;
/** After a change, wait this long (ms) and for this many frames to land before judging again. */
const SETTLE_MS = 600;
const SETTLE_LANDINGS = 2;
/** A stall this long (ms) is judged without waiting for landings: nothing may land for a long while. */
const STALL_MS = 1200;
/** Frames landing this much slower than the run loop presents them mean the GPU is behind. */
const BEHIND_RATIO = 1.4;
const BEHIND_SLACK_MS = 4;
const SMOOTHING = 0.3;

/** The step of {@link GPU_RENDER_SCALES} whose pixels fit `targetMs` from a frame at `scale` taking `ms` (time ∝ scale²). */
export function stepFor(scale: number, ms: number, targetMs: number): number {
  const wanted = scale * Math.sqrt(targetMs / Math.max(ms, 1e-3));
  const index = GPU_RENDER_SCALES.findIndex((s) => s <= wanted + 1e-6);
  return index < 0 ? GPU_RENDER_SCALES.length - 1 : index;
}

export class GpuPacer {
  /** The current step of {@link GPU_RENDER_SCALES}. */
  step = 0;
  /** Smoothed time between landed frames (ms), and between presented ones. */
  landMs: number | null = null;
  presentMs: number | null = null;
  private lastLanded = -1;
  private lastLandAt = 0;
  private lastPresentAt = 0;
  private changedAt = 0;
  private landingsSinceChange = 0;
  private fastSince: number | null = null;

  get scale(): number {
    return GPU_RENDER_SCALES[this.step]!;
  }

  /**
   * How slow the GPU is (ms per frame) when it's what holds the 3D back, else
   * null: the smoothed landed interval, or the current stall if longer.
   */
  gpuBoundMs(now: number): number | null {
    if (this.landMs === null || this.presentMs === null) return null;
    const ms = Math.max(this.landMs, now - this.lastLandAt);
    return ms > this.presentMs * BEHIND_RATIO + BEHIND_SLACK_MS ? ms : null;
  }

  /** Start afresh (a new scene, a resume after a pause): the scale stays, the timings go. */
  reset(now: number): void {
    this.landMs = null;
    this.presentMs = null;
    this.lastLanded = -1;
    this.lastPresentAt = 0;
    this.lastLandAt = now;
    this.changedAt = now;
    this.landingsSinceChange = 0;
    this.fastSince = null;
  }

  /**
   * One presented frame at `now`, `landed` GPU frames having come back so far:
   * the step to render the next at.
   */
  update(now: number, landed: number): number {
    if (this.lastPresentAt > 0) {
      const ms = now - this.lastPresentAt;
      // A pause (a hidden tab) isn't a frame time.
      if (ms > 1000) {
        this.reset(now);
        this.lastPresentAt = now;
        this.lastLanded = landed;
        return this.step;
      }
      this.presentMs = this.presentMs === null ? ms : this.presentMs + (ms - this.presentMs) * SMOOTHING;
    }
    this.lastPresentAt = now;
    if (this.lastLanded < 0) {
      this.lastLanded = landed;
      this.lastLandAt = now;
      return this.step;
    }
    if (landed > this.lastLanded) {
      const ms = (now - this.lastLandAt) / (landed - this.lastLanded);
      this.landMs = this.landMs === null ? ms : this.landMs + (ms - this.landMs) * SMOOTHING;
      this.landingsSinceChange += landed - this.lastLanded;
      this.lastLanded = landed;
      this.lastLandAt = now;
    }
    const sinceChange = now - this.changedAt;
    const stalled = now - this.lastLandAt;
    const bound = this.gpuBoundMs(now) ?? (this.presentMs !== null && stalled > STALL_MS ? stalled : null);
    if (bound !== null && bound > GPU_SLOW_MS && this.step < GPU_RENDER_SCALES.length - 1) {
      const settled = sinceChange >= SETTLE_MS && (this.landingsSinceChange >= SETTLE_LANDINGS || stalled > STALL_MS);
      if (settled) this.change(Math.max(this.step + 1, stepFor(this.scale, bound, GPU_TARGET_MS)), now);
      return this.step;
    }
    // Comfortably inside the budget (and not just because the run loop is slow): climb a step after a while.
    const fast = this.step > 0 && this.landMs !== null && this.landMs < GPU_FAST_MS && stalled < GPU_FAST_MS * 3;
    if (!fast) this.fastSince = null;
    else if (this.fastSince === null) this.fastSince = now;
    else if (now - this.fastSince >= GPU_CLIMB_MS && sinceChange >= GPU_CLIMB_MS) this.change(this.step - 1, now);
    return this.step;
  }

  private change(step: number, now: number): void {
    step = Math.min(GPU_RENDER_SCALES.length - 1, Math.max(0, step));
    if (step === this.step) return;
    this.step = step;
    this.changedAt = now;
    this.landingsSinceChange = 0;
    this.fastSince = null;
    // The frames in flight were drawn at the old size; time from here.
    this.landMs = null;
  }
}

/**
 * Expand a small RGBA frame bilinearly into a larger one (pixel centres
 * aligned, edges clamped). Two channels at a time in each 32-bit word, each
 * source row filtered across once and the rows then blended: a few
 * milliseconds at 720p.
 */
export function expandBilinear(src: Uint8ClampedArray | Uint8Array, sw: number, sh: number, dst: Uint8ClampedArray | Uint8Array, dw: number, dh: number): void {
  const from = new Uint32Array(src.buffer, src.byteOffset, sw * sh);
  const to = new Uint32Array(dst.buffer, dst.byteOffset, dw * dh);
  const x0 = new Int32Array(dw);
  const x1 = new Int32Array(dw);
  const wx = new Int32Array(dw);
  for (let x = 0; x < dw; x += 1) {
    const sx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / dw - 0.5));
    const i = Math.floor(sx);
    x0[x] = i;
    x1[x] = Math.min(sw - 1, i + 1);
    wx[x] = Math.round((sx - i) * 256);
  }
  const rows: [Uint32Array, Uint32Array] = [new Uint32Array(dw), new Uint32Array(dw)];
  const ids: [number, number] = [-1, -1];
  const across = (sy: number, row: Uint32Array) => {
    const base = sy * sw;
    for (let x = 0; x < dw; x += 1) {
      const a = from[base + x0[x]!]!;
      const b = from[base + x1[x]!]!;
      const w = wx[x]!;
      if (w === 0 || a === b) {
        row[x] = a;
        continue;
      }
      const iw = 256 - w;
      const rb = (((a & 0x00ff00ff) * iw + (b & 0x00ff00ff) * w) >>> 8) & 0x00ff00ff;
      const ga = ((((a >>> 8) & 0x00ff00ff) * iw + ((b >>> 8) & 0x00ff00ff) * w) >>> 8) & 0x00ff00ff;
      row[x] = (rb | (ga << 8)) >>> 0;
    }
  };
  // The filtered row for source row `sy`, from the two kept (each source row is filtered across once).
  const rowFor = (sy: number): Uint32Array => {
    if (ids[0] === sy) return rows[0];
    if (ids[1] === sy) return rows[1];
    // Replace the one not holding the row just below this (rows are asked for in order).
    const slot = ids[0] === sy - 1 ? 1 : 0;
    across(sy, rows[slot]);
    ids[slot] = sy;
    return rows[slot];
  };
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / dh - 0.5));
    const i = Math.floor(sy);
    const j = Math.min(sh - 1, i + 1);
    const w = Math.round((sy - i) * 256);
    const out = y * dw;
    const top = rowFor(i);
    if (w === 0 || i === j) {
      to.set(top, out);
      continue;
    }
    const bottom = rowFor(j);
    const iw = 256 - w;
    for (let x = 0; x < dw; x += 1) {
      const a = top[x]!;
      const b = bottom[x]!;
      if (a === b) {
        to[out + x] = a;
        continue;
      }
      const rb = (((a & 0x00ff00ff) * iw + (b & 0x00ff00ff) * w) >>> 8) & 0x00ff00ff;
      const ga = ((((a >>> 8) & 0x00ff00ff) * iw + ((b >>> 8) & 0x00ff00ff) * w) >>> 8) & 0x00ff00ff;
      to[out + x] = (rb | (ga << 8)) >>> 0;
    }
  }
}

/** A frame resampled to another size, nearest-neighbour: what shows until the first frame at a new size lands. */
export function resampleNearest(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  const from = new Uint32Array(src.buffer, src.byteOffset, sw * sh);
  const to = new Uint32Array(out.buffer);
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x += 1) to[y * dw + x] = from[sy * sw + Math.min(sw - 1, Math.floor((x * sw) / dw))]!;
  }
  return out;
}
