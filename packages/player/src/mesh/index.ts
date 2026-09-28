/**
 * Runtime 3D meshes (optional): a cart declares a mesh sidecar (imported OBJ/
 * glTF geometry with placement transforms); the player rasterises it over each
 * frame with the same pure software rasteriser the editor previews with, no cart
 * code needed. Phase 2 of the mesh asset feature.
 */

export { MeshOverlaySurface } from "./MeshOverlaySurface.js";
export { parseMeshScene, buildOrbitCamera, orbitPitchAboveTerrain } from "./meshScene.js";
export { sceneObjectsSdkLua, luaQuote } from "./sceneObjectsSdk.js";
export type { MeshScene, MeshInstance, PrefabPool, SceneBounds, SceneCamera as MeshSceneCamera } from "./meshScene.js";
