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
 */

export type PostFxEffectId = "grade" | "fog" | "bloom" | "crt" | "chroma" | "vignette" | "posterize";

export interface PostFxParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

export interface PostFxEffectDef {
  id: PostFxEffectId;
  label: string;
  description: string;
  params: PostFxParamDef[];
  /** Effect exposes a colour picker (fog tint). */
  hasColor?: boolean;
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
    hasColor: true,
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
];

/** Key for one parameter's value in the settings map. */
export function paramKey(effect: PostFxEffectId, param: string): string {
  return `${effect}.${param}`;
}

export interface PostFxSettings {
  enabled: Record<PostFxEffectId, boolean>;
  values: Record<string, number>;
  /** Fog tint as #rrggbb. */
  fogColor: string;
}

const DEFAULT_FOG_COLOR = "#9db4c8";

export function defaultPostFxSettings(): PostFxSettings {
  const enabled = {} as Record<PostFxEffectId, boolean>;
  const values: Record<string, number> = {};
  for (const effect of POST_FX_EFFECTS) {
    enabled[effect.id] = false;
    for (const param of effect.params) {
      values[paramKey(effect.id, param.id)] = param.defaultValue;
    }
  }
  return { enabled, values, fogColor: DEFAULT_FOG_COLOR };
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
 */
export function parsePostFxSettings(value: unknown): PostFxSettings | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const rawEnabled = record.enabled;
  const rawValues = record.values;
  if (typeof rawEnabled !== "object" || rawEnabled === null) return null;
  if (typeof rawValues !== "object" || rawValues === null) return null;

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
  }
  if (typeof record.fogColor === "string" && /^#[0-9a-fA-F]{6}$/.test(record.fogColor)) {
    settings.fogColor = record.fogColor;
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
}

/** Parse #rrggbb into a 0..1 RGB triplet. */
export function hexToRgb01(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/**
 * Fold the settings into shader uniforms. Disabled effects map to their
 * neutral values (identity grade, zero density/strength), so toggling an
 * effect never needs a shader recompile.
 */
export function uniformsFromSettings(settings: PostFxSettings): PostFxUniforms {
  const value = (effect: PostFxEffectId, param: string, neutral: number) =>
    settings.enabled[effect] ? settings.values[paramKey(effect, param)] ?? neutral : neutral;

  return {
    brightness: value("grade", "brightness", 1),
    contrast: value("grade", "contrast", 1),
    saturation: value("grade", "saturation", 1),
    fogDensity: value("fog", "density", 0),
    fogHorizon: settings.values[paramKey("fog", "horizon")] ?? 0.4,
    fogColor: hexToRgb01(settings.fogColor),
    bloomStrength: value("bloom", "strength", 0),
    bloomThreshold: settings.values[paramKey("bloom", "threshold")] ?? 0.6,
    curvature: value("crt", "curvature", 0),
    scanlines: value("crt", "scanlines", 0),
    aberration: value("chroma", "amount", 0),
    vignette: value("vignette", "strength", 0),
    posterize: settings.enabled.posterize ? settings.values[paramKey("posterize", "levels")] ?? 4 : 0,
  };
}
