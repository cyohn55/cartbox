/**
 * @cartbox/player scene — a runtime parallax + atmosphere backdrop.
 *
 * A cart declares a {@link SceneSpec} (layers pointing at regions of its own
 * sprite sheet, at depths, with aerial-perspective atmosphere). The player reads
 * those regions from the loaded cart ({@link createCartSpriteSource}), resolves
 * them to parallax layers, and {@link SceneBackdropSurface} composites the
 * backdrop behind the cart's live frame each tick — ahead of any lighting / FX.
 * Every piece is framework-agnostic and separately testable.
 */

export {
  composeParallax,
  hazeColor,
  parallaxOf,
  prehazeLayers,
  type AtmosphereParams,
  type ParallaxCamera,
  type ParallaxLayer,
  type Rgb,
} from "./parallaxScene.js";
export {
  parseScene,
  DEFAULT_ATMOSPHERE,
  type SceneSpec,
  type SceneLayer,
  type SceneCamera,
  type SpriteRegion,
} from "./sceneModel.js";
export {
  resolveSceneLayers,
  renderSceneBackdrop,
  cameraAt,
  fillSky,
  type SpriteRegionSource,
  type RegionImage,
} from "./sceneRender.js";
export { compositeOverBackdrop } from "./sceneComposite.js";
export { createCartSpriteSource, type CartSpriteSource } from "./cartSpriteSource.js";
export { SceneBackdropSurface } from "./SceneBackdropSurface.js";
