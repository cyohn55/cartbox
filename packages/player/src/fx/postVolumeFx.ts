/**
 * The post volumes around the camera (EDITOR_PRO_ROADMAP.md P6), applied to
 * the cart's post-FX stack. The scene's mesh surface reports what the volumes
 * make of the picture ({@link PostVolumeFx}); this folds it into the cart's own
 * settings: the grade multiplies the cart's grade (a volume's 0.8 saturation
 * takes the cart's 1.1 to 0.88), and bloom and fog mix from the cart's values
 * toward the volume's by how far into it the camera is. Exposure isn't here:
 * the scene renderer's tone map takes that.
 */

import { paramKey, type PostFxSettings } from "./postfx.js";

export interface PostVolumeFx {
  readonly brightness?: number;
  readonly contrast?: number;
  readonly saturation?: number;
  /** Bloom and fog as the volumes blend them, and how far they reach the camera (0..1). */
  readonly bloom?: number;
  readonly bloomReach: number;
  readonly fog?: number;
  readonly fogReach: number;
}

/** The cart's settings with the volumes applied (the same object when none apply). */
export function applyPostVolumes(base: PostFxSettings, post: PostVolumeFx | null): PostFxSettings {
  if (!post) return base;
  const values = { ...base.values };
  const enabled = { ...base.enabled };
  let changed = false;
  for (const key of ["brightness", "contrast", "saturation"] as const) {
    const v = post[key];
    if (v === undefined || v === 1) continue;
    const k = paramKey("grade", key);
    values[k] = (enabled.grade ? (values[k] ?? 1) : 1) * v;
    enabled.grade = true;
    changed = true;
  }
  const mix = (effect: "bloom" | "fog", param: string, value: number | undefined, reach: number) => {
    if (value === undefined || !(reach > 0)) return;
    const k = paramKey(effect, param);
    const own = enabled[effect] ? (values[k] ?? 0) : 0;
    values[k] = own * (1 - reach) + value;
    enabled[effect] = true;
    changed = true;
  };
  mix("bloom", "strength", post.bloom, post.bloomReach);
  mix("fog", "density", post.fog, post.fogReach);
  return changed ? { ...base, enabled, values } : base;
}
