/**
 * The pure arithmetic behind the HDR bloom + tonemap stage, split out from the
 * WebGL plumbing so the algorithm can be validated headlessly (no GL context)
 * and so {@link BloomPyramid}'s shaders are a faithful port of code that has
 * tests rather than the other way round.
 *
 * Three pieces model gap #4's two halves — a real multi-scale bloom and an HDR
 * rolloff: how deep the blur pyramid goes for a given frame, the soft-knee
 * bright pass that seeds it, and the ACES filmic curve that maps the summed HDR
 * light back into the displayable 0..1 range. Every function here has an exact
 * GLSL twin in {@link BloomPyramid} and {@link PostFxPass}; keeping them in step
 * is the whole point of testing this layer.
 */

/** Below this many pixels a further halving has nothing left to blur. */
export const MIN_PYRAMID_DIMENSION = 4;

/** The pyramid never grows past this many levels, whatever the resolution. */
export const MAX_PYRAMID_LEVELS = 6;

/**
 * The soft-knee half-width of the bright pass, as a fraction of the 0..1 range.
 * A hard threshold makes bloom pop on and off as a pixel crosses it; the knee
 * fades contribution in across `threshold ± knee` so motion stays smooth.
 */
export const BLOOM_KNEE = 0.5;

/** Guards the divisions in the prefilter and tonemap against a zero input. */
const EPSILON = 1e-4;

/**
 * How many downsample levels a frame of the given size supports: each level
 * halves both dimensions, stopping once the shorter side would fall below
 * {@link MIN_PYRAMID_DIMENSION} or {@link MAX_PYRAMID_LEVELS} is reached. Always
 * at least one, so a bloom is drawn even for a tiny frame.
 */
export function pyramidLevelCount(
  width: number,
  height: number,
  maxLevels: number = MAX_PYRAMID_LEVELS,
): number {
  let shorterSide = Math.min(width, height);
  let levels = 0;
  while (levels < maxLevels && Math.floor(shorterSide / 2) >= MIN_PYRAMID_DIMENSION) {
    shorterSide = Math.floor(shorterSide / 2);
    levels += 1;
  }
  return Math.max(1, levels);
}

/** The pixel size of pyramid level `index` (0 = half the base resolution). */
export function pyramidLevelSize(
  baseWidth: number,
  baseHeight: number,
  index: number,
): { width: number; height: number } {
  const divisor = 2 ** (index + 1);
  return {
    width: Math.max(1, Math.floor(baseWidth / divisor)),
    height: Math.max(1, Math.floor(baseHeight / divisor)),
  };
}

/**
 * The soft-knee bright pass (Unity's bloom prefilter). Returns the input colour
 * scaled by how far its brightest channel sits above `threshold`: nothing below
 * `threshold - knee`, the full colour above `threshold + knee`, a quadratic ramp
 * between. Scaling the whole colour rather than each channel keeps the hue of a
 * bright pixel intact instead of tinting the glow toward whichever channel
 * crossed first.
 */
export function softKneePrefilter(
  rgb: readonly [number, number, number],
  threshold: number,
  knee: number = BLOOM_KNEE,
): [number, number, number] {
  const brightest = Math.max(rgb[0], rgb[1], rgb[2]);
  const kneeWidth = Math.max(knee, EPSILON);
  let soft = brightest - threshold + kneeWidth;
  soft = Math.min(Math.max(soft, 0), 2 * kneeWidth);
  soft = (soft * soft) / (4 * kneeWidth + EPSILON);
  const contribution = Math.max(soft, brightest - threshold) / Math.max(brightest, EPSILON);
  const clamped = Math.max(contribution, 0);
  return [rgb[0] * clamped, rgb[1] * clamped, rgb[2] * clamped];
}

/**
 * The ACES filmic tonemap for one channel: an S-curve that is near-linear in the
 * shadows and rolls asymptotically toward 1 in the highlights, so summed HDR
 * light compresses into range instead of clipping flat to white. Narkowicz's
 * fitted approximation of the full ACES curve.
 */
export function acesFilmicChannel(x: number): number {
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  const mapped = (x * (a * x + b)) / (x * (c * x + d) + e);
  return Math.min(Math.max(mapped, 0), 1);
}

/**
 * Apply the ACES rolloff to an RGB colour after an exposure multiply. The result
 * is always within 0..1, so however bright the pre-tonemap light was, nothing
 * clips — it rolls off instead.
 */
export function acesFilmic(
  rgb: readonly [number, number, number],
  exposure: number = 1,
): [number, number, number] {
  return [
    acesFilmicChannel(rgb[0] * exposure),
    acesFilmicChannel(rgb[1] * exposure),
    acesFilmicChannel(rgb[2] * exposure),
  ];
}
