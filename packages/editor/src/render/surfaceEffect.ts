/**
 * Surface effects on one object (HALO2_STYLE_ROADMAP.md, H11): a material
 * override a scene instance can carry for a moment — a Spartan's shield
 * flaring where it's hit, the shimmer of it recharging, the see-through of
 * Active Camo. Layered over whatever materials the mesh has (Modern-tier, PBR
 * materials), identically in the software rasteriser, WGSL and GLSL:
 *
 * - `rim`: a fresnel rim of light added over the material's, at `rimPower`.
 * - `glow`: light added over the whole surface (like emissive, but untextured).
 * - `bands`: bands of light sweeping up the body — a recharge shimmer.
 * - `camo`: that share of the surface's pixels dropped (screen-door
 *   transparency on an ordered-dither pattern that crawls with time), so the
 *   scene shows through; with a rim it reads as a cloaked outline.
 */

export interface SurfaceEffect {
  readonly rim?: readonly [number, number, number];
  readonly rimPower?: number;
  readonly glow?: readonly [number, number, number];
  readonly bands?: readonly [number, number, number];
  /** 0 (solid) .. 1 (gone). */
  readonly camo?: number;
}

/** Bands per world unit (radians), how fast they climb, and how sharp they are. */
export const EFFECT_BAND_FREQUENCY = 9;
export const EFFECT_BAND_SPEED = 7;
export const EFFECT_BAND_POWER = 6;
/** How many times a second the camo pattern steps. */
export const EFFECT_CAMO_CRAWL = 12;
/** The effect rim's fresnel power when it doesn't give one. */
export const EFFECT_RIM_POWER = 2;

/** The 2×2 ordered-dither matrix [[0, 2], [3, 1]] at (x, y). */
function bayer2(x: number, y: number): number {
  return y & 1 ? (x & 1 ? 1 : 3) : x & 1 ? 2 : 0;
}

/** The camo threshold (0..1) at framebuffer pixel (x, y) and `time`: a pixel is dropped when it is below the camo amount. */
export function camoThreshold(x: number, y: number, time: number): number {
  const s = Math.floor(time * EFFECT_CAMO_CRAWL);
  const px = x + s;
  const py = y + s * 3;
  return (4 * bayer2(px, py) + bayer2(px >> 1, py >> 1) + 0.5) / 16;
}

/** How much of the band light reaches world height `y` at `time` (0..1). */
export function bandAmount(y: number, time: number): number {
  return Math.pow(0.5 + 0.5 * Math.sin(y * EFFECT_BAND_FREQUENCY - time * EFFECT_BAND_SPEED), EFFECT_BAND_POWER);
}

/** Whether an effect changes anything. */
export function effectActive(e: SurfaceEffect | null | undefined): e is SurfaceEffect {
  if (!e) return false;
  const any = (c?: readonly number[]) => !!c && (c[0]! > 0 || c[1]! > 0 || c[2]! > 0);
  return any(e.rim) || any(e.glow) || any(e.bands) || (e.camo ?? 0) > 0;
}

/** A shield's colours (H11): the gold flare of a hit, its white-gold recharge bands, and Active Camo's cool edge. */
export const SHIELD_FLARE_RIM: readonly [number, number, number] = [1.9, 1.4, 0.45];
export const SHIELD_FLARE_GLOW: readonly [number, number, number] = [0.45, 0.33, 0.08];
export const SHIELD_SHIMMER_BANDS: readonly [number, number, number] = [1.0, 0.85, 0.45];
export const SHIELD_CAMO_RIM: readonly [number, number, number] = [0.35, 0.5, 0.7];
/** The share of a fully cloaked surface's pixels dropped (the rest keep its outline readable). */
export const SHIELD_CAMO_MAX = 0.88;

const unit = (v: number | undefined) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v!)) : 0);

/**
 * A shield's state as a surface effect — `flare` (a hit, fading), `shimmer`
 * (recharging) and `camo` (Active Camo), each 0..1 — or null when all are 0.
 * The flare is a hot rim plus a little glow; the shimmer, bands climbing the
 * body with a faint rim; camo drops most pixels and outlines what's left.
 */
export function shieldEffect(flare: number, shimmer: number, camo: number): SurfaceEffect | null {
  const f = unit(flare);
  const s = unit(shimmer);
  const c = unit(camo);
  if (f === 0 && s === 0 && c === 0) return null;
  const rim: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k += 1) rim[k] = SHIELD_FLARE_RIM[k]! * (f + 0.25 * s) + SHIELD_CAMO_RIM[k]! * c;
  return {
    rim,
    // A hit's flare hugs more of the body than camo's thin edge.
    rimPower: f >= c ? 1.5 : 3,
    glow: [SHIELD_FLARE_GLOW[0] * f, SHIELD_FLARE_GLOW[1] * f, SHIELD_FLARE_GLOW[2] * f],
    bands: [SHIELD_SHIMMER_BANDS[0] * s, SHIELD_SHIMMER_BANDS[1] * s, SHIELD_SHIMMER_BANDS[2] * s],
    camo: c * SHIELD_CAMO_MAX,
  };
}
