/**
 * Authored lighting for a 3D mesh scene — the "Modern (AAA) tier" lighting rig a
 * creator sets up in the editor and the runtime replays over the mesh overlay.
 *
 * The render pipeline (`renderMeshScene`) already consumes an {@link EnvironmentLight}
 * (image-based lighting / skybox gradient), an unbounded {@link SceneLight} list,
 * an ambient floor, a {@link ToneMap}, and a directional {@link ShadowInput}. What
 * was missing was a *place to author them*: the runtime overlay drew with none of
 * it. This model is that authored rig — a small, JSON-friendly record (plain
 * numbers and arrays, no typed arrays) — plus the pure mappings that turn it into
 * the render pipeline's inputs.
 *
 * Additive by construction: a scene with no lighting rig (every cart today) is
 * `null`, and the runtime then passes exactly what it always has — the fantasy
 * tiers render byte-identically. Only a scene that opts in gets environment,
 * multiple lights, tone mapping, and shadows (see AAA_TIER_ROADMAP.md).
 */

import { decodeLightProbes, type LightProbeGrid, type StoredLightProbes } from "./lightProbes";
import {
  orthographicMatrix,
  renderShadowMap,
  viewMatrix,
  type EnvironmentLight,
  type MeshSceneInstance,
  type SceneLight,
  type ShadowInput,
  type ToneMap,
} from "../render/meshRasterizer";
import { MAX_FOG_VOLUMES, type FogVolume, type ProceduralSky, type SceneFog, type SkyMountainRange, type SkyPanorama } from "../render/skyDome";
import { MAX_CLOUD_LAYERS, MAX_SKY_OBJECTS, type SkyCloudLayer, type SkyObject } from "../render/skyLayers";
import type { SunShafts } from "../render/sunShafts";
import { parseReflectionProbes, type ReflectionProbe } from "./reflectionProbes";

/** Serialized-format version, bumped on any schema change. */
export const SCENE_LIGHTING_VERSION = 1;

/** The skybox as an analytic sky/horizon/ground gradient. Colours are 0..1. */
export interface SceneEnvironment {
  readonly sky: readonly [number, number, number];
  readonly horizon: readonly [number, number, number];
  readonly ground: readonly [number, number, number];
  /** Overall multiplier on the environment (≥ 0). */
  readonly intensity: number;
}

/** A complete authored lighting rig for a mesh scene. */
export interface SceneLighting {
  readonly environment: SceneEnvironment;
  /** Fill floor for the direct term, 0..1 — the light a surface gets in shadow. */
  readonly ambient: number;
  /** HDR exposure multiplier applied before the tone-map curve (> 0). */
  readonly exposure: number;
  /** Apply the ACES filmic roll-off so bright highlights don't clip flat. */
  readonly tonemap: boolean;
  /** Cast a directional shadow from the first directional (key) light. */
  readonly shadows: boolean;
  readonly lights: readonly SceneLight[];
  /**
   * An optional procedural sky dome. When set, the runtime bakes it into a
   * panorama that is both drawn behind a first-person scene and used as the
   * image-based light (so metals reflect it). Null keeps the flat gradient.
   */
  readonly sky?: ProceduralSky | null;
  /** Optional distance fog over PBR geometry. Null = no fog. */
  readonly fog?: SceneFog | null;
  /**
   * Reflection probes (see reflectionProbes.ts): shiny surfaces inside a
   * probe's box reflect the scene around it rather than the sky.
   */
  readonly probes?: readonly ReflectionProbe[];
  /**
   * Sun shafts (HALO2_STYLE_ROADMAP.md, H7): light streaking from the sun
   * through gaps in the scene. Needs the sky dome — the sun and the sky
   * behind the geometry are what shine through. Absent = none.
   */
  readonly shafts?: SunShafts | null;
  /**
   * Baked light probes (ENGINE_PARITY_ROADMAP.md EP9; see lightProbes.ts):
   * things without a light map take their ambient from this grid. Absent = none.
   */
  readonly lightProbes?: StoredLightProbes | null;
  /**
   * The armour colours for this scene (HALO_INFINITE_STYLE_ROADMAP.md I8): entry
   * k replaces tint k of the runtime's palette (1..15; entry 0 is unused), null
   * keeping the built-in colour — so a scene lit brighter can carry team
   * colours saturated to hold up in it. Absent = the built-in palette.
   */
  readonly tints?: readonly (readonly [number, number, number] | null)[];
}

