/**
 * Refraction and distortion (HALO_INFINITE_STYLE_ROADMAP.md I5): a surface
 * that bends what's behind it — glass, plasma, a shield's shimmer, Active
 * Camo, heat haze.
 *
 * Every renderer does it the same way. The opaque scene is drawn first and
 * kept (the software rasteriser snapshots its frame; the GPU renderers copy
 * theirs as the see-through pass begins). A refracting fragment then reads
 * that frame at its own pixel pushed by an offset, instead of what is under it:
 *
 * - the **bend**, the surface normal seen from the camera (curved glass pulls
 *   the view toward its edges, a flat pane facing the camera barely moves it);
 * - the **warp**, two channels of value noise drifting through the surface over
 *   time (heat haze, plasma, a shield's shimmer).
 *
 * A blended surface lays its colour over what it bends, an added one adds to
 * it, and a shield's effect lets the bent view through at its silhouette.
 * Active Camo's dropped pixels show the bent view instead of the view straight
 * behind. The offset only takes a pixel the opaque scene drew that lies behind
 * the surface (a nearer object is never pulled into it); failing that it takes
 * the pixel straight behind; failing that (nothing drawn there) the surface
 * draws as it would without refraction.
 *
 * A frame drawn over what was already there (`background: null`) differs by
 * backend in one way. The software rasteriser bends those pixels too — which is
 * how a held weapon on the front layer, drawn over the finished scene, bends
 * the scene. The GPU renderers read back only what they drew, so over the
 * cart's own 2D frame they bend only their own scene.
 */

import type { MeshMaterial } from "../model/MeshAsset";
import { valueNoise } from "../model/materialGraph";
import type { SurfaceEffect } from "./surfaceEffect";

/** The offset at bend or warp 1, as a share of the frame's height. */
export const REFRACTION_SCALE = 0.1;
/** Noise cells per world unit in the warp. */
export const DISTORTION_FREQUENCY = 4;
/** How fast the warp's noise drifts (world units per second, upward like rising heat). */
export const DISTORTION_SPEED = 1.5;
/** How strongly Active Camo bends what's behind it. */
export const CAMO_BEND = 0.6;
/** …and how much it shimmers. */
export const CAMO_WARP = 0.25;
/** A shield effect's distortion shows at its silhouette: this power of 1 − N·V. */
export const EFFECT_DISTORT_POWER = 1.5;

const unit = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** A draw's refraction: its bend and warp, and its effect's silhouette distortion. */
export interface ResolvedRefraction {
  readonly bend: number;
  readonly warp: number;
  /** A surface effect's distortion (0..1), shown at the silhouette of an opaque surface. */
  readonly edge: number;
}

export const NO_REFRACTION: ResolvedRefraction = { bend: 0, warp: 0, edge: 0 };

/** A material's (and its draw's surface effect's) refraction. */
export function resolveRefraction(material: Pick<MeshMaterial, "refraction" | "distortion">, effect: SurfaceEffect | null | undefined): ResolvedRefraction {
  const camo = unit(effect?.camo) > 0;
  return {
    bend: unit(material.refraction) + (camo ? CAMO_BEND : 0),
    warp: unit(material.distortion) + (camo ? CAMO_WARP : 0),
    edge: unit(effect?.distort),
  };
}

/** Whether a draw reads what's behind it, and so draws after the opaque scene. */
export function refracts(r: ResolvedRefraction): boolean {
  return r.bend > 0 || r.warp > 0 || r.edge > 0;
}

/** Whether a material asks to refract, which (like a layer) puts it on the PBR path. */
export function materialRefracts(material: Pick<MeshMaterial, "refraction" | "distortion">): boolean {
  return unit(material.refraction) > 0 || unit(material.distortion) > 0;
}

/**
 * The offset, in pixels (x right, y down), at a fragment: `nx`, `ny` are its
 * normal along the camera's right and up, `(px, py, pz)` its world position,
 * `height` the frame's height in pixels. Mirrors `refractOffset` in both GPU
 * shaders, whose noise hashes bit for bit as {@link valueNoise} does.
 */
export function refractionOffset(r: ResolvedRefraction, nx: number, ny: number, px: number, py: number, pz: number, time: number, height: number): [number, number] {
  let wx = 0;
  let wy = 0;
  const warp = r.warp + r.edge;
  if (warp > 0) {
    const f = DISTORTION_FREQUENCY;
    const qy = py * f - time * DISTORTION_SPEED;
    wx = (2 * valueNoise(px * f, qy, pz * f) - 1) * warp;
    wy = (2 * valueNoise(px * f + 17, qy + 31, pz * f + 47) - 1) * warp;
  }
  const k = REFRACTION_SCALE * height;
  return [(r.bend * nx + wx) * k, (-r.bend * ny + wy) * k];
}
