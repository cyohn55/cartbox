/**
 * Data-driven post-processing effect model, shared by the editor's FX tab and
 * the runtime player. Each effect declares its parameters (with ranges and
 * defaults); UIs render them generically and `uniformsFromSettings` folds the
 * whole stack into the flat uniform block the shader consumes — a disabled
 * effect collapses to its neutral value, so the shader needs no per-effect
 * branching and never recompiles.
 *
 * DOM-free so server code (the save API validates with `parsePostFxSettings`)
 * and tests consume it without a browser.
 *
 * The stack divides into two halves. The first seven effects are the console's
 * own signal path — the grade, the tube, the lens. The rest are screen-space
 * looks ported from the Shade Studio shader library, chosen for being
 * single-pass (the no-recompile design has no room for a second target) and for
 * suiting pixel art rather than fighting it: ordered dithering and halftone are
 * how a small palette fakes a gradient, and light shafts and streaks are how a
 * flat 2D scene suggests a light source it cannot actually cast.
 */

export type PostFxEffectId =
  | "grade"
  | "fog"
  | "bloom"
  | "crt"
  | "chroma"
  | "vignette"
  | "posterize"
  | "dither"
  | "halftone"
  | "godrays"
  | "streaks"
  | "splittone"
  | "kaleidoscope"
  | "grain";

export interface PostFxParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

/** A colour an effect exposes, e.g. the fog tint or a split-tone end. */
export interface PostFxColorDef {
  id: string;
  label: string;
  /** #rrggbb. */
  defaultValue: string;
}

export interface PostFxEffectDef {
  id: PostFxEffectId;
  label: string;
  description: string;
  params: PostFxParamDef[];
  /** Colour pickers this effect exposes, if any. */
  colors?: PostFxColorDef[];
}

export const POST_FX_EFFECTS: PostFxEffectDef[] = [
  {
    id: "grade",
    label: "Color grade",
    description: "Brightness, contrast, and saturation over the whole frame.",
    params: [
      { id: "brightness", label: "Brightness", min: 0.5, max: 1.5, step: 0.01, defaultValue: 1 },
      { id: "contrast", label: "Contrast", min: 0.5, max: 1.5, step: 0.01, defaultValue: 1 },
      { id: "saturation", label: "Saturation", min: 0, max: 2, step: 0.01, defaultValue: 1 },
    ],
  },
  {
    id: "fog",
    label: "Fog",
    description: "Screen-space fog that thickens toward the chosen horizon.",
    colors: [{ id: "tint", label: "Fog colour", defaultValue: "#9db4c8" }],
    params: [
      { id: "density", label: "Density", min: 0, max: 1, step: 0.01, defaultValue: 0.35 },
      { id: "horizon", label: "Horizon", min: 0, max: 1, step: 0.01, defaultValue: 0.4 },
    ],
  },
  {
    id: "bloom",
    label: "Bloom",
    description: "Bright pixels glow past their edges.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1.5, step: 0.01, defaultValue: 0.6 },
      // Max stays below 1: the shader's smoothstep(threshold, 1.0, …) needs edge0 < edge1.
      { id: "threshold", label: "Threshold", min: 0, max: 0.95, step: 0.01, defaultValue: 0.6 },
    ],
  },
  {
    id: "crt",
    label: "CRT",
    description: "Barrel curvature and scanlines, like a tube television.",
    params: [
      { id: "curvature", label: "Curvature", min: 0, max: 0.25, step: 0.005, defaultValue: 0.08 },
      { id: "scanlines", label: "Scanlines", min: 0, max: 1, step: 0.01, defaultValue: 0.35 },
    ],
  },
  {
    id: "chroma",
    label: "Chromatic aberration",
    description: "Red/blue fringing that grows toward the frame edge.",
    params: [{ id: "amount", label: "Amount", min: 0, max: 3, step: 0.05, defaultValue: 1 }],
  },
  {
    id: "vignette",
    label: "Vignette",
    description: "Darkens the corners of the frame.",
    params: [{ id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.35 }],
  },
  {
    id: "posterize",
    label: "Posterize",
    description: "Quantises colours to a fixed number of levels.",
    params: [{ id: "levels", label: "Levels", min: 2, max: 16, step: 1, defaultValue: 4 }],
  },
  {
    id: "dither",
    label: "Ordered dither",
    description: "Bayer pattern that turns posterised bands into pixel-art stipple.",
    params: [
      { id: "amount", label: "Amount", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      { id: "scale", label: "Cell size", min: 1, max: 4, step: 1, defaultValue: 1 },
    ],
  },
  {
    id: "halftone",
    label: "Halftone",
    description: "Print-style dot screen sized by brightness.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.6 },
      { id: "scale", label: "Dot size", min: 2, max: 16, step: 1, defaultValue: 5 },
      { id: "angle", label: "Screen angle", min: 0, max: 90, step: 1, defaultValue: 45 },
    ],
  },
  {
    id: "godrays",
    label: "God rays",
    description: "Light shafts streaming out of a bright point in the frame.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 2, step: 0.05, defaultValue: 0.8 },
      { id: "density", label: "Length", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      { id: "decay", label: "Falloff", min: 0.8, max: 0.99, step: 0.005, defaultValue: 0.95 },
      { id: "x", label: "Source X", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      { id: "y", label: "Source Y", min: 0, max: 1, step: 0.01, defaultValue: 0.2 },
    ],
  },
  {
    id: "streaks",
    label: "Light streaks",
    description: "Anamorphic horizontal flares off the brightest pixels.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 2, step: 0.05, defaultValue: 0.6 },
      { id: "length", label: "Length", min: 0, max: 1, step: 0.01, defaultValue: 0.4 },
    ],
  },
  {
    id: "splittone",
    label: "Split tone",
    description: "Tints shadows and highlights toward different colours.",
    colors: [
      { id: "shadows", label: "Shadows", defaultValue: "#3d4f7a" },
      { id: "highlights", label: "Highlights", defaultValue: "#ffd9a0" },
    ],
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      { id: "balance", label: "Balance", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
    ],
  },
  {
    id: "kaleidoscope",
    label: "Kaleidoscope",
    description: "Mirrors a wedge of the frame around the centre.",
    params: [
      // Below 2 there is nothing to mirror, so the shader treats it as off.
      { id: "segments", label: "Segments", min: 2, max: 12, step: 1, defaultValue: 6 },
      { id: "angle", label: "Rotation", min: 0, max: 360, step: 1, defaultValue: 0 },
    ],
  },
  {
    id: "grain",
    label: "Film grain",
    description: "Animated noise over the frame.",
    params: [
      { id: "amount", label: "Amount", min: 0, max: 0.5, step: 0.01, defaultValue: 0.08 },
      { id: "size", label: "Grain size", min: 1, max: 4, step: 1, defaultValue: 1 },
    ],
  },
];

