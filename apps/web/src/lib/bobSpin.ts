/**
 * The idle motion of a background prop: a slow vertical bob, interrupted every so
 * often by a single smooth full turn before it settles back to bobbing.
 *
 * Pure and time-driven — `propMotion(seconds, params)` maps an absolute clock to
 * a {@link MotionState}, so it is deterministic, needs no per-frame state, and is
 * unit-testable. Each prop gets its own phases so the scene never moves in
 * lockstep.
 */

export interface MotionParams {
  /** Peak vertical travel of the bob, in the caller's units (e.g. pixels). */
  readonly bobAmplitude: number;
  /** Seconds for one full up-down bob. */
  readonly bobPeriod: number;
  /** Bob phase offset, 0..1 of a period. */
  readonly bobPhase: number;
  /** Seconds between the start of one spin and the next. */
  readonly spinCycle: number;
  /** Seconds a single full turn takes. Must be < spinCycle to leave idle time. */
  readonly spinDuration: number;
  /** Spin phase offset, 0..1 of a cycle, so props don't all spin together. */
  readonly spinPhase: number;
}

export interface MotionState {
  /** Rotation about the vertical axis, radians (0 when idle). */
  readonly yaw: number;
  /** Vertical offset from rest, same units as `bobAmplitude`. */
  readonly bobY: number;
}

/** Smooth 0→1 acceleration/deceleration (cosine ease), so a spin has no jerk. */
function easeInOut(t: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
}

const TWO_PI = Math.PI * 2;

/**
 * The prop's bob offset and spin angle at `seconds`. The prop bobs continuously;
 * once per `spinCycle` it eases through a single 360° turn over `spinDuration`,
 * returning to 0 (a full turn is visually identical to rest) for the remainder.
 */
export function propMotion(seconds: number, params: MotionParams): MotionState {
  const bobY = Math.sin(TWO_PI * (seconds / params.bobPeriod + params.bobPhase)) * params.bobAmplitude;

  const cycle = Math.max(params.spinDuration, params.spinCycle);
  const offset = params.spinPhase * cycle;
  const position = ((seconds + offset) % cycle + cycle) % cycle;
  const yaw = position < params.spinDuration ? easeInOut(position / params.spinDuration) * TWO_PI : 0;

  return { yaw, bobY };
}
