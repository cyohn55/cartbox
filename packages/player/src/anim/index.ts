/**
 * Cinematic gap #1 (animation timeline) — internal barrel for the anim/ modules:
 * the pure playback core (Phase A) plus the runtime foreground surface (Phase B).
 * The player's top-level src/index.ts re-exports the cart-facing parts from here.
 */

export * from "./animModel.js";
export * from "./animPlayer.js";
export * from "./generators.js";
export { AnimatedForegroundSurface } from "./AnimatedForegroundSurface.js";
