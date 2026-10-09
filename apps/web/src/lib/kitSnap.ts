/**
 * Kit snapping (HALO_INFINITE_STYLE_ROADMAP.md I14): a modular piece dragged
 * near another snaps to it edge to edge, so walls, floors and trims line up
 * without hand-typed coordinates.
 *
 * It works on world bounding boxes, which for kit pieces (axis-aligned, made
 * on a grid) are the pieces themselves. When one of the moving box's faces
 * comes within `radius` of an opposite face of another box that it overlaps
 * across, the gap closes so they touch. Then, along the other two axes, the
 * moving box's edges line up with the other's — floor with floor, side with
 * side, or centred — when they are within `radius` of doing so. Pure.
 */

export type Vec3 = [number, number, number];

export interface Aabb {
  readonly min: readonly number[];
  readonly max: readonly number[];
}

export interface KitSnap {
  /** How far to move the box so it sits edge to edge. */
  readonly delta: Vec3;
  /** Which of `others` it snapped to, and across which axis they touch. */
  readonly target: number;
  readonly axis: 0 | 1 | 2;
}

/** How near (in world units) a face or edge must come to snap, by default. */
export const KIT_SNAP_RADIUS = 0.35;

/** The smallest of the tangent alignments within `radius` (edges flush at either end, or centred), else 0. */
function align(moving: Aabb, other: Aabb, axis: number, radius: number): number {
  const options = [
    other.min[axis]! - moving.min[axis]!,
    other.max[axis]! - moving.max[axis]!,
    (other.min[axis]! + other.max[axis]!) / 2 - (moving.min[axis]! + moving.max[axis]!) / 2,
  ].filter((d) => Math.abs(d) <= radius);
  return options.length === 0 ? 0 : options.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
}

/** Where a moving box snaps among `others`, or null when none is near enough. */
export function kitSnap(moving: Aabb, others: readonly Aabb[], radius = KIT_SNAP_RADIUS): KitSnap | null {
  let best: KitSnap | null = null;
  let bestCost = Infinity;
  others.forEach((other, target) => {
    for (const axis of [0, 1, 2] as const) {
      const [b, c] = [0, 1, 2].filter((k) => k !== axis) as [number, number];
      // Facing each other across this axis: their extents overlap (or nearly) along the other two.
      const across = [b, c].every((k) => moving.max[k]! > other.min[k]! - radius && moving.min[k]! < other.max[k]! + radius);
      if (!across) continue;
      // Close (or open) the gap to the face on the moving box's own side — never snap into the other box.
      const candidates = [
        { gap: other.min[axis]! - moving.max[axis]!, side: moving.min[axis]! < other.min[axis]! },
        { gap: other.max[axis]! - moving.min[axis]!, side: moving.max[axis]! > other.max[axis]! },
      ];
      for (const { gap, side } of candidates) {
        if (!side || Math.abs(gap) > radius) continue;
        const delta: Vec3 = [0, 0, 0];
        delta[axis] = gap;
        delta[b] = align(moving, other, b, radius);
        delta[c] = align(moving, other, c, radius);
        const cost = Math.abs(gap) + 0.5 * (Math.abs(delta[b]) + Math.abs(delta[c]));
        if (cost < bestCost) {
          bestCost = cost;
          best = { delta, target, axis };
        }
      }
    }
  });
  return best;
}