/** Entries a rig's tint list may hold: the palette's 15 colours after the unused 0. */
export const MAX_SCENE_TINTS = 16;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const nonNeg = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

/** A neutral daylight rig — a sensible starting point when a creator turns lighting on. */
export function defaultSceneLighting(): SceneLighting {
  return {
    environment: {
      sky: [0.35, 0.5, 0.75],
      horizon: [0.7, 0.75, 0.8],
      ground: [0.25, 0.22, 0.2],
      intensity: 1,
    },
    ambient: 0.35,
    exposure: 1,
    tonemap: false,
    shadows: false,
    lights: [{ kind: "directional", direction: [0.4, 0.8, 0.6], color: [1, 1, 1], intensity: 1 }],
  };
}

function isFiniteTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

function clampTriple(value: readonly [number, number, number]): [number, number, number] {
  return [clamp01(value[0]), clamp01(value[1]), clamp01(value[2])];
}

/** Read one authored light defensively, dropping anything malformed to a default. */
function parseLight(value: unknown): SceneLight | null {
  const raw = (value ?? {}) as Record<string, unknown>;
  const kind = raw.kind === "point" ? "point" : raw.kind === "spot" ? "spot" : raw.kind === "directional" ? "directional" : null;
  if (!kind) return null;
  const color = isFiniteTriple(raw.color) ? clampTriple(raw.color) : ([1, 1, 1] as [number, number, number]);
  const intensity = typeof raw.intensity === "number" && Number.isFinite(raw.intensity) ? Math.max(0, raw.intensity) : 1;
  if (kind === "directional") {
    const direction = isFiniteTriple(raw.direction) ? raw.direction : ([0.4, 0.8, 0.6] as [number, number, number]);
    return { kind, direction, color, intensity };
  }
  const position = isFiniteTriple(raw.position) ? raw.position : ([0, 1, 0] as [number, number, number]);
  const range = typeof raw.range === "number" && Number.isFinite(raw.range) ? Math.max(0, raw.range) : 0;
  if (kind === "spot") {
    const direction = isFiniteTriple(raw.direction) ? raw.direction : ([0, -1, 0] as [number, number, number]);
    const angle = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(89, Math.max(0, v)) : fallback);
    const outerAngle = Math.max(1, angle(raw.outerAngle, 30));
    const innerAngle = Math.min(outerAngle, angle(raw.innerAngle, outerAngle * 0.75));
    return { kind, position, direction, color, intensity, range, innerAngle, outerAngle, ...(raw.castShadows === true ? { castShadows: true } : {}) };
  }
  return { kind, position, color, intensity, range, ...(raw.castShadows === true ? { castShadows: true } : {}) };
}

/**
 * Parse a stored lighting rig into a complete {@link SceneLighting}, filling every
 * missing or malformed field from the default rig — a corrupt block never blanks
 * the scene. Returns null only when there is nothing to parse (absent or not an
 * object), which the caller reads as "this scene has no authored lighting".
 */
