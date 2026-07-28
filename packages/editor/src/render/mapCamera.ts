/**
 * The two cameras the map's 3D view uses, described once.
 *
 * There are three consumers that must agree exactly about where the camera is
 * and which way it faces: the CPU rasteriser (orbiting), the CPU ray marcher
 * (walking), and the GPU renderer (both). Any disagreement between them is a
 * view that jumps, a mirror, or — worst and most confusing — a crosshair that
 * names a different cell from the one drawn under it. So the basis and the
 * projection live here, as plain numbers with no renderer attached, and each
 * consumer reads rather than re-derives them.
 *
 * Conventions, shared with the rest of the map code: **x is the map column
 * (east), z is the map row (south), y is height**. That triple is right-handed,
 * which is what fixes screen-right rather than leaving it to taste.
 *
 * Pure and DOM-free.
 */

import { firstPersonBasis, type FirstPersonBasis } from "./mapRaycaster";

export type { FirstPersonBasis as CameraBasis };

/**
 * The orbit camera's basis, read straight out of the projection the CPU
 * rasteriser performs (`voxelModelRenderer.drawModelInto`):
 *
 * ```
 * screenX =  wx*cos + wz*sin
 * screenY = -(wx*sin*sinPitch + wy*cosPitch - wz*cos*sinPitch)
 * depth   = -wx*sin*cosPitch + wy*sinPitch + wz*cos*cosPitch   (larger = nearer)
 * ```
 *
 * Reading the coefficients off as vectors gives right and up directly; forward
 * (into the screen) is the negated depth axis, since that renderer keeps the
 * *largest* depth. Deriving it this way rather than writing three plausible
 * vectors is the point — it is the same camera by construction, so a model drawn
 * on the GPU lands pixel-for-pixel where the CPU put it.
 */
export function orbitBasis(yaw: number, pitch: number): FirstPersonBasis {
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  return {
    right: [cosYaw, 0, sinYaw],
    up: [sinYaw * sinPitch, cosPitch, -cosYaw * sinPitch],
    forward: [sinYaw * cosPitch, -sinPitch, -cosYaw * cosPitch],
  };
}

export { firstPersonBasis };

/**
 * How camera-space coordinates become clip space, as the four numbers a shader
 * needs. Both projections share one form:
 *
 * ```
 * clip = vec4(cx * scaleX, cy * scaleY, cz * depthScale + depthBias,
 *             mix(1, cz, perspective))
 * ```
 *
 * One formula for both cameras means one vertex shader, and no chance of the
 * orthographic path quietly drifting from the perspective one.
 */
export interface Projection {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly depthScale: number;
  readonly depthBias: number;
  /** 1 for a perspective divide, 0 for none. */
  readonly perspective: number;
}

export interface OrthographicOptions {
  /** Output pixels per world unit — the orbit view's zoom. */
  readonly cell: number;
  readonly width: number;
  readonly height: number;
  /**
   * Half-depth of the visible slab, in world units. Anything beyond it clips, so
   * it must cover the built window rather than merely the model in front of you.
   */
  readonly range: number;
}

/** The orbit view's projection: no divide, depth mapped linearly onto 0..1. */
export function orthographicProjection(options: OrthographicOptions): Projection {
  const range = Math.max(1e-3, options.range);
  return {
    scaleX: (2 * options.cell) / Math.max(1, options.width),
    scaleY: (2 * options.cell) / Math.max(1, options.height),
    depthScale: 0.5 / range,
    depthBias: 0.5,
    perspective: 0,
  };
}

export interface PerspectiveOptions {
  /** Vertical field of view, radians. */
  readonly fov: number;
  readonly width: number;
  readonly height: number;
  readonly near: number;
  readonly far: number;
}

/** The walking view's projection: a standard 0..1 depth perspective divide. */
export function perspectiveProjection(options: PerspectiveOptions): Projection {
  const halfHeight = Math.tan(options.fov / 2);
  const aspect = Math.max(1, options.width) / Math.max(1, options.height);
  const near = Math.max(1e-4, options.near);
  const far = Math.max(near + 1e-3, options.far);
  return {
    scaleX: 1 / (halfHeight * aspect),
    scaleY: 1 / halfHeight,
    depthScale: far / (far - near),
    depthBias: (-near * far) / (far - near),
    perspective: 1,
  };
}

/** A ray in world space. */
export interface WorldRay {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
}

/**
 * The world ray through a point on the frame, given as fractions of the canvas
 * from its top-left corner. This is how a pointer becomes a pick once the image
 * itself is a GPU texture with no buffers to read back: cast this one ray with
 * {@link castMapRay} and the answer is the surface actually drawn there.
 */
export function screenRay(
  eye: readonly [number, number, number],
  basis: FirstPersonBasis,
  projection: Projection,
  fractionX: number,
  fractionY: number,
): WorldRay {
  const ndcX = fractionX * 2 - 1;
  const ndcY = 1 - fractionY * 2;
  const acrossX = ndcX / projection.scaleX;
  const acrossY = ndcY / projection.scaleY;
  const { right, up, forward } = basis;

  if (projection.perspective > 0) {
    return {
      origin: eye,
      direction: [
        forward[0] + right[0] * acrossX + up[0] * acrossY,
        forward[1] + right[1] * acrossX + up[1] * acrossY,
        forward[2] + right[2] * acrossX + up[2] * acrossY,
      ],
    };
  }

  // Orthographic: every ray runs along the view axis, so the *origin* is what
  // the screen position moves. Backing it up by the slab's depth keeps the start
  // behind anything the slab can contain.
  const back = projection.depthBias / projection.depthScale;
  return {
    origin: [
      eye[0] + right[0] * acrossX + up[0] * acrossY - forward[0] * back,
      eye[1] + right[1] * acrossX + up[1] * acrossY - forward[1] * back,
      eye[2] + right[2] * acrossX + up[2] * acrossY - forward[2] * back,
    ],
    direction: forward,
  };
}

/**
 * Where a world point lands on the frame, as canvas fractions plus its camera
 * depth — the inverse of {@link screenRay}, for drawing a cursor over the cell a
 * pick found. Depth is returned so a caller can tell "behind me" from "in front".
 */
export function projectToScreen(
  eye: readonly [number, number, number],
  basis: FirstPersonBasis,
  projection: Projection,
  point: readonly [number, number, number],
): { readonly x: number; readonly y: number; readonly depth: number } {
  const rx = point[0] - eye[0];
  const ry = point[1] - eye[1];
  const rz = point[2] - eye[2];
  const { right, up, forward } = basis;
  const cx = rx * right[0] + ry * right[1] + rz * right[2];
  const cy = rx * up[0] + ry * up[1] + rz * up[2];
  const cz = rx * forward[0] + ry * forward[1] + rz * forward[2];
  const w = projection.perspective > 0 ? cz : 1;
  const ndcX = (cx * projection.scaleX) / (w || 1e-6);
  const ndcY = (cy * projection.scaleY) / (w || 1e-6);
  return { x: (ndcX + 1) / 2, y: (1 - ndcY) / 2, depth: cz };
}
