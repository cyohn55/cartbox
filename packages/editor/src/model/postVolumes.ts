/**
 * Post-process volumes and eye adaptation (EDITOR_PRO_ROADMAP.md P6), after
 * Unreal's Post Process Volume and auto-exposure.
 *
 * A **post volume** is a box in the scene that, while the camera is inside it,
 * changes how the picture is finished: exposure (in stops), the grade
 * (brightness, contrast, saturation), bloom and fog. Its effect fades in over
 * `blend` metres outside the box, so walking into a base dims and cools the
 * view gradually rather than at a line; where volumes overlap, the one of
 * higher priority wins in proportion to its weight.
 *
 * **Eye adaptation** sets the exposure from what the camera sees: the frame's
 * log-average luminance is driven toward mid-grey, within limits, brightening
 * slowly (stepping into a dark base) and darkening faster (stepping out into
 * the sunlit canyon), as eyes do.
 *
 * Pure and DOM-free: the player applies the results each frame.
 */

export interface PostVolume {
  readonly id: string;
  readonly name: string;
  /** World centre and full size of the box. */
  readonly center: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  /** Metres outside the box over which its effect fades to nothing (0 = a hard edge). */
  readonly blend: number;
  /** Higher priority is applied later, over lower (default 0). */
  readonly priority?: number;
  /** Exposure change in stops (−4..4): −1 halves the light, +1 doubles it. */
  readonly exposure?: number;
  readonly brightness?: number;
  readonly contrast?: number;
  readonly saturation?: number;
  /** Bloom strength (0..1.5). */
  readonly bloom?: number;
  /** Fog density (0..1). */
  readonly fog?: number;
  /** The physical camera's f-number here (F4c; 1.2..22). */
  readonly aperture?: number;
  /** Metres to the plane in focus here (F4c). */
  readonly focusDistance?: number;
  /** The motion blur's strength here, times the shutter's (F4c; 0..2). */
  readonly motionBlur?: number;
}

/** What the volumes around the camera make of the picture: each field only where a volume sets it. */
export interface PostBlend {
  /** Stops of exposure to add (0 = none). */
  readonly exposure: number;
  readonly brightness?: number;
  readonly contrast?: number;
  readonly saturation?: number;
  readonly bloom?: number;
  readonly fog?: number;
  /** The camera's (F4c): blended from the camera's own values, each set only where a volume sets it. */
  readonly aperture?: number;
  readonly focusDistance?: number;
  readonly motionBlur?: number;
}

/** The neutral value of each grade field: what "no volume" means for it. */
const NEUTRAL = { brightness: 1, contrast: 1, saturation: 1 } as const;

/** How much of a volume applies at world point `p`: 1 inside, easing to 0 at `blend` metres out. */
export function volumeWeight(v: Pick<PostVolume, "center" | "size" | "blend">, p: readonly [number, number, number]): number {
  // Distance from p to the box (0 inside).
  let d2 = 0;
  for (let k = 0; k < 3; k += 1) {
    const out = Math.abs(p[k]! - v.center[k]!) - v.size[k]! / 2;
    if (out > 0) d2 += out * out;
  }
  if (d2 === 0) return 1;
  if (!(v.blend > 0)) return 0;
  const t = Math.max(0, 1 - Math.sqrt(d2) / v.blend);
  return t * t * (3 - 2 * t);
}

/**
 * Blend the volumes at the camera's position: lowest priority first, each
 * pulling every field it sets toward its own value by its weight (from the
 * neutral value, for the grade, or from what lower volumes made of it).
 */
export function blendPostVolumes(
  volumes: readonly PostVolume[] | undefined,
  eye: readonly [number, number, number],
  /** The physical camera's own aperture, focus and motion blur (F4c), which a volume pulls away from. */
  camera: { readonly aperture: number; readonly focusDistance: number; readonly motionBlur: number } = { aperture: 16, focusDistance: 10, motionBlur: 1 },
): PostBlend {
  const out: { exposure: number; brightness?: number; contrast?: number; saturation?: number; bloom?: number; fog?: number; aperture?: number; focusDistance?: number; motionBlur?: number } = { exposure: 0 };
  if (!volumes || volumes.length === 0) return out;
  const ordered = [...volumes].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  for (const v of ordered) {
    const w = volumeWeight(v, eye);
    if (w <= 0) continue;
    if (v.exposure !== undefined) out.exposure += (v.exposure - out.exposure) * w;
    for (const key of ["brightness", "contrast", "saturation"] as const) {
      const value = v[key];
      if (value !== undefined) out[key] = (out[key] ?? NEUTRAL[key]) + (value - (out[key] ?? NEUTRAL[key])) * w;
    }
    // Bloom and fog fade from "as the cart has them": a volume that sets them
    // passes its weight on, so the player mixes them with the cart's own values.
    if (v.bloom !== undefined) out.bloom = v.bloom * w + (out.bloom ?? 0) * (1 - w);
    if (v.fog !== undefined) out.fog = v.fog * w + (out.fog ?? 0) * (1 - w);
    // The camera's (F4c), pulled from the camera's own values as the grade is from neutral.
    for (const key of ["aperture", "focusDistance", "motionBlur"] as const) {
      const value = v[key];
      if (value !== undefined) out[key] = (out[key] ?? camera[key]) + (value - (out[key] ?? camera[key])) * w;
    }
  }
  return out;
}