export function parseSceneLighting(raw: unknown): SceneLighting | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const base = defaultSceneLighting();
  const env = (record.environment ?? {}) as Record<string, unknown>;

  // Only present when authored, so a rig without a dome/fog round-trips unchanged.
  const sky = parseSky(record.sky);
  const fog = parseFog(record.fog);
  const probes = parseReflectionProbes(record.probes);
  const shafts = parseShafts(record.shafts);
  // Kept only when it decodes: a bad grid is dropped, never half-used.
  const lightProbes = decodeLightProbes(record.lightProbes) ? (record.lightProbes as StoredLightProbes) : null;

  const lights = Array.isArray(record.lights)
    ? record.lights.map(parseLight).filter((l): l is SceneLight => l !== null)
    : base.lights;
  const tints = parseTints(record.tints);

  return {
    environment: {
      sky: isFiniteTriple(env.sky) ? clampTriple(env.sky) : base.environment.sky,
      horizon: isFiniteTriple(env.horizon) ? clampTriple(env.horizon) : base.environment.horizon,
      ground: isFiniteTriple(env.ground) ? clampTriple(env.ground) : base.environment.ground,
      intensity: typeof env.intensity === "number" ? nonNeg(env.intensity) : base.environment.intensity,
    },
    ambient: typeof record.ambient === "number" ? clamp01(record.ambient) : base.ambient,
    exposure: typeof record.exposure === "number" && record.exposure > 0 ? record.exposure : base.exposure,
    tonemap: typeof record.tonemap === "boolean" ? record.tonemap : base.tonemap,
    shadows: typeof record.shadows === "boolean" ? record.shadows : base.shadows,
    lights,
    ...(sky ? { sky } : {}),
    ...(fog ? { fog } : {}),
    ...(probes.length > 0 ? { probes } : {}),
    ...(shafts ? { shafts } : {}),
    ...(lightProbes ? { lightProbes } : {}),
    ...(tints ? { tints } : {}),
  };
}

/** A rig's tint overrides: colours (clamped) or nulls, at most {@link MAX_SCENE_TINTS}; null when none are set. */
function parseTints(value: unknown): (readonly [number, number, number] | null)[] | null {
  if (!Array.isArray(value)) return null;
  const tints = value.slice(0, MAX_SCENE_TINTS).map((t) => (isFiniteTriple(t) ? clampTriple(t) : null));
  return tints.some((t) => t !== null) ? tints : null;
}

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const tripleOr = (value: unknown, fallback: readonly [number, number, number]): [number, number, number] =>
  isFiniteTriple(value) ? clampTriple(value) : [fallback[0], fallback[1], fallback[2]];

/** A clear alpine sky — the starting point when a creator turns the sky dome on. */
export function defaultProceduralSky(): ProceduralSky {
  return {
    zenith: [0.3, 0.42, 0.6],
    horizon: [0.8, 0.85, 0.9],
    below: [0.7, 0.76, 0.83],
    sunDirection: [0.4, 0.8, 0.6],
    sunColor: [1, 0.95, 0.85],
    clouds: 0.5,
    cloudColor: [0.93, 0.95, 0.98],
    mountains: [
      { height: 9, peaks: 9, rock: [0.42, 0.47, 0.55], snow: [0.9, 0.93, 0.97], snowLine: 0.3, haze: 0.5, seed: 11 },
      { height: 16, peaks: 6, rock: [0.25, 0.28, 0.33], snow: [0.93, 0.95, 0.98], snowLine: 0.45, haze: 0.15, seed: 29 },
    ],
    seed: 7,
  };
}

/**
 * Saturated armour colours for a bright rig (HALO_INFINITE_STYLE_ROADMAP.md
 * I8), index-aligned with the runtime's tint palette: under a strong sun and
 * a bright sky fill the built-in, muted colours wash toward grey, so these
 * push each hue harder and keep the darks dark.
 */
export const INFINITE_TINTS: readonly (readonly [number, number, number] | null)[] = [
  null,
  [0.78, 0.09, 0.07], // 1 red
  [0.08, 0.3, 0.86], // 2 blue
  [0.18, 0.6, 0.14], // 3 green
  [0.96, 0.44, 0.04], // 4 orange
  [0.5, 0.16, 0.8], // 5 purple
  [0.93, 0.7, 0.1], // 6 gold
  [0.45, 0.26, 0.12], // 7 brown
  [0.96, 0.38, 0.62], // 8 pink
  [0.9, 0.92, 0.94], // 9 white
  [0.1, 0.1, 0.11], // 10 black
  [0.42, 0.5, 0.6], // 11 steel
  [0.04, 0.62, 0.66], // 12 teal
  [0.42, 0.46, 0.12], // 13 olive
  [0.56, 0.02, 0.08], // 14 crimson
  [0.46, 0.64, 0.4], // 15 sage
];

