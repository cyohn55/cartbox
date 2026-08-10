/**
 * The HD-2D world runtime: a height-mapped 3D tile world with the cart's 2D
 * character sprites composited into it as depth-sorted, camera-facing billboards.
 * See {@link worldScene} for the pure geometry and {@link WorldOverlaySurface} for
 * the per-frame compositing decorator.
 */

export {
  parseWorldScene,
  buildTerrainInstances,
  buildBillboardInstance,
  buildWorldCamera,
  worldCenter,
  cellAt,
  defaultCameraSpec,
  CELL_WORLD,
  HEIGHT_WORLD,
} from "./worldScene.js";
export type {
  WorldScene,
  WorldTileCell,
  WorldBillboard,
  WorldCameraSpec,
  WorldCamera,
  TextureLookup,
} from "./worldScene.js";
export { WorldOverlaySurface } from "./WorldOverlaySurface.js";
export type { WorldBillboardPose } from "./WorldOverlaySurface.js";
