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
 *   effects; cheap per-pixel looks like grading, CRT or dithering stay), and the
 *   first-person software view capped at half size.
 *
 * Terrain keeps full detail less far on the lower presets (60% and 30% of the
 * authored distance), so distant ground costs fewer triangles.
 *
 * "auto" picks one from what the browser says about the device: weak hardware
 * (≤ 2 cores or ≤ 2 GB of memory) → low; a phone or tablet, or any device with
 * no GPU renderer (WebGPU or WebGL2, so rendering on the CPU) → medium; otherwise
 * high.
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
  /** The largest 3D render scale for a software first-person view (the governor works below it). */
  readonly maxRenderScale: number;
  /** Post-effects this preset turns off (the costly multi-pass ones). */
  readonly disabledEffects: readonly string[];
  /**
   * How far terrain keeps its detail, as a share of each block's authored
   * distance: lower presets drop to the coarser blocks sooner.
   */
  readonly terrainDetail: number;
}

export const QUALITY_PRESETS: Readonly<Record<QualityLevel, QualitySettings>> = {
  high: { level: "high", shadows: true, shadowMapSize: 1024, maxRenderScale: 1, disabledEffects: [], terrainDetail: 1 },
  medium: { level: "medium", shadows: true, shadowMapSize: 512, maxRenderScale: 0.75, disabledEffects: [], terrainDetail: 0.6 },
  low: { level: "low", shadows: false, shadowMapSize: 512, maxRenderScale: 0.5, disabledEffects: ["bloom", "chroma"], terrainDetail: 0.3 },
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
  const mobile = nav.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? "");
  return {
    ...(typeof nav.hardwareConcurrency === "number" ? { cores: nav.hardwareConcurrency } : {}),
    ...(typeof nav.deviceMemory === "number" ? { memoryGB: nav.deviceMemory } : {}),
    mobile,
    ...(webgpu === undefined ? {} : { webgpu }),
  };
}

/** Post-effect settings with a preset's costly effects switched off (the same object when none apply). */
export function applyQualityToPostFx(settings: PostFxSettings, quality: QualitySettings): PostFxSettings {
  if (!quality.disabledEffects.some((id) => settings.enabled[id as keyof typeof settings.enabled])) return settings;
  const enabled = { ...settings.enabled };
  for (const id of quality.disabledEffects) if (id in enabled) enabled[id as keyof typeof enabled] = false;
  return { ...settings, enabled };
}
