/**
 * The single shared 3D coordinate system for the onboarding scene.
 *
 * The backdrop world, the handhelds, and the tagline used to be three unrelated
 * layers stacked by CSS z-index, each with its own ad-hoc placement. This module
 * gives them ONE camera and ONE set of world anchors, so every element is
 * positioned by an `[x, y, z]` coordinate the same way:
 *
 *   +x → right      +y → up      +z → toward the viewer (nearer = larger, in front)
 *
 * Coordinates are in world units (the same units the voxel world is built from, so
 * a handheld's depth and a tree's depth are directly comparable). Edit the three
 * `*_ANCHOR` constants below to reposition each element within the scene.
 *
 * The camera is "view-anchored with real depth": the world still orbits, but the
 * handhelds and tagline hold their on-screen spot (their anchors are camera-space),
 * while their `z` drives both how large they render ({@link perspectiveScale}) and
 * whether the spinning terrain passes in front of or behind them (the world
 * renderer occludes against {@link viewDepth}). It mirrors the projection in the
 * editor's `sceneRenderer.ts` so the projected DOM billboards line up pixel-for-
 * pixel with the voxel occlusion.
 *
 * Pure and DOM-free (bar the tiny layout store at the foot), so the projection is
 * unit-tested on real inputs and outputs rather than mocked.
 */

/** A world-space point, in world units. */
export type Vec3 = readonly [number, number, number];

/**
 * Camera tip toward the viewer, radians. 0 is the level, edge-on view the world
 * backdrop uses, which reads as an orthographic side camera: `x`→right, `y`→up,
 * `z`→depth. Kept as the single camera pitch so every layer shares it.
 */
export const SCENE_PITCH = 0;

/** Seconds for the world to complete one full turn (the calm title-screen drift). */
export const WORLD_ROTATION_PERIOD_SECONDS = 80;

/**
 * The world point each element is anchored to. These are the knobs to position an
 * element within the scene — change the numbers and the element moves in 3D.
 *
 *   WORLD_ANCHOR    — the orbiting terrain's centre. It is the rotating layer, so
 *                     shifting its x/z orbits it around the view; keep it at the
 *                     origin to spin in place.
 *   HANDHELD_ANCHOR — the handhelds' cluster centre (the carousel). At the origin
 *                     it sits centred on screen; raise z to bring it forward
 *                     (bigger, in front of more trees), lower y to set it down
 *                     toward the terrain surface.
 *   TAGLINE_ANCHOR  — the voxel headline. Defaults up and slightly back, so it
 *                     floats above and behind the handhelds.
 */
export const WORLD_ANCHOR: Vec3 = [0, 0, 0];
export const HANDHELD_ANCHOR: Vec3 = [0, 0, 0];
export const TAGLINE_ANCHOR: Vec3 = [0, 40, -10];

/**
 * Perspective focal length, in world units, for the DOM billboards (handhelds and
 * tagline). The voxel world is drawn orthographically, so this governs only how
 * the overlays shrink with depth — larger values flatten the effect. Chosen so a
 * handheld at the default depth (0) renders at exactly scale 1, i.e. unchanged
 * from the pre-3D layout, and reasonable depths stay well clear of the focal plane.
 */
export const CAMERA_FOCAL_UNITS = 260;

/**
 * How much larger (or smaller) than life something at a given camera depth renders.
 * 1 at depth 0; >1 nearer, <1 farther. Clamped away from the focal plane so a point
 * placed at or beyond it can never blow up or invert.
 */
export function perspectiveScale(depth: number): number {
  const distanceToFocalPlane = CAMERA_FOCAL_UNITS - depth;
  if (distanceToFocalPlane <= 1) return CAMERA_FOCAL_UNITS; // guard the singularity
  return CAMERA_FOCAL_UNITS / distanceToFocalPlane;
}

/**
 * The camera-space depth of a world anchor: how near the viewer it is after the
 * camera pitch, in world units (larger = nearer). The world renderer uses this to
 * decide which terrain voxels pass in front of an element — a voxel nearer than an
 * anchor's `viewDepth` is drawn over it.
 */
export function viewDepth(anchor: Vec3): number {
  return anchor[1] * Math.sin(SCENE_PITCH) + anchor[2] * Math.cos(SCENE_PITCH);
}

/**
 * How the shared scene currently maps world units to the screen. Published by the
 * world renderer each time it (re)builds — it owns the zoom (`pixelsPerUnit`) and
 * the viewport it fills — and read by the DOM billboards so they project through
 * the exact same camera. See {@link publishSceneLayout}.
 */
export interface SceneLayout {
  /** CSS pixels per world unit at depth 0 — the shared zoom. */
  readonly pixelsPerUnit: number;
  /** Viewport size in CSS pixels; the camera origin projects to its centre. */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/**
 * An anchor projected to the screen: an offset (CSS pixels) from the viewport
 * centre and the perspective scale to render at. Both the handheld carousel and
 * the tagline are centred elements, so a CSS `translate(offsetX, offsetY)
 * scale(scale)` places them at their anchor.
 */
export interface ProjectedAnchor {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly scale: number;
  /** Camera-space depth (larger = nearer), for sorting against the world. */
  readonly depth: number;
}

/**
 * Project a world anchor to a screen offset + scale under the shared camera. The
 * camera origin (`[0, 0, 0]`) lands at the viewport centre, matching the world
 * renderer, so an element at the origin sits centred at scale 1. Mirrors the
 * point projection in `sceneRenderer.ts` (yaw fixed at 0 — the overlays are
 * view-anchored — plus a perspective scale the orthographic world does not apply).
 */
export function projectAnchor(anchor: Vec3, layout: SceneLayout): ProjectedAnchor {
  const cosPitch = Math.cos(SCENE_PITCH);
  const sinPitch = Math.sin(SCENE_PITCH);
  const [x, y, z] = anchor;
  const cameraY = y * cosPitch - z * sinPitch;
  const cameraZ = y * sinPitch + z * cosPitch;
  const scale = perspectiveScale(cameraZ);
  return {
    offsetX: x * layout.pixelsPerUnit * scale,
    offsetY: -cameraY * layout.pixelsPerUnit * scale, // screen y grows downward
    scale,
    depth: cameraZ,
  };
}

// --- Layout store: the renderer publishes, the DOM billboards subscribe. -------
// A tiny module-level store (the same pattern the carousel already uses for its
// flank-art cache) so the world renderer, which owns the live camera zoom, is the
// single authority and the DOM layers never re-derive it.

let currentLayout: SceneLayout | null = null;
const layoutListeners = new Set<() => void>();

/** Publish the current scene layout, notifying every subscribed billboard. */
export function publishSceneLayout(layout: SceneLayout): void {
  currentLayout = layout;
  for (const listener of layoutListeners) listener();
}

/** The most recently published layout, or null before the renderer's first build. */
export function getSceneLayout(): SceneLayout | null {
  return currentLayout;
}

/** Subscribe to layout changes (resize/rebuild). Returns an unsubscribe function. */
export function subscribeSceneLayout(listener: () => void): () => void {
  layoutListeners.add(listener);
  return () => {
    layoutListeners.delete(listener);
  };
}