/** Key for one parameter's (or colour's) value in the settings map. */
export function paramKey(effect: PostFxEffectId, param: string): string {
  return `${effect}.${param}`;
}

export interface PostFxSettings {
  enabled: Record<PostFxEffectId, boolean>;
  values: Record<string, number>;
  /** Effect colours as #rrggbb, keyed by {@link paramKey}. */
  colors: Record<string, string>;
}

/** Where the fog tint lived before effects could declare colours generically. */
const LEGACY_FOG_COLOR_KEY = "fogColor";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function defaultPostFxSettings(): PostFxSettings {
  const enabled = {} as Record<PostFxEffectId, boolean>;
  const values: Record<string, number> = {};
  const colors: Record<string, string> = {};
  for (const effect of POST_FX_EFFECTS) {
    enabled[effect.id] = false;
    for (const param of effect.params) {
      values[paramKey(effect.id, param.id)] = param.defaultValue;
    }
    for (const color of effect.colors ?? []) {
      colors[paramKey(effect.id, color.id)] = color.defaultValue;
    }
  }
  return { enabled, values, colors };
}

/** Whether any effect in the stack is switched on. */
export function anyPostFxEnabled(settings: PostFxSettings): boolean {
  return POST_FX_EFFECTS.some((effect) => settings.enabled[effect.id]);
}

/**
 * Validate untrusted JSON (a PUT body or a jsonb column) into PostFxSettings,
 * or null when malformed. Lenient about omissions — unknown effects/params are
 * dropped and missing ones take their defaults, so the wire format survives
 * adding effects later — but strict about types and ranges, clamping values
 * into each parameter's declared bounds.
 *
 * A top-level `fogColor` string is still honoured: rows written before effects
 * could declare their own colours carry the fog tint there, and silently losing
 * an artist's fog colour on the next save would be a worse outcome than one
 * branch here.
 */
export function parsePostFxSettings(value: unknown): PostFxSettings | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const rawEnabled = record.enabled;
  const rawValues = record.values;
  if (typeof rawEnabled !== "object" || rawEnabled === null) return null;
  if (typeof rawValues !== "object" || rawValues === null) return null;
  const rawColors = typeof record.colors === "object" && record.colors !== null ? record.colors : {};

  const settings = defaultPostFxSettings();
  for (const effect of POST_FX_EFFECTS) {
    const enabled = (rawEnabled as Record<string, unknown>)[effect.id];
    if (typeof enabled === "boolean") settings.enabled[effect.id] = enabled;
    for (const param of effect.params) {
      const key = paramKey(effect.id, param.id);
      const raw = (rawValues as Record<string, unknown>)[key];
      if (typeof raw === "number" && Number.isFinite(raw)) {
        settings.values[key] = Math.min(param.max, Math.max(param.min, raw));
      }
    }
    for (const color of effect.colors ?? []) {
      const key = paramKey(effect.id, color.id);
      const raw = (rawColors as Record<string, unknown>)[key];
      if (typeof raw === "string" && HEX_COLOR.test(raw)) settings.colors[key] = raw;
    }
  }

  const legacyFog = record[LEGACY_FOG_COLOR_KEY];
  if (typeof legacyFog === "string" && HEX_COLOR.test(legacyFog) && !(paramKey("fog", "tint") in (rawColors as object))) {
    settings.colors[paramKey("fog", "tint")] = legacyFog;
  }
  return settings;
}