/** Toward a high noon sun (about 55° up), the "Infinite daylight" rig's key light. */
const NOON_SUN: readonly [number, number, number] = [0.42, 0.82, -0.4];

/**
 * An Infinite look for the rig (I8): a warm, strong noon sun that models
 * every form, a bright blue sky fill so the shade stays open and cool rather
 * than black, a clear noon dome that is also the image-based light, filmic
 * tone mapping, shadows, and saturated team colours. Pair it with the
 * Infinite grading LUT in the FX stack.
 */
export function infiniteDaylightLighting(): SceneLighting {
  return {
    environment: { sky: [0.36, 0.56, 0.9], horizon: [0.76, 0.85, 0.96], ground: [0.38, 0.36, 0.32], intensity: 0.85 },
    ambient: 0.4,
    exposure: 1.05,
    tonemap: true,
    shadows: true,
    lights: [
      { kind: "directional", direction: [...NOON_SUN], color: [1, 0.9, 0.74], intensity: 3 },
      // Skylight from the far side: blue, soft, never black.
      { kind: "directional", direction: [-NOON_SUN[0], 0.45, -NOON_SUN[2]], color: [0.55, 0.68, 0.95], intensity: 0.55 },
    ],
    sky: { ...defaultProceduralSky(), zenith: [0.17, 0.38, 0.78], horizon: [0.74, 0.85, 0.97], below: [0.68, 0.77, 0.88], sunDirection: [...NOON_SUN], sunColor: [1, 0.93, 0.8], clouds: 0.35 },
    fog: { color: [0.74, 0.84, 0.96], density: 0.012, start: 12, max: 0.35 },
    tints: INFINITE_TINTS,
  };
}

/** Light distance haze tinted to the default sky's horizon. */
export function defaultSceneFog(): SceneFog {
  return { color: [0.8, 0.85, 0.9], density: 0.03, start: 6, max: 0.6 };
}

/** At most this many mountain rings — each costs a pass over the panorama. */
const MAX_SKY_MOUNTAINS = 4;

function parseMountain(value: unknown): SkyMountainRange | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    height: Math.max(0, Math.min(60, finiteOr(raw.height, 10))),
    peaks: Math.max(1, Math.min(64, finiteOr(raw.peaks, 8))),
    rock: tripleOr(raw.rock, [0.35, 0.38, 0.44]),
    snow: tripleOr(raw.snow, [0.92, 0.94, 0.97]),
    snowLine: clamp01(finiteOr(raw.snowLine, 0.4)),
    haze: clamp01(finiteOr(raw.haze, 0.3)),
    seed: Math.floor(finiteOr(raw.seed, 1)),
  };
}

/** Read a stored sky dome defensively; anything absent or malformed is null (no dome). */
export function parseSky(value: unknown): ProceduralSky | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const base = defaultProceduralSky();
  const mountains = Array.isArray(raw.mountains)
    ? raw.mountains.map(parseMountain).filter((m): m is SkyMountainRange => m !== null).slice(0, MAX_SKY_MOUNTAINS)
    : base.mountains;
  const objects = Array.isArray(raw.objects) ? raw.objects.map(parseSkyObject).filter((o): o is SkyObject => o !== null).slice(0, MAX_SKY_OBJECTS) : [];
  const cloudLayers = Array.isArray(raw.cloudLayers) ? raw.cloudLayers.map(parseCloudLayer).filter((l): l is SkyCloudLayer => l !== null).slice(0, MAX_CLOUD_LAYERS) : [];
  const panorama = parsePanorama(raw.panorama);
  return {
    ...(panorama ? { panorama } : {}),
    ...(objects.length > 0 ? { objects } : {}),
    ...(cloudLayers.length > 0 ? { cloudLayers } : {}),
    zenith: tripleOr(raw.zenith, base.zenith),
    horizon: tripleOr(raw.horizon, base.horizon),
    below: tripleOr(raw.below, base.below),
    sunDirection: isFiniteTriple(raw.sunDirection) ? raw.sunDirection : base.sunDirection,
    sunColor: tripleOr(raw.sunColor, base.sunColor),
    clouds: clamp01(finiteOr(raw.clouds, base.clouds)),
    cloudColor: tripleOr(raw.cloudColor, base.cloudColor),
    mountains,
    seed: Math.floor(finiteOr(raw.seed, base.seed)),
  };
}

