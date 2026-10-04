/**
 * Transform gizmos for the scene viewport (ENGINE_PARITY_ROADMAP.md EP2), as
 * pure functions: where the handles are, which one the cursor is over, and
 * what a drag on it does — so the maths is unit-testable without a canvas.
 *
 * - Move: an arrow per axis, a square per plane (drag in two axes at once) and
 *   a centre dot (drag in the plane facing the camera).
 * - Rotate: a ring per axis.
 * - Scale: an axis per local axis with a box at its tip, and a centre box for
 *   all three at once. Scaling is always along the object's own axes (a TRS
 *   transform can't hold a world-axis scale of a rotated object).
 *
 * Move and rotate work in world or local space. Every drag is measured from
 * where it started (never accumulated per pointer move), so snapping is exact
 * and nothing drifts: move snaps the position to a grid step, rotate the angle
 * to an angle step, scale the result to a scale step.
 */

import { composeModelMatrix, decomposeModelMatrix, invertAffine, multiplyMat4, type Mat4 } from "@cartbox/editor";

export type Vec3 = readonly [number, number, number];
export type GizmoTool = "move" | "rotate" | "scale";
export type GizmoSpace = "world" | "local";
export type Axis = 0 | 1 | 2;

export type Handle =
  | { readonly kind: "axis"; readonly axis: Axis }
  | { readonly kind: "plane"; readonly axis: Axis } // the plane's normal
  | { readonly kind: "ring"; readonly axis: Axis }
  | { readonly kind: "center" };

export interface Ray {
  readonly origin: Vec3;
  readonly dir: Vec3;
}

/** Where the gizmo stands: its origin, its three unit axes, and how long an arm is in world units. */
export interface GizmoFrame {
  readonly origin: Vec3;
  readonly axes: readonly [Vec3, Vec3, Vec3];
  readonly size: number;
}

export interface Transform {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

/** How long a gizmo arm is on screen. */
export const GIZMO_PIXELS = 96;
/** How close (in pixels) the cursor must be to grab a handle. */
export const GIZMO_TOLERANCE = 8;
/** Where the plane squares sit along their two axes (share of an arm). */
const PLANE_FROM = 0.22;
const PLANE_TO = 0.42;
/** The rotate rings' radius (share of an arm). */
const RING_RADIUS = 0.95;
const RING_SEGMENTS = 64;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addScaled = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const WORLD_AXES: readonly [Vec3, Vec3, Vec3] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/**
 * The gizmo for an object with world matrix `world`: at its origin, along the
 * world axes or its own (normalised) axes, `size` world units an arm. The scale
 * tool always uses the object's own axes.
 */
export function gizmoFrame(world: Mat4, tool: GizmoTool, space: GizmoSpace, size: number): GizmoFrame {
  const origin: Vec3 = [world[12]!, world[13]!, world[14]!];
  if (space === "world" && tool !== "scale") return { origin, axes: WORLD_AXES, size };
  const column = (c: number): Vec3 => {
    const v: Vec3 = [world[c * 4]!, world[c * 4 + 1]!, world[c * 4 + 2]!];
    return length(v) < 1e-9 ? WORLD_AXES[c]! : normalize(v);
  };
  return { origin, axes: [column(0), column(1), column(2)], size };
}

/** The points of an axis's rotate ring, in world space. */
export function ringPoints(frame: GizmoFrame, axis: Axis, segments = RING_SEGMENTS): Vec3[] {
  const u = frame.axes[((axis + 1) % 3) as Axis];
  const v = frame.axes[((axis + 2) % 3) as Axis];
  const r = frame.size * RING_RADIUS;
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    out.push(addScaled(addScaled(frame.origin, u, Math.cos(a) * r), v, Math.sin(a) * r));
  }
  return out;
}