/** The flat uniform block the post-process shader consumes. */
export interface PostFxUniforms {
  brightness: number;
  contrast: number;
  saturation: number;
  fogDensity: number;
  fogHorizon: number;
  fogColor: [number, number, number];
  bloomStrength: number;
  bloomThreshold: number;
  curvature: number;
  scanlines: number;
  aberration: number;
  vignette: number;
  /** 0 disables posterisation; otherwise the level count. */
  posterize: number;
  ditherAmount: number;
  ditherScale: number;
  halftoneStrength: number;
  halftoneScale: number;
  /** Screen angle in radians. */
  halftoneAngle: number;
  godrayStrength: number;
  godrayDensity: number;
  godrayDecay: number;
  godrayOrigin: [number, number];
  streakStrength: number;
  streakLength: number;
  splitStrength: number;
  splitBalance: number;
  splitShadows: [number, number, number];
  splitHighlights: [number, number, number];
  /** Below 2 the shader leaves the frame alone. */
  kaleidoSegments: number;
  /** Rotation in radians. */
  kaleidoAngle: number;
  grainAmount: number;
  grainSize: number;
}

/** Parse #rrggbb into a 0..1 RGB triplet. */
export function hexToRgb01(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/** The declared default for a colour, so a missing entry never yields NaN. */
function colorDefault(effect: PostFxEffectId, colorId: string): string {
  const def = POST_FX_EFFECTS.find((entry) => entry.id === effect)?.colors?.find((color) => color.id === colorId);
  return def?.defaultValue ?? "#000000";
}

/**
 * Fold the settings into shader uniforms. Disabled effects map to their
 * neutral values (identity grade, zero density/strength), so toggling an
 * effect never needs a shader recompile.
 */
export function uniformsFromSettings(settings: PostFxSettings): PostFxUniforms {
  const value = (effect: PostFxEffectId, param: string, neutral: number) =>
    settings.enabled[effect] ? settings.values[paramKey(effect, param)] ?? neutral : neutral;

  // Shape parameters (a position, an angle, a threshold) are read whether or not
  // the effect is on: they choose *where* an effect happens, not how much, so
  // clamping them to a neutral would be meaningless. Only the strength gates.
  const shape = (effect: PostFxEffectId, param: string, fallback: number) =>
    settings.values[paramKey(effect, param)] ?? fallback;

  const color = (effect: PostFxEffectId, colorId: string): [number, number, number] =>
    hexToRgb01(settings.colors[paramKey(effect, colorId)] ?? colorDefault(effect, colorId));

  return {
    brightness: value("grade", "brightness", 1),
    contrast: value("grade", "contrast", 1),
    saturation: value("grade", "saturation", 1),
    fogDensity: value("fog", "density", 0),
    fogHorizon: shape("fog", "horizon", 0.4),
    fogColor: color("fog", "tint"),
    bloomStrength: value("bloom", "strength", 0),
    bloomThreshold: shape("bloom", "threshold", 0.6),
    curvature: value("crt", "curvature", 0),
    scanlines: value("crt", "scanlines", 0),
    aberration: value("chroma", "amount", 0),
    vignette: value("vignette", "strength", 0),
    posterize: settings.enabled.posterize ? shape("posterize", "levels", 4) : 0,
    ditherAmount: value("dither", "amount", 0),
    ditherScale: shape("dither", "scale", 1),
    halftoneStrength: value("halftone", "strength", 0),
    halftoneScale: shape("halftone", "scale", 5),
    halftoneAngle: (shape("halftone", "angle", 45) * Math.PI) / 180,
    godrayStrength: value("godrays", "strength", 0),
    godrayDensity: shape("godrays", "density", 0.5),
    godrayDecay: shape("godrays", "decay", 0.95),
    godrayOrigin: [shape("godrays", "x", 0.5), shape("godrays", "y", 0.2)],
    streakStrength: value("streaks", "strength", 0),
    streakLength: shape("streaks", "length", 0.4),
    splitStrength: value("splittone", "strength", 0),
    splitBalance: shape("splittone", "balance", 0.5),
    splitShadows: color("splittone", "shadows"),
    splitHighlights: color("splittone", "highlights"),
    kaleidoSegments: settings.enabled.kaleidoscope ? shape("kaleidoscope", "segments", 6) : 0,
    kaleidoAngle: (shape("kaleidoscope", "angle", 0) * Math.PI) / 180,
    grainAmount: value("grain", "amount", 0),
    grainSize: shape("grain", "size", 1),
  };
}
