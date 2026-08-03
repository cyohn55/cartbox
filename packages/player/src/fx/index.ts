/**
 * Post-processing FX — the shared effect model, the WebGL pass, and the
 * display-surface decorator that applies the stack to a running cart.
 */

export {
  POST_FX_EFFECTS,
  anyPostFxEnabled,
  defaultPostFxSettings,
  hexToRgb01,
  paramKey,
  parsePostFxSettings,
  uniformsFromSettings,
} from "./postfx.js";
export type {
  PostFxColorDef,
  PostFxEffectDef,
  PostFxEffectId,
  PostFxParamDef,
  PostFxSettings,
  PostFxUniforms,
} from "./postfx.js";
export { PostFxPass } from "./PostFxPass.js";
export type { PostFxSource } from "./PostFxPass.js";
export { PostFxSurface } from "./PostFxSurface.js";
export type { InnerSurfaceFactory } from "./PostFxSurface.js";
export { BloomPyramid } from "./BloomPyramid.js";
export {
  BLOOM_KNEE,
  MAX_PYRAMID_LEVELS,
  MIN_PYRAMID_DIMENSION,
  acesFilmic,
  acesFilmicChannel,
  pyramidLevelCount,
  pyramidLevelSize,
  softKneePrefilter,
} from "./bloomModel.js";
export {
  TILT_SHIFT_FEATHER,
  reflectionFade,
  reflectionSampleY,
  tiltShiftBlur,
} from "./lensModel.js";
