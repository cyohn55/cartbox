/**
 * The scene viewport's camera (ENGINE_PARITY_ROADMAP.md EP1), as pure functions
 * over a small state, so every move is unit-testable without a canvas:
 *
 * - A free camera — a position, a heading (yaw) and a tilt (pitch) — with a
 *   pivot `distance` ahead of it that orbiting and dollying turn around, the
 *   way Unity's Scene view and Unreal's viewport behave.
 * - Orbit (around the pivot), pan (slide the camera and pivot together), dolly
 *   (toward the pivot; in an orthographic view, zoom), look (turn in place) and
 *   fly (move along the view, WASD-style).
 * - Frame a sphere (F on the selection, Home on everything), keeping the heading.
 * - Perspective, or one of three orthographic views (top, front, side).
 * - The world ray through a point of the viewport, for picking.
 * - The ground grid's lines, spaced for how far away the camera is.
 */

import { orthographicMatrix, projectionMatrix, viewMatrix, multiplyMat4, type Mat4 } from "@cartbox/editor";

export type Vec3 = readonly [number, number, number];

export type ViewKind = "perspective" | "top" | "front" | "side";

export interface ViewportCamera {
  readonly position: Vec3;
  /** Heading in radians: 0 looks down −Z, π/2 looks down −X. */
  readonly yaw: number;
  /** Tilt in radians: positive looks down. */
  readonly pitch: number;
  /** How far ahead the pivot is (what orbit and dolly turn around). */
  readonly distance: number;
  readonly view: ViewKind;
  /** Half the height an orthographic view shows, in world units. */
  readonly orthoSize: number;
}

/** The perspective views' vertical field of view. */
export const VIEWPORT_FOV = (50 * Math.PI) / 180;
/** How far the pitch may tilt (just short of straight up or down, where the heading is lost). */
export const PITCH_LIMIT = Math.PI / 2 - 1e-3;

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const clampPitch = (p: number) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, p));

/** The camera's basis: where it looks (forward), its right and its up. */
export function cameraAxes(camera: Pick<ViewportCamera, "yaw" | "pitch">): { forward: Vec3; right: Vec3; up: Vec3 } {
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const sy = Math.sin(camera.yaw);
  const cy = Math.cos(camera.yaw);
  const forward: Vec3 = [-sy * cp, -sp, -cy * cp];
  const right: Vec3 = [cy, 0, -sy];
  // up = right × forward
  const up: Vec3 = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  return { forward, right, up };
}

/** The pivot: `distance` ahead of the camera. */
export function cameraPivot(camera: ViewportCamera): Vec3 {
  return add(camera.position, cameraAxes(camera).forward, camera.distance);
}

/** A perspective camera looking at `target` from `yaw`/`pitch`, `distance` away. */
export function cameraLookingAt(target: Vec3, yaw: number, pitch: number, distance: number): ViewportCamera {
  const p = clampPitch(pitch);
  const { forward } = cameraAxes({ yaw, pitch: p });
  return { position: add(target, forward, -distance), yaw, pitch: p, distance, view: "perspective", orthoSize: distance * Math.tan(VIEWPORT_FOV / 2) };
}

/** Turn around the pivot (the camera keeps facing it). */
export function orbit(camera: ViewportCamera, dYaw: number, dPitch: number): ViewportCamera {
  const pivot = cameraPivot(camera);
  const yaw = camera.yaw + dYaw;
  const pitch = clampPitch(camera.pitch + dPitch);
  // Orbiting leaves an orthographic view for perspective, as Unity's does.
  const next = cameraLookingAt(pivot, yaw, pitch, camera.distance);
  return { ...next, orthoSize: camera.orthoSize };
}

/** Turn in place (the pivot swings with the view). */
export function look(camera: ViewportCamera, dYaw: number, dPitch: number): ViewportCamera {
  return { ...camera, yaw: camera.yaw + dYaw, pitch: clampPitch(camera.pitch + dPitch), view: "perspective" };
}

