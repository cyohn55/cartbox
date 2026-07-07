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
