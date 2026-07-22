/**
 * Walking the world — the pure camera-movement step the /world demo drives from
 * the d-pad (arrow keys / WASD in the browser), and the same math the real
 * handheld will use once the player leaves the customizer and explores.
 *
 * The scene compositor frames whatever world point sits at {@link WalkState.origin}
 * (the look-at), rotated by {@link WalkState.yaw}. So "walking" is simply moving
 * that origin across the ground along the camera's facing, and "turning" is
 * changing the yaw. This module is the single source of that motion: given the
 * current state, the player's intent, and a time step, it returns the next state.
 *
 * Kept pure and framework-free so it unit-tests without a canvas and the React
 * component stays a thin adapter over it — the same split as worldScene.ts.
 */

/** Where the camera looks and which way it faces. */
export interface WalkState {
  /** World point at the screen centre; y is held (no flying) while x/z move. */
  readonly origin: readonly [number, number, number];
  /** Facing about the vertical axis, radians. */
  readonly yaw: number;
}

/**
 * The player's intent this frame, each component in −1..1. `forward` walks along
 * the facing (＋ = into the scene), `strafe` sidesteps (＋ = right), `turn`
 * rotates the facing (＋ = clockwise from above).
 */
export interface WalkInput {
  readonly forward: number;
  readonly strafe: number;
  readonly turn: number;
}

export interface WalkParams {
  /** World units travelled per second at full stick. */
  readonly moveSpeed: number;
  /** Radians turned per second at full stick. */
  readonly turnSpeed: number;
  /** Half-extents the origin is clamped within, so the player stays over ground. */
  readonly bounds: { readonly radiusX: number; readonly radiusZ: number };
}

/** Clamp `value` into `[-limit, limit]`. */
function clampAbs(value: number, limit: number): number {
  return value < -limit ? -limit : value > limit ? limit : value;
}

/**
 * Advance the walk by `deltaSeconds`. Movement is relative to the current facing:
 * forward follows `(sin yaw, 0, −cos yaw)` and right follows `(cos yaw, 0, sin
 * yaw)` — the inverse of the renderer's yaw rotation, so "forward" always heads
 * into the screen. A diagonal (forward ＋ strafe together) is normalised so it is
 * no faster than a straight line, and the origin is clamped to the world bounds.
 * The origin's height is preserved. Returns a new state; the input is untouched.
 */
export function stepWalk(
  state: WalkState,
  input: WalkInput,
  deltaSeconds: number,
  params: WalkParams,
): WalkState {
  const yaw = state.yaw + input.turn * params.turnSpeed * deltaSeconds;

  // Ground-plane basis for the (new) facing.
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  let moveX = input.forward * sinYaw + input.strafe * cosYaw;
  let moveZ = input.forward * -cosYaw + input.strafe * sinYaw;

  // Keep diagonals from outrunning straight-line motion.
  const magnitude = Math.hypot(moveX, moveZ);
  if (magnitude > 1) {
    moveX /= magnitude;
    moveZ /= magnitude;
  }

  const step = params.moveSpeed * deltaSeconds;
  const [x, y, z] = state.origin;
  return {
    origin: [
      clampAbs(x + moveX * step, params.bounds.radiusX),
      y,
      clampAbs(z + moveZ * step, params.bounds.radiusZ),
    ],
    yaw,
  };
}