/** Slide the camera and its pivot along its right and up, by world units. */
export function pan(camera: ViewportCamera, right: number, up: number): ViewportCamera {
  const axes = cameraAxes(camera);
  return { ...camera, position: add(add(camera.position, axes.right, right), axes.up, up) };
}

/** Move toward the pivot (`factor` < 1) or away from it; an orthographic view zooms instead. */
export function dolly(camera: ViewportCamera, factor: number, minDistance = 1e-3): ViewportCamera {
  if (camera.view !== "perspective") return { ...camera, orthoSize: Math.max(minDistance, camera.orthoSize * factor) };
  const pivot = cameraPivot(camera);
  const distance = Math.max(minDistance, camera.distance * factor);
  return { ...camera, position: add(pivot, cameraAxes(camera).forward, -distance), distance };
}

/**
 * Fly: move by `forward`, `right` and `up` world units — forward and right
 * along the view, up along the world's vertical (Q/E), the way a level editor's
 * WASD flight works.
 */
export function fly(camera: ViewportCamera, move: { readonly forward: number; readonly right: number; readonly up: number }): ViewportCamera {
  const axes = cameraAxes(camera);
  let position = add(camera.position, axes.forward, move.forward);
  position = add(position, axes.right, move.right);
  position = add(position, [0, 1, 0], move.up);
  return { ...camera, position };
}

/**
 * Frame a sphere (`center`, `radius`) so it fills the view, keeping the
 * heading: the camera backs off along its view until the sphere fits both the
 * height and the width.
 */
export function frame(camera: ViewportCamera, center: Vec3, radius: number, aspect: number): ViewportCamera {
  const r = Math.max(1e-3, radius);
  const half = Math.min(VIEWPORT_FOV / 2, Math.atan(Math.tan(VIEWPORT_FOV / 2) * Math.max(1e-3, aspect)));
  const distance = (r / Math.sin(half)) * 1.05;
  const { forward } = cameraAxes(camera);
  return { ...camera, position: add(center, forward, -distance), distance, orthoSize: (r * 1.1) / Math.min(1, Math.max(1e-3, aspect)) };
}

/** Switch to a view, looking at `center`: the orthographic ones straight down an axis. */
export function setView(camera: ViewportCamera, view: ViewKind, center: Vec3): ViewportCamera {
  const angles: Record<ViewKind, [number, number]> = {
    perspective: [camera.yaw, camera.pitch],
    top: [0, PITCH_LIMIT],
    front: [0, 0],
    side: [Math.PI / 2, 0],
  };
  const [yaw, pitch] = view === "perspective" && camera.view === "perspective" ? [camera.yaw, camera.pitch] : view === "perspective" ? [0.6, 0.45] : angles[view];
  const next = cameraLookingAt(center, yaw, pitch, camera.distance);
  return { ...next, view, orthoSize: camera.orthoSize };
}

/** View, projection and their product for a viewport of `aspect` (width / height). */
export function cameraMatrices(camera: ViewportCamera, aspect: number, near: number, far: number): { view: Mat4; projection: Mat4; viewProj: Mat4 } {
  const { forward, up } = cameraAxes(camera);
  // An orthographic view sees the whole scene along its axis, whatever is behind
  // its position: its eye sits halfway down the depth range behind the pivot.
  const eye = camera.view === "perspective" ? camera.position : add(cameraPivot(camera), forward, -far / 2);
  const view = viewMatrix(eye, add(eye, forward), up);
  const projection =
    camera.view === "perspective"
      ? projectionMatrix(VIEWPORT_FOV, aspect, near, far)
      : orthographicMatrix(-camera.orthoSize * aspect, camera.orthoSize * aspect, -camera.orthoSize, camera.orthoSize, near, far);
  return { view, projection, viewProj: multiplyMat4(projection, view) };
}

/**
 * The near and far planes for a scene: far reaches past the scene's bounding
 * sphere however far the camera has flown, near is a small share of that (and
 * of the scene's own size) so depth stays precise. An orthographic view backs
 * its near plane off, since a camera inside the scene still sees what's behind.
 */