/** A plane square's four corners (the plane whose normal is `axis`), in world space. */
export function planeSquare(frame: GizmoFrame, axis: Axis): [Vec3, Vec3, Vec3, Vec3] {
  const u = frame.axes[((axis + 1) % 3) as Axis];
  const v = frame.axes[((axis + 2) % 3) as Axis];
  const at = (a: number, b: number) => addScaled(addScaled(frame.origin, u, a * frame.size), v, b * frame.size);
  return [at(PLANE_FROM, PLANE_FROM), at(PLANE_TO, PLANE_FROM), at(PLANE_TO, PLANE_TO), at(PLANE_FROM, PLANE_TO)];
}

/** An arm's tip. */
export function axisTip(frame: GizmoFrame, axis: Axis): Vec3 {
  return addScaled(frame.origin, frame.axes[axis], frame.size);
}

type Projector = (p: Vec3) => readonly [number, number] | null;

function segmentDistance(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

function insidePolygon(p: readonly [number, number], poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * The handle under the cursor (canvas pixels), or null. Plane squares and the
 * centre take precedence over the arms they sit between; among arms or rings,
 * the nearest within the tolerance wins.
 */
export function hitHandle(tool: GizmoTool, frame: GizmoFrame, project: Projector, cursor: readonly [number, number], tolerance = GIZMO_TOLERANCE): Handle | null {
  const o = project(frame.origin);
  if (!o) return null;
  if (tool === "rotate") {
    let best: Handle | null = null;
    let bestD = tolerance;
    for (const axis of [0, 1, 2] as Axis[]) {
      const pts = ringPoints(frame, axis).map(project);
      for (let i = 1; i < pts.length; i += 1) {
        const a = pts[i - 1];
        const b = pts[i];
        if (!a || !b) continue;
        const d = segmentDistance(cursor, a, b);
        if (d < bestD) {
          bestD = d;
          best = { kind: "ring", axis };
        }
      }
    }
    return best;
  }
  if (Math.hypot(cursor[0] - o[0], cursor[1] - o[1]) <= tolerance + 1) return { kind: "center" };
  if (tool === "move") {
    for (const axis of [0, 1, 2] as Axis[]) {
      const quad = planeSquare(frame, axis).map(project);
      if (quad.every((q) => q) && insidePolygon(cursor, quad as [number, number][])) return { kind: "plane", axis };
    }
  }
  let best: Handle | null = null;
  let bestD = tolerance;
  for (const axis of [0, 1, 2] as Axis[]) {
    const tip = project(axisTip(frame, axis));
    if (!tip) continue;
    const d = segmentDistance(cursor, o, tip);
    if (d < bestD) {
      bestD = d;
      best = { kind: "axis", axis };
    }
  }
  return best;
}

/** How far along a line (`origin` + t·`axis`) the point nearest a ray is, or null when the ray runs along the line. */
export function axisParameter(ray: Ray, origin: Vec3, axis: Vec3): number | null {
  const w0 = sub(origin, ray.origin);
  const b = dot(axis, ray.dir);
  const denom = dot(axis, axis) * dot(ray.dir, ray.dir) - b * b;
  if (Math.abs(denom) < 1e-6) return null;
  return (b * dot(ray.dir, w0) - dot(ray.dir, ray.dir) * dot(axis, w0)) / denom;
}

/** Where a ray meets a plane (through `origin`, facing `normal`), or null when it runs along it or away. */
export function planeHit(ray: Ray, origin: Vec3, normal: Vec3): Vec3 | null {
  const denom = dot(ray.dir, normal);
  if (Math.abs(denom) < 1e-6) return null;
  const t = dot(sub(origin, ray.origin), normal) / denom;
  if (!Number.isFinite(t)) return null;
  return addScaled(ray.origin, ray.dir, t);
}

const snapTo = (v: number, step: number) => (step > 0 ? Math.round(v / step) * step : v);

/** Snapping steps, or null for a free drag. */
export interface SnapSteps {
  readonly move: number;
  /** Degrees. */
  readonly rotate: number;
  readonly scale: number;
}

/**
 * Where a move drag puts the object (world position), from where the drag
 * started (`ray0`, the object at `start`) to the cursor's ray now. `viewForward`
 * is the camera's view direction, for the centre handle's camera-facing plane.
 * With snapping, the moved coordinates land on the grid: world coordinates in
 * world space, distances along the gizmo's axes in local space.
 */
export function dragMove(handle: Handle, frame: GizmoFrame, start: Vec3, ray0: Ray, ray: Ray, viewForward: Vec3, snap: SnapSteps | null, space: GizmoSpace): Vec3 {
  let along: number[] = [0, 0, 0]; // movement along each gizmo axis
  if (handle.kind === "axis") {
    const t0 = axisParameter(ray0, frame.origin, frame.axes[handle.axis]);
    const t1 = axisParameter(ray, frame.origin, frame.axes[handle.axis]);
    if (t0 === null || t1 === null) return start;
    along[handle.axis] = t1 - t0;
  } else {
    const normal = handle.kind === "plane" ? frame.axes[handle.axis] : viewForward;
    const p0 = planeHit(ray0, frame.origin, normal);
    const p1 = planeHit(ray, frame.origin, normal);
    if (!p0 || !p1) return start;
    const d = sub(p1, p0);
    along = frame.axes.map((a) => dot(d, a));
    if (handle.kind === "plane") along[handle.axis] = 0;
  }
  if (snap && space === "local") along = along.map((v) => snapTo(v, snap.move));
  let out: Vec3 = start;
  for (const k of [0, 1, 2] as Axis[]) out = addScaled(out, frame.axes[k], along[k]!);
  if (snap && space === "world") {
    // Only the coordinates the drag moves snap; the others keep their value.
    const moved = handle.kind === "axis" ? [handle.axis] : handle.kind === "plane" ? ([0, 1, 2] as Axis[]).filter((k) => k !== handle.axis) : [0, 1, 2];
    out = out.map((v, k) => (moved.includes(k) ? snapTo(v, snap.move) : start[k]!)) as unknown as Vec3;
  }
  return out;
}

/**
 * The angle (radians) a rotate drag on a ring has turned, about the ring's axis
 * (right-handed), snapped to the angle step. A ring seen edge-on falls back to
 * the cursor's sideways movement.
 */
export function dragRotate(handle: Handle, frame: GizmoFrame, ray0: Ray, ray: Ray, snap: SnapSteps | null, cursorDx = 0): number {
  if (handle.kind !== "ring") return 0;
  const axis = frame.axes[handle.axis];
  let angle: number;
  const p0 = planeHit(ray0, frame.origin, axis);
  const p1 = planeHit(ray, frame.origin, axis);
  if (p0 && p1 && Math.abs(dot(normalize(ray.dir), axis)) > 0.05) {
    const v0 = sub(p0, frame.origin);
    const v1 = sub(p1, frame.origin);
    angle = Math.atan2(dot(cross(v0, v1), axis), dot(v0, v1));
  } else {
    angle = cursorDx * 0.01;
  }
  if (snap) angle = (snapTo((angle * 180) / Math.PI, snap.rotate) * Math.PI) / 180;
  return angle;
}

/**
 * The scale a scale drag gives (per local axis, from `start`): an arm by how far
 * along it the cursor has gone relative to where it grabbed, the centre by the
 * cursor's distance from the gizmo's centre on screen. Snapped results land on
 * multiples of the scale step (never below one step).
 */
export function dragScale(
  handle: Handle,
  frame: GizmoFrame,
  start: readonly [number, number, number],
  ray0: Ray,
  ray: Ray,
  screen: { readonly origin: readonly [number, number]; readonly cursor0: readonly [number, number]; readonly cursor: readonly [number, number] },
  snap: SnapSteps | null,
): [number, number, number] {
  const factor: [number, number, number] = [1, 1, 1];
  if (handle.kind === "axis") {
    const t0 = axisParameter(ray0, frame.origin, frame.axes[handle.axis]);
    const t1 = axisParameter(ray, frame.origin, frame.axes[handle.axis]);
    if (t0 !== null && t1 !== null && Math.abs(t0) > 1e-6) factor[handle.axis] = t1 / t0;
  } else if (handle.kind === "center") {
    const d0 = Math.hypot(screen.cursor0[0] - screen.origin[0], screen.cursor0[1] - screen.origin[1]);
    const d1 = Math.hypot(screen.cursor[0] - screen.origin[0], screen.cursor[1] - screen.origin[1]);
    // Grabbed right at the centre: drag right or up to grow.
    const f = d0 > 4 ? d1 / d0 : Math.exp(((screen.cursor[0] - screen.cursor0[0]) - (screen.cursor[1] - screen.cursor0[1])) * 0.01);
    factor[0] = factor[1] = factor[2] = f;
  }
  return start.map((s, k) => {
    const v = s * factor[k]!;
    if (!snap || factor[k] === 1) return clampScale(v);
    const sign = v < 0 ? -1 : 1;
    return clampScale(sign * Math.max(snap.scale, snapTo(Math.abs(v), snap.scale)));
  }) as [number, number, number];
}

const clampScale = (v: number) => (Math.abs(v) < 1e-3 ? (v < 0 ? -1e-3 : 1e-3) : Math.max(-1e4, Math.min(1e4, v)));

/** The local position that puts an object (under `parentWorld`, or at the top level) at world position `world`. */
export function localPositionFor(world: Vec3, parentWorld: Mat4 | null): [number, number, number] {
  if (!parentWorld) return [world[0], world[1], world[2]];
  const inv = invertAffine(parentWorld);
  if (!inv) return [world[0], world[1], world[2]];
  return [
    inv[0]! * world[0] + inv[4]! * world[1] + inv[8]! * world[2] + inv[12]!,
    inv[1]! * world[0] + inv[5]! * world[1] + inv[9]! * world[2] + inv[13]!,
    inv[2]! * world[0] + inv[6]! * world[1] + inv[10]! * world[2] + inv[14]!,
  ];
}

/** A rotation of `angle` radians about the unit world `axis` (column-major 4×4). */
function axisRotation(axis: Vec3, angle: number): Mat4 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return Float64Array.from([
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ]);
}

/**
 * The transform after turning an object `angle` radians about the world `axis`
 * through its own origin. Position and scale are kept exactly as they were; the
 * rotation is the new orientation in the parent's space.
 */
export function rotatedTransform(start: Transform, parentWorld: Mat4 | null, axis: Vec3, angle: number): Transform {
  const local = composeModelMatrix(start.position, start.rotation, start.scale);
  const world = parentWorld ? multiplyMat4(parentWorld, local) : local;
  const turned = multiplyMat4(axisRotation(axis, angle), world);
  turned[12] = world[12]!;
  turned[13] = world[13]!;
  turned[14] = world[14]!;
  const inv = parentWorld ? invertAffine(parentWorld) : null;
  const back = inv ? multiplyMat4(inv, turned) : turned;
  return { position: start.position, rotation: decomposeModelMatrix(back).rotation, scale: start.scale };
}

/** A point turned `angle` radians about the world `axis` through `pivot` (moving several objects as one). */
export function rotateAbout(point: Vec3, pivot: Vec3, axis: Vec3, angle: number): Vec3 {
  const m = axisRotation(axis, angle);
  const x = point[0] - pivot[0];
  const y = point[1] - pivot[1];
  const z = point[2] - pivot[2];
  return [pivot[0] + m[0]! * x + m[4]! * y + m[8]! * z, pivot[1] + m[1]! * x + m[5]! * y + m[9]! * z, pivot[2] + m[2]! * x + m[6]! * y + m[10]! * z];
}
