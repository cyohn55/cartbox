/**
 * Graphics quality presets (ENGINE_ROADMAP.md, Phase 4): what the player spends
 * on a frame, chosen per device.
 *
 * - **high**: everything as authored — full-resolution shadow maps, every
 *   post-effect, the 3D at full size (a software-rendered first-person view may
 *   still step itself down to hold the frame rate). This is the player's
 *   behaviour before presets existed.
 * - **medium**: half-resolution shadow maps; the first-person software view
 *   starts at three-quarter size.
 * - **low**: no shadows, no bloom or chromatic aberration (the multi-pass
 *   effects; cheap per-pixel looks like grading, CRT or dithering stay), no
 *   anti-aliasing, and the first-person software view capped at half size.
 *
 * Terrain keeps full detail less far on the lower presets (60% and 30% of the
 * authored distance), so distant ground costs fewer triangles.
 *
 * "auto" picks one from what the browser says about the device: weak hardware
 * (≤ 2 cores or ≤ 2 GB of memory) → low; a phone or tablet, or any device with
 * no GPU renderer (WebGPU or WebGL2, so rendering on the CPU) → medium; otherwise
 * high. The browser can't say how strong the GPU is, so "auto" then watches the
 * frame rate (QualityGovernor) and steps down a preset at a time while frames
 * keep running long.
 */

import type { PostFxSettings } from "./fx/postfx.js";

export type QualityLevel = "low" | "medium" | "high";
export type QualityChoice = QualityLevel | "auto";
export const QUALITY_LEVELS: readonly QualityLevel[] = ["low", "medium", "high"];

export interface QualitySettings {
  readonly level: QualityLevel;
  /** Draw shadows at all. */
  readonly shadows: boolean;
  /** Shadow map edge in texels. */
  readonly shadowMapSize: number;
  /** Add a near shadow cascade round the camera (ENGINE_PARITY_ROADMAP.md EP8b): sharp shadows close up. */
  readonly shadowCascades?: boolean;
  /** Each of the AAA tier's GPU sun cascades' edge in texels (AAA_FIDELITY_ROADMAP.md F2a-2). */
  readonly cascadeMapSize?: number;
  /** The largest 3D render scale for a software first-person view (the governor works below it). */
  readonly maxRenderScale: number;
  /** Post-effects this preset turns off (the costly multi-pass ones). */
  readonly disabledEffects: readonly string[];
  /**
   * How far terrain keeps its detail, as a share of each block's authored
   * distance: lower presets drop to the coarser blocks sooner.
   */
  readonly terrainDetail: number;
  /** Anti-alias the 3D where the model does (HALO_INFINITE_STYLE_ROADMAP.md I1). */
  readonly antialias?: boolean;
  /** Temporal anti-aliasing where the model has it (I2). */
  readonly temporal?: boolean;
  /** Screen-space reflections where the model has them (I3). */
  readonly reflections?: boolean;
  /**
   * A first-person sky backdrop is painted on the CPU at one sample per this
   * many pixels each way, and smoothed up. Drifting clouds or a turning camera
   * repaint it every frame, so the low preset paints it coarser. (It is
   * expanded in blocks, so much past 4 shows on cloud edges.)
   */
  readonly skyScale?: number;
}

export const QUALITY_PRESETS: Readonly<Record<QualityLevel, QualitySettings>> = {
  high: { level: "high", shadows: true, shadowMapSize: 1024, shadowCascades: true, cascadeMapSize: 4096, maxRenderScale: 1, disabledEffects: [], terrainDetail: 1, antialias: true, temporal: true, reflections: true, skyScale: 3 },
  medium: { level: "medium", shadows: true, shadowMapSize: 512, cascadeMapSize: 2048, maxRenderScale: 0.75, disabledEffects: [], terrainDetail: 0.6, antialias: true, temporal: true, reflections: true, skyScale: 3 },
  low: { level: "low", shadows: false, shadowMapSize: 512, maxRenderScale: 0.5, disabledEffects: ["bloom", "chroma"], terrainDetail: 0.3, antialias: false, temporal: false, reflections: false, skyScale: 4 },
};

/** What the browser reveals about the device (all optional: browsers differ). */
export interface DeviceHints {
  readonly cores?: number;
  /** navigator.deviceMemory, in GB (Chromium only; rounded down to a power of two). */
  readonly memoryGB?: number;
  readonly mobile?: boolean;
  /** Whether a GPU renderer (WebGPU or WebGL2) came up (else the CPU rasteriser draws). */
  readonly webgpu?: boolean;
}