export function clipPlanes(camera: ViewportCamera, center: Vec3, radius: number): { near: number; far: number } {
  const toCenter = Math.hypot(center[0] - camera.position[0], center[1] - camera.position[1], center[2] - camera.position[2]);
  const far = Math.max(10, toCenter + radius * 2);
  if (camera.view !== "perspective") return { near: 0.05, far: far * 2 + camera.distance * 2 };
  return { near: Math.max(0.01, Math.min(radius * 0.001, far * 1e-4)), far };
}

/** The world ray through normalised device coordinates (`ndcX`, `ndcY` in −1..1, +Y up). */
export function viewportRay(camera: ViewportCamera, aspect: number, ndcX: number, ndcY: number): { origin: Vec3; dir: Vec3 } {
  const { forward, right, up } = cameraAxes(camera);
  if (camera.view !== "perspective") {
    const origin = add(add(cameraPivot(camera), right, ndcX * camera.orthoSize * aspect), up, ndcY * camera.orthoSize);
    // Start well behind the pivot: an orthographic view sees what's behind its position too.
    return { origin: add(origin, forward, -1e5), dir: forward };
  }
  const th = Math.tan(VIEWPORT_FOV / 2);
  const d = add(add(forward, right, ndcX * th * aspect), up, ndcY * th);
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return { origin: camera.position, dir: [d[0] / l, d[1] / l, d[2] / l] };
}

/** How many world units one pixel spans at `depth` ahead of the camera, in a viewport `height` pixels tall. */
export function unitsPerPixel(camera: ViewportCamera, depth: number, height: number): number {
  if (camera.view !== "perspective") return (camera.orthoSize * 2) / Math.max(1, height);
  return (Math.max(1e-3, depth) * Math.tan(VIEWPORT_FOV / 2) * 2) / Math.max(1, height);
}

/** One grid line: its two ends, and whether it's a major line (every tenth). */
export interface GridLine {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly major: boolean;
}

/**
 * The grid around where the camera looks: on the ground (y = 0) in perspective
 * and top views, on the vertical plane facing a front or side view. The step is
 * a power of ten picked from the camera's distance, so the lines stay a
 * readable spacing apart as it zooms; every tenth line is major.
 */
export function gridLines(camera: ViewportCamera, lines = 40): { step: number; lines: GridLine[] } {
  const reach = camera.view === "perspective" ? Math.max(camera.distance, Math.abs(camera.position[1])) : camera.orthoSize * 2;
  const step = Math.pow(10, Math.floor(Math.log10(Math.max(1e-3, reach / 4))));
  const pivot = camera.view === "perspective" ? groundPoint(camera) : cameraPivot(camera);
  // The plane's two in-plane axes: [u, v] index into xyz; the third is held at 0.
  const [u, v] = camera.view === "front" ? [0, 1] : camera.view === "side" ? [2, 1] : [0, 2];
  const half = (lines / 2) * step;
  const cu = Math.round(pivot[u]! / step) * step;
  const cv = Math.round(pivot[v]! / step) * step;
  const out: GridLine[] = [];
  const point = (pu: number, pv: number): Vec3 => {
    const p: [number, number, number] = [0, 0, 0];
    p[u] = pu;
    p[v] = pv;
    return p;
  };
  for (let i = -lines / 2; i <= lines / 2; i += 1) {
    const ou = cu + i * step;
    const ov = cv + i * step;
    const majorU = Math.round(ou / step) % 10 === 0;
    const majorV = Math.round(ov / step) % 10 === 0;
    out.push({ a: point(ou, cv - half), b: point(ou, cv + half), major: majorU });
    out.push({ a: point(cu - half, ov), b: point(cu + half, ov), major: majorV });
  }
  return { step, lines: out };
}

/** Where the view meets the ground (y = 0), or the pivot when it looks above the horizon. */
function groundPoint(camera: ViewportCamera): Vec3 {
  const { forward } = cameraAxes(camera);
  if (forward[1] < -1e-3) {
    const t = -camera.position[1] / forward[1];
    if (t > 0 && t < camera.distance * 20) return add(camera.position, forward, t);
  }
  return cameraPivot(camera);
}