/** The weight with which the volumes reach the camera, for bloom and fog: the largest single weight. */
export function postVolumeReach(volumes: readonly PostVolume[] | undefined, eye: readonly [number, number, number], field: "bloom" | "fog"): number {
  let best = 0;
  for (const v of volumes ?? []) if (v[field] !== undefined) best = Math.max(best, volumeWeight(v, eye));
  return best;
}

// --- Eye adaptation ----------------------------------------------------------------------

export interface AutoExposure {
  /** The darkest and brightest the exposure may go, in stops (e.g. −2 and +3). */
  readonly min: number;
  readonly max: number;
  /** Stops per second the eye brightens (into the dark) and darkens (into the light). */
  readonly up: number;
  readonly down: number;
  /** The mid-grey the frame's average is driven to (0.05..0.5; 0.18 is photographic mid-grey). */
  readonly key: number;
}

export const DEFAULT_AUTO_EXPOSURE: AutoExposure = { min: -2, max: 3, up: 1.2, down: 3, key: 0.18 };

/** sRGB byte → linear light. */
const LINEAR = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/**
 * The frame's log-average (geometric mean) luminance, linear, sampled on a
 * grid about `samples` points large (cheap enough to run every few frames).
 * Pixels with no alpha (nothing drawn) are skipped.
 */
export function frameLuminance(rgba: ArrayLike<number>, width: number, height: number, samples = 1024): number {
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / Math.max(1, samples))));
  let sum = 0;
  let count = 0;
  for (let y = Math.floor(step / 2); y < height; y += step) {
    for (let x = Math.floor(step / 2); x < width; x += step) {
      const o = (y * width + x) * 4;
      if (rgba[o + 3] === 0) continue;
      const l = 0.2126 * LINEAR[rgba[o]!]! + 0.7152 * LINEAR[rgba[o + 1]!]! + 0.0722 * LINEAR[rgba[o + 2]!]!;
      sum += Math.log(Math.max(1e-4, l));
      count += 1;
    }
  }
  return count > 0 ? Math.exp(sum / count) : AUTO_KEY_FALLBACK;
}

const AUTO_KEY_FALLBACK = 0.18;

/**
 * Step the eye's adaptation: given the exposure (stops) the frame was drawn
 * with and its measured luminance, move toward the exposure that would bring
 * that luminance to the key — no faster than the adaptation speeds over `dt`
 * seconds, and within the limits.
 */
export function adaptExposure(current: number, measured: number, ae: AutoExposure, dt: number): number {
  // What the scene would measure with no exposure change, then what change brings it to the key.
  const unexposed = Math.max(1e-5, measured) / 2 ** current;
  const target = Math.max(ae.min, Math.min(ae.max, Math.log2(ae.key / unexposed)));
  const delta = target - current;
  const rate = (delta > 0 ? ae.up : ae.down) * Math.max(0, dt);
  return current + Math.sign(delta) * Math.min(Math.abs(delta), rate);
}

// --- Storage -----------------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const triple = (v: unknown): [number, number, number] | null => (Array.isArray(v) && v.length === 3 && v.every(finite) ? [v[0] as number, v[1] as number, v[2] as number] : null);

/** Read stored post volumes defensively: malformed ones dropped, values clamped. */
export function readPostVolumes(value: unknown): PostVolume[] {
  if (!Array.isArray(value)) return [];
  const out: PostVolume[] = [];
  for (const raw of value.slice(0, 64)) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const center = triple(r.center);
    const size = triple(r.size);
    if (typeof r.id !== "string" || !center || !size) continue;
    const opt = (key: string, lo: number, hi: number) => (finite(r[key]) ? { [key]: clamp(r[key] as number, lo, hi) } : {});
    out.push({
      id: r.id,
      name: typeof r.name === "string" ? r.name.slice(0, 64) : "Post volume",
      center,
      size: [Math.max(0.1, size[0]), Math.max(0.1, size[1]), Math.max(0.1, size[2])],
      blend: finite(r.blend) ? clamp(r.blend, 0, 100) : 2,
      ...(finite(r.priority) ? { priority: Math.round(clamp(r.priority, -100, 100)) } : {}),
      ...opt("exposure", -4, 4),
      ...opt("brightness", 0.5, 1.5),
      ...opt("contrast", 0.5, 1.5),
      ...opt("saturation", 0, 2),
      ...opt("bloom", 0, 1.5),
      ...opt("fog", 0, 1),
      ...opt("aperture", 1.2, 22),
      ...opt("focusDistance", 0.05, 10000),
      ...opt("motionBlur", 0, 2),
    });
  }
  return out;
}

/** Read a stored eye adaptation defensively, or null for none. */
export function readAutoExposure(value: unknown): AutoExposure | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const min = finite(r.min) ? clamp(r.min, -8, 0) : DEFAULT_AUTO_EXPOSURE.min;
  const max = finite(r.max) ? clamp(r.max, 0, 8) : DEFAULT_AUTO_EXPOSURE.max;
  return {
    min,
    max,
    up: finite(r.up) ? clamp(r.up, 0.05, 20) : DEFAULT_AUTO_EXPOSURE.up,
    down: finite(r.down) ? clamp(r.down, 0.05, 20) : DEFAULT_AUTO_EXPOSURE.down,
    key: finite(r.key) ? clamp(r.key, 0.05, 0.5) : DEFAULT_AUTO_EXPOSURE.key,
  };
}
