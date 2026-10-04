/**
 * The ejected camera of play-in-the-editor (ENGINE_PARITY_ROADMAP.md EP5): the
 * scene view's free camera, as the orbit the player's mesh camera takes — its
 * yaw, pitch and distance about a target given relative to the scene's centre
 * (the same convention as cartbox.meshcam), so the eye lands where the
 * editor's camera is.
 */

import { VIEWPORT_FOV, cameraPivot, type ViewportCamera } from "./viewportCamera";

export function editorOrbit(camera: ViewportCamera, center: readonly [number, number, number]) {
  const pivot = cameraPivot(camera);
  return {
    yaw: camera.yaw,
    pitch: camera.pitch,
    distance: camera.distance,
    target: [pivot[0] - center[0], pivot[1] - center[1], pivot[2] - center[2]] as [number, number, number],
    fov: VIEWPORT_FOV,
    hud: false,
  };
}