/** The preset "auto" picks for a device. */
export function detectQuality(hints: DeviceHints): QualityLevel {
  if ((hints.cores !== undefined && hints.cores <= 2) || (hints.memoryGB !== undefined && hints.memoryGB <= 2)) return "low";
  if (hints.mobile || hints.webgpu === false) return "medium";
  return "high";
}

/** Resolve a choice ("auto" included) to its preset's settings. */
export function resolveQuality(choice: QualityChoice | undefined, hints: DeviceHints): QualitySettings {
  const level = !choice || choice === "auto" ? detectQuality(hints) : choice;
  return QUALITY_PRESETS[QUALITY_LEVELS.includes(level) ? level : "high"];
}

/** This browser's hints (in a browser; empty elsewhere). */
export function browserDeviceHints(webgpu?: boolean): DeviceHints {
  const nav = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } });
  if (!nav) return webgpu === undefined ? {} : { webgpu };
  const mobile = nav.userAgentData?.mobile ?? isMobileAgent(nav.userAgent ?? "", nav.maxTouchPoints ?? 0);
  return {
    ...(typeof nav.hardwareConcurrency === "number" ? { cores: nav.hardwareConcurrency } : {}),
    ...(typeof nav.deviceMemory === "number" ? { memoryGB: nav.deviceMemory } : {}),
    mobile,
    ...(webgpu === undefined ? {} : { webgpu }),
  };
}

/**
 * "auto" by measurement: fed the time between shown frames and how much of it
 * the player spent working, it says when to step down a preset. A device that
 * can't hold about 40 fps over a second and a half, while busy for most of
 * each frame, steps down a preset (high → medium → low); one that can't hold
 * 20 fps goes straight to low. It never steps back up, so the picture doesn't
 * flicker between presets. (Busy matters: a browser saving power may show only
 * 30 frames a second however light they are, and that's no reason to draw them
 * worse.) After a change, a resume or the start it waits a few seconds for the
 * first, slower frames (loading, shaders building) to pass; gaps over half a
 * second — a hidden tab, a breakpoint — don't count.
 */
export class QualityGovernor {
  /** Smoothed time between frames and time spent on them (ms), how many frames and how long that covers. */
  private average = 0;
  private busy = 0;
  private frames = 0;
  private measured = 0;
  private holdUntil = 0;

  constructor(
    /** Frames slower than this on average (ms) step the preset down; twice as slow goes straight to low. */
    private readonly slowMs = 25,
    /** How long the average must cover first (ms). */
    private readonly windowMs = 1500,
    /** How long to wait after a change before measuring (ms). */
    private readonly settleMs = 3000,
    /** The share of each frame the player must be busy for slow frames to count against the preset. */
    private readonly busyShare = 0.6,
  ) {}

  /** Start afresh at `now` (a new preset, a resume): wait, then measure again. */
  reset(now: number): void {
    this.average = 0;
    this.busy = 0;
    this.frames = 0;
    this.measured = 0;
    this.holdUntil = now + this.settleMs;
  }

  /**
   * A frame was shown `ms` after the last, at `now`, the player having spent
   * `busyMs` of the frame working on it: the preset to step down to from
   * `level`, or null to stay.
   */
  feed(ms: number, busyMs: number, now: number, level: QualityLevel): QualityLevel | null {
    if (now < this.holdUntil || !(ms > 0) || ms > 500) return null;
    const k = 1 / Math.min(this.frames + 1, 30);
    this.average += (ms - this.average) * k;
    this.busy += (Math.min(busyMs, ms) - this.busy) * k;
    this.frames += 1;
    this.measured += ms;
    if (this.measured < this.windowMs || this.frames < 10 || this.average <= this.slowMs || this.busy < this.average * this.busyShare) return null;
    const index = QUALITY_LEVELS.indexOf(level);
    if (index <= 0) return null;
    const step = this.average > this.slowMs * 2 ? "low" : QUALITY_LEVELS[index - 1]!;
    this.reset(now);
    return step;
  }
}

/**
 * Whether a user agent is a phone's or a tablet's. iPadOS Safari asks for
 * desktop sites by default and so says it's a Mac: a "Macintosh" with a
 * touch screen is an iPad.
 */
export function isMobileAgent(userAgent: string, maxTouchPoints = 0): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** Post-effect settings with a preset's costly effects switched off (the same object when none apply). */
export function applyQualityToPostFx(settings: PostFxSettings, quality: QualitySettings): PostFxSettings {
  if (!quality.disabledEffects.some((id) => settings.enabled[id as keyof typeof settings.enabled])) return settings;
  const enabled = { ...settings.enabled };
  for (const id of quality.disabledEffects) if (id in enabled) enabled[id as keyof typeof enabled] = false;
  return { ...settings, enabled };
}
