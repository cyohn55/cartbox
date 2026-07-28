/**
 * Where a viewer stands inside a map, and the two rules about standing there.
 *
 * This lived in {@link MapWalkCanvas} while that canvas was the only thing that
 * ever put a camera inside the world. It isn't any more — the FX tab previews
 * the shader stack over the same first-person framing — and a second caller
 * would have had to either import a canvas component for two pure functions or
 * re-derive "eye height" from scratch and drift from it.
 *
 * So the camera *value* and the geometry that constrains it live here, apart
 * from any surface that draws through them: no React, no canvas, nothing but the
 * map space.
 */

import { cellContaining, geometryFor, type MapVoxelSpace } from "@cartbox/editor";

/** How high above the ground the eye sits when standing, in cells. */
export const EYE_HEIGHT = 1.7;

/** Vertical field of view, in radians — close to what a block game shows. */
export const WALK_FOV = 1.22;

/** Where the viewer is standing and looking. */
export interface WalkCamera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
}

/** Keep the viewer inside the map, and off the floor below it. */
export function clampToMap(space: MapVoxelSpace, camera: WalkCamera): WalkCamera {
  return {
    ...camera,
    x: Math.max(0, Math.min(space.width - 1, camera.x)),
    y: Math.max(0, Math.min(space.maxHeight - 1, camera.y)),
    z: Math.max(0, Math.min(space.depth - 1, camera.z)),
  };
}

/**
 * Drop the viewer onto whatever is beneath them, at eye height — the "put my feet
 * on the ground" gesture that free movement otherwise lacks.
 */
export function standOnGround(space: MapVoxelSpace, camera: WalkCamera): WalkCamera {
  const geometry = geometryFor(space.shape);
  const [column, , row] = cellContaining(geometry, camera.x, camera.y, camera.z);
  const ground = space.heightAt(column, row);
  return clampToMap(space, { ...camera, y: ground - 0.5 + EYE_HEIGHT });
}

/**
 * A camera standing on the middle of everything that was built, looking at it.
 *
 * The FX preview and any other view that opens on a map it did not navigate to
 * needs somewhere defensible to start: the centre of the map is usually empty
 * air, and dropping the viewer there shows a screen of sky. `contentCentre`
 * answers where the cells actually are, and this stands on that.
 */
export function walkCameraOnContent(space: MapVoxelSpace): WalkCamera {
  const centre = space.contentCentre();
  const x = centre ? centre.x : Math.floor(space.width / 2);
  const z = centre ? centre.z : Math.floor(space.depth / 2);
  return standOnGround(space, { x, y: EYE_HEIGHT, z, yaw: 0.7, pitch: -0.1 });
}