/** The largest imported panorama kept (base64 characters) — about 6 MB of file. */
export const MAX_SKY_PANORAMA_CHARS = 8_000_000;
const PANORAMA_MIMES = ["image/png", "image/jpeg", "image/vnd.radiance"];

function parsePanorama(value: unknown): SkyPanorama | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.mime !== "string" || !PANORAMA_MIMES.includes(raw.mime)) return null;
  if (typeof raw.data !== "string" || raw.data.length === 0 || raw.data.length > MAX_SKY_PANORAMA_CHARS || !/^[A-Za-z0-9+/]+=*$/.test(raw.data)) return null;
  return { mime: raw.mime, data: raw.data, exposure: Math.max(0.01, Math.min(64, finiteOr(raw.exposure, 1))), yaw: ((finiteOr(raw.yaw, 0) % 360) + 360) % 360 };
}

function parseSkyObject(value: unknown): SkyObject | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const seed = Math.floor(finiteOr(raw.seed, 1));
  if (raw.kind === "ring") {
    return {
      kind: "ring",
      axis: isFiniteTriple(raw.axis) && Math.hypot(...raw.axis) > 1e-6 ? raw.axis : [0.3, 0.2, 1],
      width: Math.max(0.2, Math.min(30, finiteOr(raw.width, 3))),
      color: tripleOr(raw.color, [0.55, 0.62, 0.5]),
      edge: tripleOr(raw.edge, [0.85, 0.87, 0.9]),
      haze: clamp01(finiteOr(raw.haze, 0.5)),
      seed,
    };
  }
  if (raw.kind === "planet") {
    return {
      kind: "planet",
      direction: isFiniteTriple(raw.direction) && Math.hypot(...raw.direction) > 1e-6 ? raw.direction : [-0.5, 0.4, -0.6],
      radius: Math.max(0.2, Math.min(45, finiteOr(raw.radius, 6))),
      color: tripleOr(raw.color, [0.75, 0.62, 0.48]),
      atmosphere: tripleOr(raw.atmosphere, [0.55, 0.7, 1]),
      seed,
    };
  }
  return null;
}

function parseCloudLayer(value: unknown): SkyCloudLayer | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const wind = Array.isArray(raw.wind) && raw.wind.length === 2 && raw.wind.every((n) => typeof n === "number" && Number.isFinite(n)) ? (raw.wind as number[]) : [0.02, 0.01];
  return {
    cover: clamp01(finiteOr(raw.cover, 0.4)),
    scale: Math.max(0.01, Math.min(10, finiteOr(raw.scale, 0.35))),
    wind: [Math.max(-2, Math.min(2, wind[0]!)), Math.max(-2, Math.min(2, wind[1]!))],
    color: tripleOr(raw.color, [0.95, 0.96, 0.98]),
    opacity: clamp01(finiteOr(raw.opacity, 0.85)),
    seed: Math.floor(finiteOr(raw.seed, 1)),
  };
}

function parseFogVolume(value: unknown): FogVolume | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isFiniteTriple(raw.min) || !isFiniteTriple(raw.max)) return null;
  const min: [number, number, number] = [Math.min(raw.min[0], raw.max[0]), Math.min(raw.min[1], raw.max[1]), Math.min(raw.min[2], raw.max[2])];
  const max: [number, number, number] = [Math.max(raw.min[0], raw.max[0]), Math.max(raw.min[1], raw.max[1]), Math.max(raw.min[2], raw.max[2])];
  return {
    min,
    max,
    density: Math.max(0, Math.min(4, finiteOr(raw.density, 0.3))),
    falloff: Math.max(0, Math.min(10, finiteOr(raw.falloff, 0.5))),
  };
}

