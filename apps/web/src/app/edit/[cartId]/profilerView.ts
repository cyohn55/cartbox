/**
 * The profiler panel's pure parts: which sections make up a frame, and how they
 * fill the frame budget. See ProfilerPanel.tsx.
 */

import type { ProfileSection, ProfileSnapshot } from "@cartbox/player";

/** The sections shown as the frame's parts, in order, with their colours. */
export const PARTS: { section: ProfileSection; label: string; hint: string; color: string }[] = [
  { section: "cart", label: "Cart", hint: "The engine's tick: your Lua, its 2D drawing and the chip sound", color: "#41a6f6" },
  { section: "runtime", label: "Physics & runtime", hint: "Physics, spawning, animation and timelines", color: "#a7f070" },
  { section: "render", label: "Render", hint: "Presenting the frame: 3D scene, layers and effects", color: "#ef7d57" },
  { section: "audio", label: "Audio", hint: "Handing the frame's sound to the browser", color: "#ffcd75" },
  { section: "net", label: "Network", hint: "The multiplayer session", color: "#b13e53" },
];
/** Where a frame's time goes, as fractions of the frame budget (a part over budget fills the rest). */
export function budgetBar(profile: ProfileSnapshot, budgetMs: number): { section: ProfileSection; fraction: number }[] {
  let left = 1;
  return PARTS.map(({ section }) => {
    const fraction = Math.min(left, profile.sections[section].avg / budgetMs);
    left -= fraction;
    return { section, fraction };
  });
}

