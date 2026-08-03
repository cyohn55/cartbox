/**
 * Pure lens-and-surface maths the single-pass post-process shader is a port of,
 * kept DOM-free so the same arithmetic the GLSL runs can be unit-tested headlessly
 * — the pattern {@link ./bloomModel.ts} established for bloom.
 *
 * Two screen-space effects for the cinematic 2.5D look share this file because
 * both key their behaviour off the vertical screen coordinate — the only "depth"
 * a flat frame has:
 *
 * - Tilt-shift depth of field: a horizontal band of the frame stays sharp and
 *   everything above/below it blurs, the miniature-diorama look REPLACED and THE
 *   LAST NIGHT lean on. Screen row stands in for distance.
 * - Screen-space reflection: the picture above a horizon line is mirrored down
 *   into the floor below it and faded with distance, the wet-street reflection
 *   those games use everywhere (and that Neon City hand-rolled per cart).
 *
 * The UV convention matches the shader: y = 0 is the top row, y = 1 the bottom.
 */

/** Feather distance (in screen-height units) over which DoF ramps to full blur. */
export const TILT_SHIFT_FEATHER = 0.35;

/** A tiny epsilon so a zero span never divides. */
const EPSILON = 1e-3;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Blur weight, 0..1, for a pixel at screen row `y` given a tilt-shift focus band.
 *
 * Inside the band — within `range` of `focus` — the weight is 0 (perfectly
 * sharp). Outside it, the weight ramps up linearly over {@link TILT_SHIFT_FEATHER}
 * and saturates at 1, so the transition from focus to full blur is smooth rather
 * than a hard edge. The shader multiplies this by the effect strength to get the
 * sampling radius, so a returned 0 costs nothing and reads as untouched.
 *
 * @param y      Screen row, 0 (top) .. 1 (bottom).
 * @param focus  Centre of the in-focus band, 0..1.
 * @param range  Half-height of the fully-sharp band, in screen-height units.
 */
export function tiltShiftBlur(y: number, focus: number, range: number): number {
  const outside = Math.abs(y - focus) - Math.max(0, range);
  if (outside <= 0) return 0;
  return clamp01(outside / TILT_SHIFT_FEATHER);
}

/**
 * The source row to sample for a mirror reflection of `y` about `horizon`.
 *
 * A pixel `d` below the horizon reflects the pixel `d` above it, so the world
 * standing on the floor appears upside-down in it. Returned unclamped; the shader
 * clamps to the frame and the {@link reflectionFade} of an off-frame sample is
 * already near zero.
 */
export function reflectionSampleY(y: number, horizon: number): number {
  return horizon - (y - horizon);
}

/**
 * Reflection opacity, 0..1, for a pixel at screen row `y`.
 *
 * Zero at and above the horizon (nothing reflects into the scene itself), then
 * fading linearly from full strength at the horizon to zero `falloff` below it —
 * a wet floor mirrors what is close to the waterline sharply and loses the far
 * scene, which is what sells it as a surface rather than a flip of the image.
 *
 * @param y        Screen row, 0 (top) .. 1 (bottom).
 * @param horizon  Row of the reflective surface's near edge, 0..1.
 * @param falloff  How far below the horizon the reflection persists, in screen-height units.
 */
export function reflectionFade(y: number, horizon: number, falloff: number): number {
  const below = y - horizon;
  if (below <= 0) return 0;
  return clamp01(1 - below / Math.max(EPSILON, falloff));
}