/** Read stored fog defensively; absent or malformed is null (no fog). */
export function parseFog(value: unknown): SceneFog | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const base = defaultSceneFog();
  const h = raw.height && typeof raw.height === "object" ? (raw.height as Record<string, unknown>) : null;
  const g = raw.glow && typeof raw.glow === "object" ? (raw.glow as Record<string, unknown>) : null;
  const volumes = Array.isArray(raw.volumes)
    ? raw.volumes.map(parseFogVolume).filter((v): v is FogVolume => v !== null).slice(0, MAX_FOG_VOLUMES)
    : [];
  return {
    color: tripleOr(raw.color, base.color),
    density: Math.max(0, Math.min(1, finiteOr(raw.density, base.density))),
    start: Math.max(0, finiteOr(raw.start, base.start)),
    max: clamp01(finiteOr(raw.max, base.max)),
    // The H7 layers are only present when authored, so older fog round-trips unchanged.
    ...(h
      ? {
          height: {
            base: finiteOr(h.base, 0),
            density: Math.max(0, Math.min(4, finiteOr(h.density, 0.05))),
            falloff: Math.max(0, Math.min(10, finiteOr(h.falloff, 0.3))),
          },
        }
      : {}),
    ...(volumes.length > 0 ? { volumes } : {}),
    ...(g ? { glow: { color: tripleOr(g.color, [1, 0.9, 0.7]), strength: Math.max(0, Math.min(2, finiteOr(g.strength, 0.6))) } } : {}),
  };
}

/** Read stored sun shafts defensively; absent or malformed is null (none). */
export function parseShafts(value: unknown): SunShafts | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    strength: Math.max(0, Math.min(2, finiteOr(raw.strength, 0.6))),
    length: Math.max(0.05, Math.min(1, finiteOr(raw.length, 0.6))),
  };
}

/** Shafts that read in daylight without washing the frame out. */
export function defaultSunShafts(): SunShafts {
  return { strength: 0.6, length: 0.6 };
}

// --- Immutable edits (the lighting editor edits through these) --------------

/** Patch the top-level scalar/flag fields (ambient, exposure, tonemap, shadows). */
export function patchSceneLighting(
  lighting: SceneLighting,
  patch: Partial<Pick<SceneLighting, "ambient" | "exposure" | "tonemap" | "shadows">>,
): SceneLighting {
  return { ...lighting, ...patch };
}

/** Set or clear the procedural sky dome. */
export function setSceneSky(lighting: SceneLighting, sky: ProceduralSky | null): SceneLighting {
  return { ...lighting, sky };
}

/** Set or clear the distance fog. */
export function setSceneFog(lighting: SceneLighting, fog: SceneFog | null): SceneLighting {
  return { ...lighting, fog };
}

/** Set or clear the sun shafts. */
export function setSceneShafts(lighting: SceneLighting, shafts: SunShafts | null): SceneLighting {
  const { shafts: _old, ...rest } = lighting;
  return shafts ? { ...rest, shafts } : rest;
}

/** Replace the reflection probes (an empty list removes them). */
export function setSceneProbes(lighting: SceneLighting, probes: readonly ReflectionProbe[]): SceneLighting {
  const { probes: _old, ...rest } = lighting;
  return probes.length > 0 ? { ...rest, probes } : rest;
}

/** Patch the environment (skybox) gradient. */
export function updateSceneEnvironment(lighting: SceneLighting, patch: Partial<SceneEnvironment>): SceneLighting {
  return { ...lighting, environment: { ...lighting.environment, ...patch } };
}

/** Append a light. */
export function addSceneLight(lighting: SceneLighting, light: SceneLight): SceneLighting {
  return { ...lighting, lights: [...lighting.lights, light] };
}

/** Patch one light in place; an out-of-range index is a no-op. */
export function updateSceneLight(lighting: SceneLighting, index: number, patch: Partial<SceneLight>): SceneLighting {
  if (index < 0 || index >= lighting.lights.length) return lighting;
  return {
    ...lighting,
    lights: lighting.lights.map((light, i) => (i === index ? ({ ...light, ...patch } as SceneLight) : light)),
  };
}

/** Remove one light; an out-of-range index is a no-op. */
export function removeSceneLight(lighting: SceneLighting, index: number): SceneLighting {
  if (index < 0 || index >= lighting.lights.length) return lighting;
  return { ...lighting, lights: lighting.lights.filter((_, i) => i !== index) };
}

