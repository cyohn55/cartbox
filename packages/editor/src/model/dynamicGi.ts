/**
 * Real-time global illumination (AAA_FIDELITY_ROADMAP.md F3e): what a rig
 * sets for the AAA tier's live probe volume (dynamicGi.ts in @cartbox/player),
 * and the grid it is traced over.
 *
 * The volume is DDGI's (Majercik et al. 2019): a grid of probes, each holding
 * its irradiance as L2 SH and what it can see as octahedral depth moments
 * (probeVolume.ts, the same format the bake writes). Every frame each probe
 * casts rays in a fresh rotation through the still scene, each hit lit by the
 * rig's lights and by the volume itself (so light bounces as many times as
 * frames pass), and the probes take a share of what came back.
 *
 * Pure and DOM-free.
 */

import { planProbeVolume } from "./probeVolume";

/** What a rig sets. */
export interface DynamicGiSettings {
  /** Rays each probe casts a frame. */
  readonly rays?: number;
  /** How much of its light a probe keeps from frame to frame (0..1): more is steadier, less follows light faster. */
  readonly hysteresis?: number;
  /** About how far apart the probes stand, metres, when the rig has no baked volume to take its grid from. */
  readonly spacing?: number;
}

/** The settings with their defaults. */
export interface DynamicGi {
  readonly rays: number;
  readonly hysteresis: number;
  readonly spacing: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Settings as stored, read defensively; null when absent (the baked light). */
export function parseDynamicGi(value: unknown): DynamicGiSettings | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const out: { rays?: number; hysteresis?: number; spacing?: number } = {};
  if (typeof raw.rays === "number" && Number.isFinite(raw.rays)) out.rays = Math.round(clamp(raw.rays, 16, 256));
  if (typeof raw.hysteresis === "number" && Number.isFinite(raw.hysteresis)) out.hysteresis = clamp(raw.hysteresis, 0, 0.995);
  if (typeof raw.spacing === "number" && Number.isFinite(raw.spacing)) out.spacing = clamp(raw.spacing, 0.5, 20);
  return out;
}

export function resolveDynamicGi(settings: DynamicGiSettings | null | undefined): DynamicGi | null {
  if (!settings) return null;
  return { rays: settings.rays ?? 64, hysteresis: settings.hysteresis ?? 0.97, spacing: settings.spacing ?? 3 };
}

/**
 * Screen-space GI (F3e-2, ssgi.ts in @cartbox/player): on the AAA tier, rays
 * marched across the depth buffer from each pixel bring back the light the
 * surfaces near it sent last frame, so a lit wall bleeds its colour onto the
 * floor beside it. On by default; a rig can turn it off or tune it.
 */
export interface ScreenSpaceGiSettings {
  /** False turns it off. */
  readonly enabled?: boolean;
  /** How far a ray reaches, metres. */
  readonly radius?: number;
  /** Scales the light the rays bring back. */
  readonly intensity?: number;
}

/** Screen-space GI as stored, read defensively; null when absent (the defaults). */
export function parseScreenSpaceGi(value: unknown): ScreenSpaceGiSettings | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const out: { enabled?: boolean; radius?: number; intensity?: number } = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.radius === "number" && Number.isFinite(raw.radius)) out.radius = clamp(raw.radius, 0.5, 16);
  if (typeof raw.intensity === "number" && Number.isFinite(raw.intensity)) out.intensity = clamp(raw.intensity, 0, 4);
  return out;
}

/** What the renderer takes: null when it is off. */
export function resolveScreenSpaceGi(settings: ScreenSpaceGiSettings | null | undefined): { readonly radius: number; readonly intensity: number } | null {
  if (settings?.enabled === false) return null;
  return { radius: settings?.radius ?? 4, intensity: settings?.intensity ?? 1 };
}

/** The grid a scene's live volume is traced over, round its bounds, when no baked volume gives one. */
export function dynamicGiGrid(min: readonly [number, number, number], max: readonly [number, number, number], spacing: number): { min: [number, number, number]; max: [number, number, number]; counts: [number, number, number] } {
  // A little past the bounds, so the outermost surfaces sit inside the grid.
  const pad = spacing * 0.5;
  const lo: [number, number, number] = [min[0] - pad, min[1] - pad * 0.25, min[2] - pad];
  const hi: [number, number, number] = [max[0] + pad, max[1] + pad, max[2] + pad];
  return { min: lo, max: hi, counts: planProbeVolume(lo, hi, spacing) };
}
