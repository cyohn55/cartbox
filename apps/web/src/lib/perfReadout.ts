/**
 * The frame-rate readout's second line (Start menu → Show FPS): where the
 * frame's time goes, read from the player's profiler — enough for a player to
 * tell us what their device spends a frame on.
 */

import type { ProfileSnapshot } from "@cartbox/player";

const ms = (n: number | undefined | null) => (n === undefined || n === null || !Number.isFinite(n) ? "–" : n < 10 ? n.toFixed(1) : n.toFixed(0));

/**
 * One line: the frame's average cost and its parts (the game's Lua, the 3D and
 * its shadow, sky and scene passes), the GPU's time where the browser can say,
 * the renderer and the graphics preset — e.g.
 * "frame 18 ms · game 6.1 · 3D 11 (shadow 2.1, sky 1.4, scene 6.0) · GPU 9.2 · webgpu · high".
 */
export function perfLine(profile: ProfileSnapshot | null, quality: string | undefined): string | null {
  if (!profile || profile.frames === 0) return null;
  const s = profile.sections;
  const parts = [`frame ${ms(profile.total.avg)} ms`, `game ${ms(s.cart.avg)}`];
  if (profile.render) parts.push(`3D ${ms(s.render.avg)} (shadow ${ms(s.shadow.avg)}, sky ${ms(s.sky.avg)}, scene ${ms(s.scene.avg)})`);
  if (profile.render?.gpuMs !== null && profile.render?.gpuMs !== undefined) parts.push(`GPU ${ms(profile.render.gpuMs)}`);
  if (profile.render) parts.push(profile.render.backend);
  if (quality) parts.push(quality);
  return parts.join(" · ");
}