// --- Mapping into the render pipeline's inputs ------------------------------

/** The authored gradient as an {@link EnvironmentLight} the rasteriser samples. */
export function sceneLightingEnvironment(lighting: SceneLighting): EnvironmentLight {
  const grid = lighting.lightProbes ? decodedProbes(lighting.lightProbes) : null;
  return {
    sky: lighting.environment.sky,
    horizon: lighting.environment.horizon,
    ground: lighting.environment.ground,
    intensity: lighting.environment.intensity,
    ...(grid ? { lightProbes: grid } : {}),
  };
}

const decoded = new WeakMap<StoredLightProbes, LightProbeGrid | null>();
/** A stored probe grid, decoded once per stored object. */
function decodedProbes(stored: StoredLightProbes): LightProbeGrid | null {
  let grid = decoded.get(stored);
  if (grid === undefined) {
    grid = decodeLightProbes(stored);
    decoded.set(stored, grid);
  }
  return grid;
}

/** The tone-map for the scene, or null when the creator left it off. */
export function sceneLightingTonemap(lighting: SceneLighting): ToneMap | null {
  return lighting.tonemap ? { exposure: lighting.exposure } : null;
}

/**
 * The key light direction the fantasy (Blinn-Phong) path uses — the first
 * directional light, or the rasteriser's default when the rig has none. PBR
 * materials use the full {@link SceneLighting.lights} list instead.
 */
export function sceneLightingKeyDirection(lighting: SceneLighting): readonly [number, number, number] | undefined {
  const key = lighting.lights.find((l) => l.kind === "directional");
  return key?.direction;
}

/** Light-NDC bias added per unit of tan(angle to the sun) — about a texel of depth. */
const SHADOW_SLOPE_BIAS = 0.0012;

/**
 * Build a directional shadow map for the scene from the key light, fitting an
 * orthographic light view to the scene's bounding sphere. Returns null when
 * shadows are off, there is no directional light, or the scene is empty — the
 * caller then renders without shadows.
 */
export function buildSceneShadow(
  instances: readonly MeshSceneInstance[],
  lighting: SceneLighting,
  center: readonly [number, number, number],
  radius: number,
  options: { readonly size: number; readonly depth: Float32Array; readonly clear?: boolean; readonly reach?: number },
): ShadowInput | null {
  // An empty instance list still yields a (cleared) map, so a caller can layer
  // cached static depth + this frame's moving instances; only a rig without
  // shadows, or a degenerate scene, gets null.
  if (!lighting.shadows || radius <= 0) return null;
  const direction = sceneLightingKeyDirection(lighting);
  if (!direction) return null;

  const len = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  const dir: [number, number, number] = [direction[0] / len, direction[1] / len, direction[2] / len];
  // Place the light's eye back along its direction, far enough to see the whole
  // sphere, and look at the scene centre.
  // `reach` backs the light off further, so casters beyond the framed sphere
  // (a terrain's cliffs, towering over the play space) stay in front of it.
  const dist = radius * 2 + Math.max(0, options.reach ?? 0);
  const eye: [number, number, number] = [
    center[0] + dir[0] * dist,
    center[1] + dir[1] * dist,
    center[2] + dir[2] * dist,
  ];
  const lightView = viewMatrix(eye, center);
  const lightProjection = orthographicMatrix(-radius, radius, -radius, radius, 0.01, dist + radius * 2);
  const map = renderShadowMap(instances, { lightView, lightProjection, size: options.size, depth: options.depth, clear: options.clear });
  // Authored rigs get slope-scaled bias (no acne on faces the sun grazes — the
  // sloped Forerunner walls) and soft 2x2-filtered edges. Bias is in light-NDC
  // depth, so when `reach` deepens the light's range the bias shrinks with it:
  // the same world distance, and thin casters (the walkway) still shadow.
  const depthScale = (radius * 4) / (dist + radius * 2);
  return { ...map, bias: 0.003 * depthScale, slopeBias: SHADOW_SLOPE_BIAS * depthScale, pcf: true };
}
