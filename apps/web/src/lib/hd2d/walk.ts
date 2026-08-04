// Walk controls for the HD-2D route: a pure step that moves the character across
// the ground under a FIXED ¾ camera (Octopath-style — the camera follows, it does
// not turn). Movement is screen-relative (transformed by the camera yaw so "up"
// heads into the scene), speed-normalised on the diagonal, clamped to the street,
// and it derives facing + advances the walk-cycle phase. Framework-free so it
// unit-tests without a canvas.

export interface CharState {
  /** Foot-centre world position; y is held (no flying). */
  readonly pos: readonly [number, number, number];
  /** +1 faces right, -1 faces left. */
  readonly facing: 1 | -1;
  /** Walk-cycle phase, radians (0 = idle). */
  readonly walkPhase: number;
  readonly moving: boolean;
}

export interface WalkKeys {
  readonly left: boolean;
  readonly right: boolean;
  readonly up: boolean;
  readonly down: boolean;
}

export interface WalkParams {
  /** World units per second at full input. */
  readonly speed: number;
  /** The (fixed) camera yaw the input is rotated by, radians. */
  readonly yaw: number;
  /** Half-extents the foot is clamped within. */
  readonly bounds: { readonly radiusX: number; readonly radiusZ: number };
  /** Walk-cycle radians per second while moving. */
  readonly stride: number;
}

const clamp = (v: number, limit: number): number => (v < -limit ? -limit : v > limit ? limit : v);

export function stepCharacter(state: CharState, keys: WalkKeys, deltaSeconds: number, params: WalkParams): CharState {
  const forward = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);   // into / out of the screen
  const strafe = (keys.right ? 1 : 0) - (keys.left ? 1 : 0); // right / left

  // Screen-relative basis under the fixed camera yaw (inverse of the render rotation).
  const sinYaw = Math.sin(params.yaw), cosYaw = Math.cos(params.yaw);
  let moveX = forward * sinYaw + strafe * cosYaw;
  let moveZ = forward * -cosYaw + strafe * sinYaw;
  const length = Math.hypot(moveX, moveZ);
  const moving = length > 1e-4;
  if (moving) { moveX /= length; moveZ /= length; } // normalise so diagonals aren't faster

  const x = clamp(state.pos[0] + moveX * params.speed * deltaSeconds, params.bounds.radiusX);
  const z = clamp(state.pos[2] + moveZ * params.speed * deltaSeconds, params.bounds.radiusZ);

  let facing = state.facing;
  if (moveX > 0.05) facing = 1;
  else if (moveX < -0.05) facing = -1;

  const walkPhase = moving ? state.walkPhase + params.stride * deltaSeconds : 0;
  return { pos: [x, state.pos[1], z], facing, walkPhase, moving };
}
