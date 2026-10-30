/**
 * The pure half of the WebGPU scene renderer: memory layout and buffer packing.
 *
 * A GPU renderer is mostly untestable in CI — there is no adapter on a build
 * machine. What *is* testable is everything that decides where a byte goes, and
 * that is also where a GPU renderer's bugs actually live: a uniform written at
 * the wrong offset, a vertex stride that disagrees with the pipeline layout, a
 * readback row copied without removing WebGPU's 256-byte padding. Keeping all
 * of it here, pure and DOM-free, means the parts that break silently on a GPU
 * are the parts covered by tests.
 */

import { packCharacter } from "./characterShading.js";
import {
  DEFAULT_DETAIL_SCALE,
  DEFAULT_DETAIL_STRENGTH,
  EFFECT_RIM_POWER,
  MAX_FOG_VOLUMES,
  MAX_REFLECTION_PROBES,
  NO_LAYERS,
  effectActive,
  emissiveAnimation,
  materialHasExtensions,
  type ResolvedExtensions,
  resolveExtensions,
  materialHasLayers,
  macroUniform,
  materialHasWater,
  materialRefracts,
  spotCone,
  lightColor,
  lightChannelMask,
  areaAsPunctual,
  areaFrame,
  areaSize,
  fogIsVolumetric,
  type EnvironmentLight,
  type Mat4,
  type MeshMaterial,
  type ReflectionProbeSet,
  type ResolvedLayers,
  type ResolvedRefraction,
  type SceneFog,
  type SceneLight,
  type SurfaceEffect,
} from "@cartbox/editor";

import { AREA_KIND } from "./ltc.js";

/**
 * WGSL uniform layout, in bytes:
 *
 * ```
 *   0  mvp        mat4x4<f32>  64
 *  64  nrm        mat3x3<f32>  48   (three vec3 columns, each padded to 16)
 * 112  base       vec4<f32>    16
 * 128  light      vec4<f32>    16   xyz = direction, w = ambient
 * 144  view       vec4<f32>    16   xyz = direction towards the viewer (Modern PBR), w = alpha cutoff
 * 160  pbr        vec4<f32>    16   x = metallic, y = roughness, z = 1 when PBR, w = alpha mode (0 opaque, 1 cut out, 2 blended, 3 added)
 * 176  emissive   vec4<f32>    16   xyz = emissive factor
 * 192  texflags   vec4<f32>    16   x = base, y = mr, z = occlusion, w = emissive
 * 208  envSky     vec4<f32>    16   xyz = sky colour, w = 1 when an environment is set
 * 224  envHorizon vec4<f32>    16   xyz = horizon colour, w = intensity
 * 240  envGround  vec4<f32>    16   xyz = ground colour
 * 256  lightMvp   mat4x4<f32>  64   world→light-clip for this draw (shadow mapping)
 * 320  shadow     vec4<f32>    16   x = 1 when shadowed, y = map size, z = bias, w = strength
 * 336  envMeta    vec4<f32>    16   xyz = env-map mean radiance, w = 1 when an env map is bound
 * 352  tonemap    vec4<f32>    16   x = 1 when tone-mapping, y = exposure,
 *                                    z = soft-edge distance (EP6b; 0 = hard),
 *                                    w = 1 when the curve maps as authored (F11a-5)
 * 368  ssao       vec4<f32>    16   x = 1 when an SSAO buffer is bound, y = light count,
 *                                    z = 1 when a baked light map is bound,
 *                                    w = reflection-probe count
 * 384  model      mat4x4<f32>  64   this draw's world matrix (point-light world pos)
 * 448  fog        vec4<f32>    16   rgb = fog colour, w = density
 * 464  fogParams  vec4<f32>    16   x = 1 when fogged, y = start distance, z = max amount,
 *                                    w = 1 when the fog has height/volume/glow layers
 * 480  shadow2    vec4<f32>    16   x = slope-scaled shadow bias, y = 1 for 2x2 PCF,
 *                                    zw = projection[10], [14]: depth → view distance
 *                                    as zw.y / (ndcZ + zw.x) (soft edges, EP6b)
 * 496  surface0   vec4<f32>    16   x = detail scale, y = detail strength (0 = none),
 *                                    z = reflectivity, w = 1 when the MR alpha masks it
 * 512  surface1   vec4<f32>    16   xy = emissive UV offset (its scroll this frame)
 * 528  surface2   vec4<f32>    16   rgb = rim colour × strength, w = rim power
 * 544  surface3   vec4<f32>    16   rgb = blend-surface colour, w = its roughness (< 0 = keep)
 *                                    (surface1.z = 1 when the primitive carries blend weights,
 *                                    surface1.w = 1 when the blend surface has a texture)
 * 560  fogCam     vec4<f32>    16   xyz = eye (world), w = fog volume count
 * 576  fogHeight  vec4<f32>    16   x = height-fog density, y = base, z = falloff, w = glow strength
 * 592  fogGlow    vec4<f32>    16   rgb = sun-glow colour
 * 608  fogVol     vec4<f32>×8 128   per volume: min xyz + density, max xyz + falloff
 * 736  effect0    vec4<f32>    16   rgb = surface-effect glow, w = camo amount (H11)
 * 752  effect1    vec4<f32>    16   rgb = surface-effect bands, w = time (seconds)
 *                                    (an effect's rim adds into surface2, at its power)
 * 768  layer0     vec4<f32>    16   x = clearcoat, y = its roughness, z = anisotropy,
 *                                    w = parallax depth (0 = none) (I4)
 * 784  layer1     vec4<f32>    16   xy = anisotropy rotation's cos and sin,
 *                                    z = 1 when a relief map rides in the occlusion map's G and B
 * 800  refract0   vec4<f32>    16   x = bend, y = warp, z = silhouette distortion,
 *                                    w = 1 when the draw refracts (I5; refraction.ts)
 * 816  refract1   vec4<f32>    16   xyz = the camera's right (world), w = frame height (px)
 * 832  refract2   vec4<f32>    16   xyz = the camera's up (world)
 * 848  water0     vec4<f32>    16   x = ripple strength (0 = still), y = ripples per metre,
 *                                    z = drift phase (0..1), w = flow direction (B5;
 *                                    waterUniform in materialEffects.ts)
 * 864  terrain0   vec4<f32>    16   x = triplanar repeat (0 = UV mapping), y = height-blend
 *                                    sharpness (0 = an even mix) (B6), z = macro variation
 *                                    strength, w = 1 / its scale (P2b; macroUniform)
 * 880  wind0      vec4<f32>    16   xy = the wind's x and z × strength, z = its phase (0..1),
 *                                    w = gust (B6; windUniform in wind.ts)
 * 896  maps0      vec4<f32>    16   x = 1 when a tangent-space normal map is bound (P1a),
 *                                    y = distance-tiling distance (0 = off) (P2b; farTileBlend),
 *                                    z = 1 when the water flows along the UVs (P3; waterTiltAlong),
 *                                    w = the material's ID in the thin G-buffer (F0c)
 * 912  wind1      vec4<f32>    16   the previous frame's wind0, for motion vectors (F0c)
 * 928  motion0    vec4<f32>    16   x = where the frame's motion transforms start in the
 *                                    instance buffer (F0c), w = the LOD level drawn (−1 without a chain; F10a)
 * 944  sheen0     vec4<f32>    16   rgb = sheen colour (linear), w = sheen roughness (F1d;
 *                                    materialExtensions.ts in @cartbox/editor)
 * 960  spec0      vec4<f32>    16   rgb = a dielectric's f0 (IOR and specular applied), w = specular factor
 * 976  trans0     vec4<f32>    16   x = transmission, y = thickness (m), z = attenuation distance
 *                                    (0 = none), w = IOR
 * 992  trans1     vec4<f32>    16   rgb = attenuation colour, w = iridescence
 * 1008 irid0      vec4<f32>    16   x = the film's IOR, y = its thickness (nm), z = emissive strength,
 *                                    w = 1 with a UV transform
 * 1024 uvx0       vec4<f32>    16   xy = the UV transform's scale, zw = its rotation's cos and sin
 * 1040 uvx1       vec4<f32>    16   xy = its offset, z = the share of the diffuse that scatters (F1d-2)
 * 1056 sss0       vec4<f32>    16   rgb = how far each channel scatters, as a colour, w = its radius (m)
 * 1072 dt0        vec4<f32>    16   rgb = the thin-surface transmission's colour, w = its share
 * 1088 char0      vec4<f32>    16   character shading (F7c; characterShading.ts): x = its kind
 *                                    (0 none, 1 skin, 2 eye, 3 hair, 4 mouth), yzw = its terms
 * 1104 char1      vec4<f32>    16   its other terms (a hair's dither and frame, a mouth's opening)
 * 1120 cull0      vec4<f32>    16   x = where a GPU-culled draw's copies start in the instance buffer (F0e;
 *                                    gpuCulling.ts), added to `instance_index`; 0 otherwise;
 *                                    y = an octahedral impostor's frames a side (F6b; 0: none), z = its half-size
 * 1136 terrain1   vec4<f32>    16   a GPU terrain's patch (F6c; gpuTerrain.ts): its size (x, z), the heights' min and
 *                                    range (> 0: a GPU terrain; 0 otherwise)
 * 1152 terrain2   vec4<f32>    16   cells a side, 1 with cut cells, the nearest page's side, pages following the eye
 * 1168 terrain3   vec4<f32>    16   the terrain's origin, the leaf node's side
 * 1184 terrain4   vec4<f32>    16   the eye in the ground plane (x, z), the split range, the morph's start
 * 1200 pages      vec4<f32> ×4 64   each eye-following page's corner, two a vec4
 * ```
 *
 * 1264 bytes used, padded to a 1280-byte stride (a 256-byte multiple a dynamic
 * uniform offset can address), so one buffer still holds every draw in a
 * frame — uniforms are written per batch, not per copy, so the stride costs
 * little. The metallic-roughness inputs and the environment carry the Modern
 * (AAA) tier's shading; a fantasy draw leaves `pbr.z` at 0 and the shader takes
 * the byte-identical Lambert path, `envSky.w` at 0 falls back to flat ambient,
 * `envMeta.w` at 0 uses the analytic gradient instead of a panorama, and
 * `shadow.x` at 0 skips the shadow test.
 */
export const UNIFORM_STRIDE = 1280;
/**
 * Bytes the struct actually occupies, before the stride padding. This is what a
 * bind group layout's `minBindingSize` must be: it makes a WGSL struct that
 * grows past what this module writes fail at pipeline creation.
 */
export const UNIFORM_BYTES_USED = 1264;
/** The same stride counted in float32s, which is how `writeBuffer` sizes it. */
export const UNIFORM_FLOATS = UNIFORM_STRIDE / 4;

/**
 * Floats per light in the storage buffer: five vec4s —
 *   d0: xyz = direction (directional) or world position (point, spot; an area
 *       light's centre), w = kind (0 directional, 1 point, 2 spot; 3, 4, 5 an
 *       area rectangle, disk or tube, F2e-2)
 *   d1: rgb = colour, w = intensity (an area light's luminance)
 *   d2: x = range (0 = no falloff), y = spot cone's outer cosine, z = its inner cosine
 *       (an area light's half width and half height: a disk's radius twice, a
 *       tube's half length and radius), w = first shadow tile (EP8c), −1 when it casts none
 *   d3: xyz = spot beam axis (unit, the way it points; the way an area light's lit
 *       face looks), w = 1 for inverse-square falloff, plus twice its lighting
 *       channels (F2e), the bits a draw's must share
 *   d4: xyz = an area light's tangent (its width axis, a tube's length)
 * Matches the `Light` struct in the WGSL and GLSL scene shaders.
 */
export const LIGHT_FLOATS = 20;

/**
 * Floats per reflection probe in its buffer: four vec4s — box min, box max,
 * capture point, mean colour (xyz each). Matches the `Probe` struct in the
 * shaders (see probeSampling.ts in @cartbox/editor).
 */
export const PROBE_FLOATS = 16;

/** Pack a probe set's boxes (at least one zeroed slot, so the binding is never empty). */
export function packProbes(set: ReflectionProbeSet | null | undefined): Float32Array {
  const probes = set ? set.probes.slice(0, MAX_REFLECTION_PROBES) : [];
  const out = new Float32Array(Math.max(1, probes.length) * PROBE_FLOATS);
  probes.forEach((p, i) => {
    const o = i * PROBE_FLOATS;
    out.set(p.min, o);
    out.set(p.max, o + 4);
    out.set(p.position, o + 8);
    out.set(p.average, o + 12);
  });
  return out;
}

/** A minimal light for {@link packLights} (mirrors editor's SceneLight). */
export interface PackableLight {
  readonly kind: "directional" | "point" | "spot" | "area";
  readonly shape?: "rect" | "disk" | "tube";
  readonly size?: readonly [number, number];
  readonly tangent?: readonly [number, number, number];
  readonly direction?: readonly [number, number, number];
  readonly position?: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly range?: number;
  readonly falloff?: "inverseSquare";
  readonly innerAngle?: number;
  readonly outerAngle?: number;
  readonly shadowTile?: number;
  readonly temperature?: number;
  readonly channels?: number;
  /** An IES profile (F9d): the renderer gives each distinct one a slot. */
  readonly ies?: object | null;
}

/**
 * Pack a light list into the storage-buffer layout the WGSL loop reads. Always
 * returns at least one (zeroed) light so the binding is never empty; the draw's
 * `lightCount` uniform, not the buffer length, bounds the loop. With `area`
 * false (every shader but the linear-light one), an area light (F2e-2) packs
 * as the punctual light it is from far off.
 */
export function packLights(lights: readonly PackableLight[], area = false, iesIndex: ((light: PackableLight) => number) | null = null): Float32Array {
  const out = new Float32Array(Math.max(1, lights.length) * LIGHT_FLOATS);
  lights.forEach((authored, i) => {
    const light: PackableLight = area ? authored : areaAsPunctual(authored as SceneLight);
    const base = i * LIGHT_FLOATS;
    const placed = light.kind !== "directional";
    const v = placed ? light.position ?? [0, 0, 0] : light.direction ?? [0, 1, 0];
    out[base] = v[0]!;
    out[base + 1] = v[1]!;
    out[base + 2] = v[2]!;
    out[base + 3] = light.kind === "area" ? AREA_KIND[light.shape ?? "rect"] : light.kind === "spot" ? 2 : placed ? 1 : 0;
    // Its temperature (F2e) is its colour as it shades.
    const color = lightColor(light);
    out[base + 4] = color[0]!;
    out[base + 5] = color[1]!;
    out[base + 6] = color[2]!;
    out[base + 7] = light.intensity;
    out[base + 8] = light.range ?? 0;
    out[base + 11] = light.shadowTile ?? -1;
    out[base + 15] = (placed && light.falloff === "inverseSquare" ? 1 : 0) + 2 * lightChannelMask(light.channels ?? 1);
    // d4.w: an IES profile's slot (F9d), or −1; its axis in d3 (a spot's direction, else straight down).
    out[base + 19] = -1;
    const profile = iesIndex && (light.kind === "point" || light.kind === "spot") ? iesIndex(authored) : -1;
    if (profile >= 0) {
      out[base + 19] = profile;
      const axis = light.direction ?? [0, -1, 0];
      const len = Math.hypot(axis[0]!, axis[1]!, axis[2]!) || 1;
      out.set([axis[0]! / len, axis[1]! / len, axis[2]! / len], base + 12);
    }
    if (light.kind === "area") {
      const [w, h] = areaSize(light);
      const frame = areaFrame(light);
      out[base + 9] = w / 2;
      out[base + 10] = h / 2;
      out[base + 11] = -1; // casts none
      out.set(frame.normal, base + 12);
      out.set(frame.tangent, base + 16);
      // Physical: its luminance falls as the square of the distance by nature, windowed to its range.
      out[base + 15] = 1 + 2 * lightChannelMask(light.channels ?? 1);
    }
    if (light.kind === "spot") {
      const [cosOuter, cosInner] = spotCone(light as SceneLight);
      out[base + 9] = cosOuter;
      out[base + 10] = cosInner;
      const axis = light.direction ?? [0, -1, 0];
      const len = Math.hypot(axis[0]!, axis[1]!, axis[2]!) || 1;
      out[base + 12] = axis[0]! / len;
      out[base + 13] = axis[1]! / len;
      out[base + 14] = axis[2]! / len;
    }
  });
  return out;
}

/** Float indices of each field within one stride. */
const OFFSET_MVP = 0;
const OFFSET_NRM = 16;
const OFFSET_BASE = 28;
const OFFSET_LIGHT = 32;
const OFFSET_VIEW = 36;
const OFFSET_PBR = 40;
const OFFSET_EMISSIVE = 44;
const OFFSET_TEXFLAGS = 48;
const OFFSET_ENV_SKY = 52;
const OFFSET_ENV_HORIZON = 56;
const OFFSET_ENV_GROUND = 60;
const OFFSET_LIGHT_MVP = 64;
const OFFSET_SHADOW = 80;
const OFFSET_ENV_META = 84;
const OFFSET_TONEMAP = 88;
const OFFSET_SSAO = 92;
const OFFSET_MODEL = 96;
const OFFSET_FOG = 112;
const OFFSET_FOG_PARAMS = 116;
const OFFSET_SHADOW2 = 120;
const OFFSET_SURFACE0 = 124;
const OFFSET_SURFACE1 = 128;
const OFFSET_SURFACE2 = 132;
const OFFSET_SURFACE3 = 136;
const OFFSET_FOG_CAM = 140;
const OFFSET_FOG_HEIGHT = 144;
const OFFSET_FOG_GLOW = 148;
const OFFSET_FOG_VOL = 152;
const OFFSET_EFFECT0 = 184;
const OFFSET_EFFECT1 = 188;
const OFFSET_LAYER0 = 192;
const OFFSET_LAYER1 = 196;
const OFFSET_REFRACT0 = 200;
const OFFSET_REFRACT1 = 204;
const OFFSET_REFRACT2 = 208;
const OFFSET_WATER0 = 212;
const OFFSET_TERRAIN0 = 216;
const OFFSET_WIND0 = 220;
const OFFSET_MAPS0 = 224;
const OFFSET_WIND1 = 228;
const OFFSET_MOTION0 = 232;
const OFFSET_SHEEN0 = 236;
const OFFSET_SPEC0 = 240;
const OFFSET_TRANS0 = 244;
const OFFSET_TRANS1 = 248;
const OFFSET_IRID0 = 252;
const OFFSET_UVX0 = 256;
const OFFSET_UVX1 = 260;
const OFFSET_SSS0 = 264;
const OFFSET_DT0 = 268;
const OFFSET_CHAR0 = 272;
const OFFSET_CHAR1 = 276;
const OFFSET_CULL0 = 280;
const OFFSET_TERRAIN = 284;

/** The rasteriser's defaults, restated so an unlit draw shades identically. */
export const DEFAULT_LIGHT: readonly [number, number, number] = [0.4, 0.8, 0.6];
export const DEFAULT_AMBIENT = 0.35;

export interface ResolvedLight {
  /** Unit direction; the shader dots against it without normalising. */
  readonly direction: readonly [number, number, number];
  readonly ambient: number;
}

/**
 * Apply the rasteriser's light defaulting and normalisation.
 *
 * The world overlay drives both per frame — a cart-published sun direction, and
 * an ambient level that differs by whether a sun is set at all — so this cannot
 * be a constant. It reproduces `renderMeshScene`'s exact handling, including its
 * degenerate-vector guard (a zero-length direction divides by 1, not by 0).
 */
export function resolveLight(
  direction?: readonly [number, number, number] | null,
  ambient?: number | null,
): ResolvedLight {
  const [lx, ly, lz] = direction ?? DEFAULT_LIGHT;
  const length = Math.hypot(lx!, ly!, lz!) || 1;
  return {
    direction: [lx! / length, ly! / length, lz! / length],
    ambient: ambient ?? DEFAULT_AMBIENT,
  };
}

/** Bytes per row in a texture-to-buffer copy: WebGPU requires a 256 multiple. */
export function alignBytesPerRow(width: number): number {
  return Math.ceil((width * 4) / 256) * 256;
}

/**
 * The upper-left 3x3 of a model matrix, column-major — what re-bases an object
 * normal into world space.
 *
 * This applies the rotation and scale rather than their inverse-transpose,
 * matching the software rasteriser exactly: correct for rotation and uniform
 * scale, slightly skewed under non-uniform scale, which two-sided Lambert
 * tolerates. Diverging here would make the two backends shade differently on
 * precisely the geometry most likely to be imported.
 */
export function normalBasis3x3(model: Mat4): readonly number[] {
  return [model[0]!, model[1]!, model[2]!, model[4]!, model[5]!, model[6]!, model[8]!, model[9]!, model[10]!];
}

/**
 * The Modern (AAA) tier's metallic-roughness inputs for one draw, mirroring the
 * software rasteriser's `buildPbrFrag` gate exactly (see `meshRasterizer.ts`): a
 * material is PBR when it carries any metallic-roughness signal — a map, or an
 * explicit metallic/roughness/emissive factor — and otherwise the fantasy path
 * runs. Keeping the gate here, pure and tested, is what keeps the two backends
 * from disagreeing about which materials light with the BRDF.
 */
export interface ResolvedPbr {
  readonly isPbr: boolean;
  readonly metallic: number;
  readonly roughness: number;
  readonly emissive: readonly [number, number, number];
}

/** Just the material fields the PBR gate reads. */
export interface PbrMaterial {
  readonly metallicFactor?: number;
  readonly roughnessFactor?: number;
  readonly emissiveFactor?: readonly [number, number, number];
  /** A material graph (EP7) always takes the PBR path. */
  readonly graph?: unknown;
  /** So do a clearcoat, anisotropy and a parallax relief (I4)… */
  readonly clearcoat?: number;
  readonly anisotropy?: number;
  readonly parallaxDepth?: number;
  /** …and refraction (I5). */
  readonly refraction?: number;
  readonly distortion?: number;
  /** …and moving water (B5). */
  readonly water?: MeshMaterial["water"];
}

/**
 * Resolve a draw's PBR inputs, matching `buildPbrFrag`. `hasMr`/`hasOcc`/`hasEmis`
 * say whether the instance bound each map for this primitive. The factor defaults
 * (metallic 1, roughness 1, emissive 0) are the glTF defaults the software path
 * uses too.
 */
export function resolvePbr(
  material: PbrMaterial,
  hasMr: boolean,
  hasOcc: boolean,
  hasEmis: boolean,
): ResolvedPbr {
  const emissiveFactor = material.emissiveFactor;
  const isPbr =
    hasMr ||
    hasOcc ||
    hasEmis ||
    material.metallicFactor !== undefined ||
    material.roughnessFactor !== undefined ||
    (emissiveFactor !== undefined && (emissiveFactor[0]! > 0 || emissiveFactor[1]! > 0 || emissiveFactor[2]! > 0)) ||
    material.graph !== undefined ||
    materialHasLayers(material) ||
    materialHasExtensions(material) ||
    materialRefracts(material) ||
    materialHasWater(material);
  return {
    isPbr,
    metallic: material.metallicFactor ?? 1,
    roughness: material.roughnessFactor ?? 1,
    emissive: emissiveFactor ?? [0, 0, 0],
  };
}

/**
 * The world-space direction *towards* the viewer, matching the software path
 * (`normalizeVec3(view[2], view[6], view[10])`): a look-at view maps this world
 * direction to view +Z, so it is the third row of the view rotation, treated as
 * directional (camera at infinity). The degenerate guard returns +Z, as the
 * rasteriser's `normalizeVec3` does.
 */
export function viewDirection(view: Mat4): readonly [number, number, number] {
  const x = view[2]!;
  const y = view[6]!;
  const z = view[10]!;
  const length = Math.hypot(x, y, z);
  return length < 1e-8 ? [0, 0, 1] : [x / length, y / length, z / length];
}

/**
 * A draw's surface effects (HALO2_STYLE_ROADMAP.md H3; materialEffects.ts in
 * @cartbox/editor), resolved for this frame exactly as the software
 * rasteriser's `buildPbrFrag` does.
 */
export interface ResolvedSurface {
  readonly detailScale: number;
  /** 0 when no detail map is bound. */
  readonly detailStrength: number;
  readonly reflect: number;
  readonly reflectMask: boolean;
  readonly emisOffset: readonly [number, number];
  /** Multiplies the emissive factor (the pulse). */
  readonly emisGain: number;
  /** Rim colour × strength (zeros for none) and power. */
  readonly rim: readonly [number, number, number];
  readonly rimPower: number;
  /** The blend surface (H4): on when the primitive carries weights; its colour, roughness (null = keep), and whether it has a texture. */
  readonly blend: { readonly color: readonly [number, number, number]; readonly roughness: number | null; readonly textured: boolean } | null;
}

/** No effects: what a material without any gets. */
export const NO_SURFACE: ResolvedSurface = { detailScale: DEFAULT_DETAIL_SCALE, detailStrength: 0, reflect: 1, reflectMask: false, emisOffset: [0, 0], emisGain: 1, rim: [0, 0, 0], rimPower: 1, blend: null };

/** Resolve a material's surface effects at `time` seconds, given which maps are bound. */
export function resolveSurface(material: MeshMaterial, time: number, hasDetail: boolean, hasMr: boolean, blend: { weights: boolean; textured: boolean } = { weights: false, textured: false }): ResolvedSurface {
  const { offset, gain } = emissiveAnimation(material, time);
  const rim = material.rim && material.rim.strength > 0 ? material.rim : null;
  return {
    detailScale: material.detailScale ?? DEFAULT_DETAIL_SCALE,
    detailStrength: hasDetail ? (material.detailStrength ?? DEFAULT_DETAIL_STRENGTH) : 0,
    reflect: material.reflectivity ?? 1,
    reflectMask: material.reflectionMask === true && hasMr,
    emisOffset: offset,
    emisGain: gain,
    rim: rim ? [rim.color[0] * rim.strength, rim.color[1] * rim.strength, rim.color[2] * rim.strength] : [0, 0, 0],
    rimPower: rim?.power ?? 1,
    blend: blend.weights ? { color: material.blendColor ?? [1, 1, 1], roughness: material.blendRoughness ?? null, textured: blend.textured } : null,
  };
}

export interface InstanceUniform {
  readonly mvp: Mat4;
  /** Column-major 3x3 from {@link normalBasis3x3}. */
  readonly normalBasis: readonly number[];
  readonly baseColor: readonly [number, number, number, number];
  readonly hasTexture: boolean;
  /** This frame's light, from {@link resolveLight}. */
  readonly light: ResolvedLight;
  /** This frame's view direction, from {@link viewDirection} (Modern PBR). */
  readonly viewDir: readonly [number, number, number];
  /** This draw's PBR inputs, from {@link resolvePbr}. */
  readonly pbr: ResolvedPbr;
  /** Whether each PBR map is bound for this primitive. */
  readonly hasMrMap: boolean;
  readonly hasOcclusionMap: boolean;
  readonly hasEmissiveMap: boolean;
  /** This frame's image-based lighting environment, or null for flat ambient. */
  readonly environment: EnvironmentLight | null;
  /** World→light-clip for this draw (`shadow.lightViewProj · model`), or null. */
  readonly lightMvp: Mat4 | null;
  /** Shadow-map sampling parameters, or null when no shadow map is bound. */
  readonly shadow: {
    readonly size: number;
    readonly bias: number;
    readonly strength: number;
    /** Slope-scaled bias (0 = constant bias only). */
    readonly slopeBias?: number;
    /** 2x2 percentage-closer filtering. */
    readonly pcf?: boolean;
    /** With pcf, a 4×4 neighbourhood instead of 2×2 (B7). */
    readonly soft?: boolean;
  } | null;
  /** HDR tone-map exposure, or null to write the shaded colour straight through. */
  readonly tonemap: { readonly exposure: number; readonly authored?: boolean } | null;
  /** Whether a screen-space AO buffer is bound (sampled per fragment on the GPU). */
  readonly hasSsao: boolean;
  /** A baked light map is bound (it scales the ambient/IBL term, PBR draws only). */
  readonly hasLightmap?: boolean;
  /** The bound light map is an HDR directional one (F3d), which the linear-light shader lights by in place of the sky's irradiance. */
  readonly hdrLightmap?: boolean;
  /** This draw's world matrix, for point-light world position in the shader. */
  readonly model: Mat4 | null;
  /** Number of lights in the shared storage buffer, or 0 for the single key light. */
  readonly lightCount: number;
  /** This draw's surface effects, or omitted for none. */
  readonly surface?: ResolvedSurface;
  /** This draw's clearcoat, anisotropy and relief (I4; see materialLayers.ts in @cartbox/editor), or omitted for none. */
  readonly layers?: ResolvedLayers;
  /** This draw's full material set (F1d; materialExtensions.ts in @cartbox/editor), or omitted for the defaults. */
  readonly extensions?: ResolvedExtensions;
  /** The frame's count, which moves a hair's dither (F7c). */
  readonly frame?: number;
  /** How this draw bends what's behind it (I5; refraction.ts in @cartbox/editor), or null/omitted when it doesn't. */
  readonly refraction?: ResolvedRefraction | null;
  /** The camera's right and up and the frame's height, which a refraction's offset is measured by. */
  readonly camera?: { readonly right: readonly [number, number, number]; readonly up: readonly [number, number, number]; readonly height: number } | null;
  /** Fog for PBR draws (distance, height, volumes, sun glow), or null/omitted for none. */
  readonly fog?: SceneFog | null;
  /** The eye in world space — height and volume fog trace the ray from it. */
  readonly eye?: readonly [number, number, number];
  /** A surface effect over the draw (shield flare, shimmer, camo — PBR draws only), or null/omitted for none. */
  readonly effect?: SurfaceEffect | null;
  /** Seconds, for the effect's bands and camo crawl. */
  readonly time?: number;
  /** The material's transparency (EP6): 0 opaque, 1 cut out below `cutoff`, 2 blended, 3 added. */
  readonly alpha?: { readonly mode: number; readonly cutoff: number };
  /**
   * Soft edges (EP6b): the distance a see-through surface fades over as it
   * meets the opaque scene, and the projection terms that read depth back as distance.
   */
  readonly soft?: { readonly distance: number; readonly linear: readonly [number, number] };
  /** Moving water (B5): the material's waterUniform this frame, or null/omitted for none. */
  readonly water?: readonly [number, number, number, number] | null;
  /** The water's ripples flow along the UVs (EDITOR_PRO_ROADMAP.md P3), not the world's X and Z. */
  readonly waterAlong?: boolean;
  /** Triplanar mapping and height blending (B6), from {@link resolveMapping}, or null/omitted for neither. */
  readonly mapping?: ResolvedMapping | null;
  /** The frame's wind (B6): its windUniform, or null/omitted for still air. */
  readonly wind?: readonly [number, number, number, number] | null;
  /** A tangent-space normal map is bound (EDITOR_PRO_ROADMAP.md P1a). */
  readonly hasNormalMap?: boolean;
  /** The draw's material ID in the thin G-buffer (AAA_FIDELITY_ROADMAP.md F0c): 1 and up, one per material in the frame. */
  readonly materialId?: number;
  /** The previous frame's wind (its windUniform), for motion vectors (F0c); null/omitted for still air. */
  readonly windBefore?: readonly [number, number, number, number] | null;
  /** Where the frame's motion transforms start in the instance buffer (F0c). */
  readonly motionBase?: number;
  /** Where a GPU-culled draw's copies start in the instance buffer (F0e): its indirect draws start at instance 0. */
  readonly instanceBase?: number;
  /** The lighting channels the draw's copies are on (F2e), absent the first. */
  readonly lightChannels?: number;
  /** How many probes the shader loops over, where not `environment.probes`' (the linear variant's GPU-captured ones, F3b). */
  readonly probeCount?: number;
  /** The draw takes the frame's projected decals (F1f): an opaque or cut-out surface that doesn't refract. */
  readonly receivesDecals?: boolean;
  /** The LOD level its copies draw (F10a's LOD view), or −1 (the default) without a chain. */
  readonly lodLevel?: number;
  /** An octahedral impostor's frames a side and half-size (F6b; MeshMaterial.octahedral), or null/omitted. */
  readonly octahedral?: { readonly frames: number; readonly radius: number } | null;
  /** A GPU terrain's patch (F6c; GpuTerrain.values): its 32 floats, or null/omitted. */
  readonly terrain?: Float32Array | null;
}

/**
 * A draw's triplanar repeat (0 = UV mapping) and height-blend sharpness (0 = an
 * even mix) (B6); its macro variation ([strength, 1 / scale]) and distance
 * tiling (0 = off) (P2b).
 */
export interface ResolvedMapping {
  readonly triplanar: number;
  readonly blendSharpness: number;
  readonly macro?: readonly [number, number];
  readonly farTile?: number;
}

/** Resolve a material's mapping as the software rasteriser does (null when it uses none of it). */
export function resolveMapping(material: Pick<MeshMaterial, "triplanar" | "blendSharpness" | "macro" | "farTile">): ResolvedMapping | null {
  const triplanar = material.triplanar && material.triplanar > 0 ? material.triplanar : 0;
  const blendSharpness = material.blendSharpness && material.blendSharpness > 0 ? Math.min(1, material.blendSharpness) : 0;
  const macro = macroUniform(material);
  const farTile = material.farTile && material.farTile > 0 ? material.farTile : 0;
  return triplanar > 0 || blendSharpness > 0 || macro[0] > 0 || farTile > 0 ? { triplanar, blendSharpness, macro, farTile } : null;
}

/**
 * Floats per instance in the transform storage buffer (GPU instancing): the WGSL
 * `InstanceXf` struct — mvp, lightMvp and model (mat4x4 each) then the normal
 * basis (mat3x3, columns padded to vec4) — is 240 bytes, which is also its array
 * stride (a multiple of its 16-byte alignment).
 */
export const INSTANCE_FLOATS = 60;

/** One instance's transforms, computed on the CPU so the GPU sees the same float32s the uniform path did. */
export interface InstanceTransform {
  readonly mvp: Mat4;
  /** World→light-clip for this instance, or null when the frame casts no shadow. */
  readonly lightMvp: Mat4 | null;
  readonly model: Mat4;
  readonly normalBasis: readonly number[];
}

/**
 * Write one instance's transforms into the staging array at `index` (see
 * {@link INSTANCE_FLOATS}), or at float offset `base` when the caller lays
 * instances out itself (WebGL2 aligns each block's start).
 */
export function writeInstanceTransform(target: Float32Array, index: number, transform: InstanceTransform, base = index * INSTANCE_FLOATS): void {
  for (let i = 0; i < 16; i += 1) {
    target[base + i] = transform.mvp[i]!;
    target[base + 16 + i] = transform.lightMvp ? transform.lightMvp[i]! : 0;
    target[base + 32 + i] = transform.model[i]!;
  }
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) target[base + 48 + column * 4 + row] = transform.normalBasis[column * 3 + row]!;
    target[base + 48 + column * 4 + 3] = 0;
  }
}

/** A draw's full material set into its uniform (F1d): the defaults (a 4% dielectric of IOR 1.5, no sheen, film or transform) without one. */
function writeExtensions(target: Float32Array, base: number, e: ResolvedExtensions | null, alphaMode: number, frame: number): void {
  const sheen = e?.sheenColor ?? [0, 0, 0];
  target.set([sheen[0], sheen[1], sheen[2], e?.sheenRoughness ?? 0], base + OFFSET_SHEEN0);
  const f0 = e?.dielectricF0 ?? [0.04, 0.04, 0.04];
  target.set([f0[0], f0[1], f0[2], e?.specularFactor ?? 1], base + OFFSET_SPEC0);
  target.set([e?.transmission ?? 0, e?.thickness ?? 0, e?.attenuationDistance ?? 0, e?.ior ?? 1.5], base + OFFSET_TRANS0);
  const att = e?.attenuationColor ?? [1, 1, 1];
  target.set([att[0], att[1], att[2], e?.iridescence ?? 0], base + OFFSET_TRANS1);
  const t = e?.uvTransform ?? null;
  target.set([e?.iridescenceIor ?? 1.3, e?.iridescenceThickness ?? 400, e?.emissiveStrength ?? 1, t ? 1 : 0], base + OFFSET_IRID0);
  target.set(t ? [t.scale[0], t.scale[1], Math.cos(t.rotation), Math.sin(t.rotation)] : [1, 1, 1, 0], base + OFFSET_UVX0);
  target.set([t ? t.offset[0] : 0, t ? t.offset[1] : 0, e?.subsurface ?? 0, 0], base + OFFSET_UVX1);
  const sss = e?.subsurfaceColor ?? [0, 0, 0];
  target.set([sss[0], sss[1], sss[2], e?.subsurfaceRadius ?? 0], base + OFFSET_SSS0);
  const dt = e?.diffuseTransmissionColor ?? [1, 1, 1];
  target.set([dt[0], dt[1], dt[2], e?.diffuseTransmission ?? 0], base + OFFSET_DT0);
  // Character shading (F7c): a masked hair card dithers its alpha.
  const [char0, char1] = packCharacter(e?.character ?? null, alphaMode === 1, frame);
  target.set(char0, base + OFFSET_CHAR0);
  target.set(char1, base + OFFSET_CHAR1);
}

/**
 * Write one draw's uniforms into the shared staging array at `index`.
 *
 * The mat3x3 is the fiddly part: WGSL pads each column to 16 bytes, so the nine
 * values are written at float offsets 0,1,2 / 4,5,6 / 8,9,10 within the field
 * and never packed tight. Getting this wrong does not error — it silently shears
 * every normal, which reads as bad lighting rather than as a layout bug.
 */
export function writeInstanceUniform(target: Float32Array, index: number, uniform: InstanceUniform): void {
  const base = index * UNIFORM_FLOATS;

  for (let i = 0; i < 16; i += 1) target[base + OFFSET_MVP + i] = uniform.mvp[i]!;

  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      target[base + OFFSET_NRM + column * 4 + row] = uniform.normalBasis[column * 3 + row]!;
    }
  }

  target[base + OFFSET_BASE] = uniform.baseColor[0];
  target[base + OFFSET_BASE + 1] = uniform.baseColor[1];
  target[base + OFFSET_BASE + 2] = uniform.baseColor[2];
  target[base + OFFSET_BASE + 3] = uniform.baseColor[3];

  target[base + OFFSET_LIGHT] = uniform.light.direction[0]!;
  target[base + OFFSET_LIGHT + 1] = uniform.light.direction[1]!;
  target[base + OFFSET_LIGHT + 2] = uniform.light.direction[2]!;
  target[base + OFFSET_LIGHT + 3] = uniform.light.ambient;

  target[base + OFFSET_VIEW] = uniform.viewDir[0]!;
  target[base + OFFSET_VIEW + 1] = uniform.viewDir[1]!;
  target[base + OFFSET_VIEW + 2] = uniform.viewDir[2]!;
  target[base + OFFSET_VIEW + 3] = uniform.alpha?.cutoff ?? 0;

  target[base + OFFSET_PBR] = uniform.pbr.metallic;
  target[base + OFFSET_PBR + 1] = uniform.pbr.roughness;
  target[base + OFFSET_PBR + 2] = uniform.pbr.isPbr ? 1 : 0;
  target[base + OFFSET_PBR + 3] = uniform.alpha?.mode ?? 0;

  const surface = uniform.surface ?? NO_SURFACE;
  target[base + OFFSET_EMISSIVE] = uniform.pbr.emissive[0]! * surface.emisGain;
  target[base + OFFSET_EMISSIVE + 1] = uniform.pbr.emissive[1]! * surface.emisGain;
  target[base + OFFSET_EMISSIVE + 2] = uniform.pbr.emissive[2]! * surface.emisGain;
  target[base + OFFSET_EMISSIVE + 3] = 0;

  target[base + OFFSET_TEXFLAGS] = uniform.hasTexture ? 1 : 0;
  target[base + OFFSET_TEXFLAGS + 1] = uniform.hasMrMap ? 1 : 0;
  target[base + OFFSET_TEXFLAGS + 2] = uniform.hasOcclusionMap ? 1 : 0;
  target[base + OFFSET_TEXFLAGS + 3] = uniform.hasEmissiveMap ? 1 : 0;

  const env = uniform.environment;
  target[base + OFFSET_ENV_SKY] = env ? env.sky[0]! : 0;
  target[base + OFFSET_ENV_SKY + 1] = env ? env.sky[1]! : 0;
  target[base + OFFSET_ENV_SKY + 2] = env ? env.sky[2]! : 0;
  target[base + OFFSET_ENV_SKY + 3] = env ? 1 : 0; // hasEnvironment
  target[base + OFFSET_ENV_HORIZON] = env ? env.horizon[0]! : 0;
  target[base + OFFSET_ENV_HORIZON + 1] = env ? env.horizon[1]! : 0;
  target[base + OFFSET_ENV_HORIZON + 2] = env ? env.horizon[2]! : 0;
  target[base + OFFSET_ENV_HORIZON + 3] = env ? env.intensity : 0;
  target[base + OFFSET_ENV_GROUND] = env ? env.ground[0]! : 0;
  target[base + OFFSET_ENV_GROUND + 1] = env ? env.ground[1]! : 0;
  target[base + OFFSET_ENV_GROUND + 2] = env ? env.ground[2]! : 0;
  target[base + OFFSET_ENV_GROUND + 3] = 0;

  // World→light-clip for shadow mapping (identity-ish zeros when no shadow; the
  // shader gates on shadow.x so the value is never read in that case).
  const lightMvp = uniform.lightMvp;
  for (let i = 0; i < 16; i += 1) target[base + OFFSET_LIGHT_MVP + i] = lightMvp ? lightMvp[i]! : 0;

  const shadow = uniform.shadow;
  target[base + OFFSET_SHADOW] = shadow ? 1 : 0; // hasShadow
  target[base + OFFSET_SHADOW + 1] = shadow ? shadow.size : 0;
  target[base + OFFSET_SHADOW + 2] = shadow ? shadow.bias : 0;
  target[base + OFFSET_SHADOW + 3] = shadow ? shadow.strength : 0;

  // Env-map mean radiance + flag. The map texture itself is bound separately; the
  // shader samples it when envMeta.w is 1, else uses the analytic gradient.
  const envMap = env && env.map ? env : null;
  const avg = envMap?.average ?? null;
  target[base + OFFSET_ENV_META] = avg ? avg[0]! : 0;
  target[base + OFFSET_ENV_META + 1] = avg ? avg[1]! : 0;
  target[base + OFFSET_ENV_META + 2] = avg ? avg[2]! : 0;
  target[base + OFFSET_ENV_META + 3] = envMap && avg ? 1 : 0; // hasEnvMap

  const tonemap = uniform.tonemap;
  target[base + OFFSET_TONEMAP] = tonemap ? 1 : 0; // hasTonemap
  target[base + OFFSET_TONEMAP + 1] = tonemap ? tonemap.exposure : 0;
  target[base + OFFSET_TONEMAP + 2] = uniform.soft?.distance ?? 0;
  target[base + OFFSET_TONEMAP + 3] = tonemap?.authored ? 1 : 0;

  target[base + OFFSET_SSAO] = uniform.hasSsao ? 1 : 0;
  target[base + OFFSET_SSAO + 1] = uniform.lightCount; // light count for the storage-buffer loop
  target[base + OFFSET_SSAO + 2] = uniform.hdrLightmap ? 2 : uniform.hasLightmap ? 1 : 0;
  target[base + OFFSET_SSAO + 3] = uniform.probeCount ?? (env?.probes ? Math.min(env.probes.probes.length, MAX_REFLECTION_PROBES) : 0);

  const model = uniform.model;
  for (let i = 0; i < 16; i += 1) target[base + OFFSET_MODEL + i] = model ? model[i]! : (i % 5 === 0 ? 1 : 0);

  const fog = uniform.fog ?? null;
  target[base + OFFSET_FOG] = fog ? fog.color[0] : 0;
  target[base + OFFSET_FOG + 1] = fog ? fog.color[1] : 0;
  target[base + OFFSET_FOG + 2] = fog ? fog.color[2] : 0;
  target[base + OFFSET_FOG + 3] = fog ? fog.density : 0;
  target[base + OFFSET_FOG_PARAMS] = fog ? 1 : 0; // hasFog
  target[base + OFFSET_FOG_PARAMS + 1] = fog ? fog.start : 0;
  target[base + OFFSET_FOG_PARAMS + 2] = fog ? fog.max : 0;
  const volumetric = fog !== null && fogIsVolumetric(fog);
  target[base + OFFSET_FOG_PARAMS + 3] = volumetric ? 1 : 0;
  const eye = uniform.eye ?? [0, 0, 0];
  const layered = volumetric ? fog : null;
  const volumes = (layered?.volumes ?? []).slice(0, MAX_FOG_VOLUMES);
  const height = layered?.height ?? null;
  const glow = layered?.glow ?? null;
  target[base + OFFSET_FOG_CAM] = eye[0];
  target[base + OFFSET_FOG_CAM + 1] = eye[1];
  target[base + OFFSET_FOG_CAM + 2] = eye[2];
  target[base + OFFSET_FOG_CAM + 3] = volumes.length;
  target[base + OFFSET_FOG_HEIGHT] = height ? height.density : 0;
  target[base + OFFSET_FOG_HEIGHT + 1] = height ? height.base : 0;
  target[base + OFFSET_FOG_HEIGHT + 2] = height ? height.falloff : 0;
  target[base + OFFSET_FOG_HEIGHT + 3] = glow ? glow.strength : 0;
  target[base + OFFSET_FOG_GLOW] = glow ? glow.color[0] : 0;
  target[base + OFFSET_FOG_GLOW + 1] = glow ? glow.color[1] : 0;
  target[base + OFFSET_FOG_GLOW + 2] = glow ? glow.color[2] : 0;
  target[base + OFFSET_FOG_GLOW + 3] = 0;
  for (let i = 0; i < MAX_FOG_VOLUMES; i += 1) {
    const v = volumes[i];
    const o = base + OFFSET_FOG_VOL + i * 8;
    target[o] = v ? v.min[0] : 0;
    target[o + 1] = v ? v.min[1] : 0;
    target[o + 2] = v ? v.min[2] : 0;
    target[o + 3] = v ? v.density : 0;
    target[o + 4] = v ? v.max[0] : 0;
    target[o + 5] = v ? v.max[1] : 0;
    target[o + 6] = v ? v.max[2] : 0;
    target[o + 7] = v ? v.falloff : 0;
  }

  target[base + OFFSET_SHADOW2] = shadow ? shadow.slopeBias ?? 0 : 0;
  target[base + OFFSET_SHADOW2 + 1] = shadow && shadow.pcf ? (shadow.soft ? 2 : 1) : 0;
  target[base + OFFSET_SHADOW2 + 2] = uniform.soft?.linear[0] ?? 0;
  target[base + OFFSET_SHADOW2 + 3] = uniform.soft?.linear[1] ?? 0;

  target[base + OFFSET_SURFACE0] = surface.detailScale;
  target[base + OFFSET_SURFACE0 + 1] = surface.detailStrength;
  target[base + OFFSET_SURFACE0 + 2] = surface.reflect;
  target[base + OFFSET_SURFACE0 + 3] = surface.reflectMask ? 1 : 0;
  target[base + OFFSET_SURFACE1] = surface.emisOffset[0];
  target[base + OFFSET_SURFACE1 + 1] = surface.emisOffset[1];
  target[base + OFFSET_SURFACE1 + 2] = surface.blend ? 1 : 0;
  target[base + OFFSET_SURFACE1 + 3] = surface.blend?.textured ? 1 : 0;
  // A surface effect's rim adds to the material's, at the effect's power (as the rasteriser does).
  const effect = effectActive(uniform.effect) ? uniform.effect : null;
  const fxRim = effect?.rim && (effect.rim[0] > 0 || effect.rim[1] > 0 || effect.rim[2] > 0) ? effect.rim : null;
  target[base + OFFSET_SURFACE2] = surface.rim[0] + (fxRim ? fxRim[0] : 0);
  target[base + OFFSET_SURFACE2 + 1] = surface.rim[1] + (fxRim ? fxRim[1] : 0);
  target[base + OFFSET_SURFACE2 + 2] = surface.rim[2] + (fxRim ? fxRim[2] : 0);
  target[base + OFFSET_SURFACE2 + 3] = fxRim ? (effect!.rimPower ?? EFFECT_RIM_POWER) : surface.rimPower;
  target[base + OFFSET_SURFACE3] = surface.blend ? surface.blend.color[0] : 0;
  target[base + OFFSET_SURFACE3 + 1] = surface.blend ? surface.blend.color[1] : 0;
  target[base + OFFSET_SURFACE3 + 2] = surface.blend ? surface.blend.color[2] : 0;
  target[base + OFFSET_SURFACE3 + 3] = surface.blend && surface.blend.roughness !== null ? surface.blend.roughness : -1;
  target[base + OFFSET_EFFECT0] = effect?.glow ? effect.glow[0] : 0;
  target[base + OFFSET_EFFECT0 + 1] = effect?.glow ? effect.glow[1] : 0;
  target[base + OFFSET_EFFECT0 + 2] = effect?.glow ? effect.glow[2] : 0;
  target[base + OFFSET_EFFECT0 + 3] = effect ? Math.max(0, Math.min(1, effect.camo ?? 0)) : 0;
  target[base + OFFSET_EFFECT1] = effect?.bands ? effect.bands[0] : 0;
  target[base + OFFSET_EFFECT1 + 1] = effect?.bands ? effect.bands[1] : 0;
  target[base + OFFSET_EFFECT1 + 2] = effect?.bands ? effect.bands[2] : 0;
  target[base + OFFSET_EFFECT1 + 3] = uniform.time ?? 0;

  const layers = uniform.layers ?? NO_LAYERS;
  target[base + OFFSET_LAYER0] = layers.clearcoat;
  target[base + OFFSET_LAYER0 + 1] = layers.clearcoatRoughness;
  target[base + OFFSET_LAYER0 + 2] = layers.anisotropy;
  target[base + OFFSET_LAYER0 + 3] = layers.parallaxDepth;
  target[base + OFFSET_LAYER1] = layers.anisotropyCos;
  target[base + OFFSET_LAYER1 + 1] = layers.anisotropySin;
  target[base + OFFSET_LAYER1 + 2] = layers.relief ? 1 : 0;
  target[base + OFFSET_LAYER1 + 3] = 0;

  writeExtensions(target, base, uniform.extensions ?? null, uniform.alpha?.mode ?? 0, uniform.frame ?? 0);

  const refraction = uniform.refraction ?? null;
  target[base + OFFSET_REFRACT0] = refraction ? refraction.bend : 0;
  target[base + OFFSET_REFRACT0 + 1] = refraction ? refraction.warp : 0;
  target[base + OFFSET_REFRACT0 + 2] = refraction ? refraction.edge : 0;
  target[base + OFFSET_REFRACT0 + 3] = refraction ? 1 : 0;
  const camera = uniform.camera ?? null;
  target[base + OFFSET_REFRACT1] = camera ? camera.right[0] : 0;
  target[base + OFFSET_REFRACT1 + 1] = camera ? camera.right[1] : 0;
  target[base + OFFSET_REFRACT1 + 2] = camera ? camera.right[2] : 0;
  target[base + OFFSET_REFRACT1 + 3] = camera ? camera.height : 0;
  target[base + OFFSET_REFRACT2] = camera ? camera.up[0] : 0;
  target[base + OFFSET_REFRACT2 + 1] = camera ? camera.up[1] : 0;
  target[base + OFFSET_REFRACT2 + 2] = camera ? camera.up[2] : 0;
  target[base + OFFSET_REFRACT2 + 3] = 0;

  const water = uniform.water ?? null;
  target[base + OFFSET_WATER0] = water ? water[0] : 0;
  target[base + OFFSET_WATER0 + 1] = water ? water[1] : 0;
  target[base + OFFSET_WATER0 + 2] = water ? water[2] : 0;
  target[base + OFFSET_WATER0 + 3] = water ? water[3] : 0;

  const mapping = uniform.mapping ?? null;
  target[base + OFFSET_TERRAIN0] = mapping ? mapping.triplanar : 0;
  target[base + OFFSET_TERRAIN0 + 1] = mapping ? mapping.blendSharpness : 0;
  target[base + OFFSET_TERRAIN0 + 2] = mapping?.macro ? mapping.macro[0] : 0;
  target[base + OFFSET_TERRAIN0 + 3] = mapping?.macro ? mapping.macro[1] : 0;

  const wind = uniform.wind ?? null;
  target[base + OFFSET_WIND0] = wind ? wind[0] : 0;
  target[base + OFFSET_WIND0 + 1] = wind ? wind[1] : 0;
  target[base + OFFSET_WIND0 + 2] = wind ? wind[2] : 0;
  target[base + OFFSET_WIND0 + 3] = wind ? wind[3] : 0;

  target[base + OFFSET_MAPS0] = uniform.hasNormalMap ? 1 : 0;
  target[base + OFFSET_MAPS0 + 1] = mapping?.farTile ?? 0;
  target[base + OFFSET_MAPS0 + 2] = uniform.waterAlong ? 1 : 0;
  target[base + OFFSET_MAPS0 + 3] = uniform.materialId ?? 0;

  const before = uniform.windBefore ?? null;
  for (let k = 0; k < 4; k += 1) target[base + OFFSET_WIND1 + k] = before ? before[k]! : 0;
  target[base + OFFSET_MOTION0] = uniform.motionBase ?? 0;
  target[base + OFFSET_MOTION0 + 1] = uniform.lightChannels ?? 1;
  target[base + OFFSET_MOTION0 + 2] = uniform.receivesDecals ? 1 : 0;
  target[base + OFFSET_MOTION0 + 3] = uniform.lodLevel ?? -1;
  target[base + OFFSET_CULL0] = uniform.instanceBase ?? 0;
  target[base + OFFSET_CULL0 + 1] = uniform.octahedral?.frames ?? 0;
  target[base + OFFSET_CULL0 + 2] = uniform.octahedral?.radius ?? 0;
  if (uniform.terrain) target.set(uniform.terrain, base + OFFSET_TERRAIN);
  else target.fill(0, base + OFFSET_TERRAIN, base + OFFSET_TERRAIN + 32);
}

/**
 * The floats of a draw's uniform that are the frame's rather than the draw's
 * (AAA_FIDELITY_ROADMAP.md F0e), as [offset, count]: the light, the view
 * direction, the environment, the shadow's and tone map's settings, the SSAO
 * flag, light and probe counts, the fog and its eye, the time and the camera.
 * A draw whose own inputs haven't changed since last frame, and that doesn't
 * animate by itself ({@link uniformAnimates}), takes only these from the
 * frame's: everything else in its slot is as it was.
 */
export const FRAME_UNIFORM_RANGES: readonly (readonly [number, number])[] = [
  [OFFSET_LIGHT, 4],
  [OFFSET_VIEW, 3], // w is the draw's alpha cutoff
  [OFFSET_ENV_SKY, 12], // sky, horizon, ground
  [OFFSET_SHADOW, 4],
  [OFFSET_ENV_META, 4],
  [OFFSET_TONEMAP, 2], // z is the draw's soft-edge distance
  [OFFSET_TONEMAP + 3, 1],
  [OFFSET_SSAO, 2], // z is the draw's light-map flag
  [OFFSET_SSAO + 3, 1],
  [OFFSET_FOG, 8], // the fog and its params
  [OFFSET_SHADOW2, 2], // zw are a soft-edged draw's depth terms
  [OFFSET_FOG_CAM, OFFSET_EFFECT0 - OFFSET_FOG_CAM], // the eye, height fog, glow and volumes
  [OFFSET_EFFECT1 + 3, 1], // the time
  [OFFSET_REFRACT1, 8], // the camera's right, up and height
];

/** Every float {@link FRAME_UNIFORM_RANGES} covers, in one list (copied float by float, which beats a view per range). */
const FRAME_FLOATS = Uint16Array.from(FRAME_UNIFORM_RANGES.flatMap(([offset, count]) => Array.from({ length: count }, (_, k) => offset + k)));

/** Copy the frame's fields ({@link FRAME_UNIFORM_RANGES}) from the draw at `from` (written in full this frame) into the draw at `index`. */
export function copyFrameUniform(target: Float32Array, index: number, from: number): void {
  const to = index * UNIFORM_FLOATS;
  const at = from * UNIFORM_FLOATS;
  for (let i = 0; i < FRAME_FLOATS.length; i += 1) {
    const f = FRAME_FLOATS[i]!;
    target[to + f] = target[at + f]!;
  }
}

/**
 * Whether a draw's uniform moves by itself from frame to frame, besides the
 * frame's fields: the wind on a swaying primitive, water's drift, a scrolling
 * or pulsing emission, a surface effect, refraction, soft edges (their depth
 * terms follow the projection) and a hair card's dither.
 */
export function uniformAnimates(material: MeshMaterial, alpha: number, sway: boolean, refract: boolean, effect: SurfaceEffect | null | undefined): boolean {
  return sway || refract || effectActive(effect ?? null) || (alpha >= 2 && (material.softDepth ?? 0) > 0) || materialAnimates(material);
}

const animating = new WeakMap<MeshMaterial, boolean>();
/** A material's own motion: water's drift, a scrolling or pulsing emission, a hair card's dither (cached per material, as its other resolutions are). */
function materialAnimates(material: MeshMaterial): boolean {
  let out = animating.get(material);
  if (out === undefined) {
    out = materialHasWater(material) || material.emissiveScroll !== undefined || material.emissivePulse !== undefined || resolveExtensions(material).character !== null;
    animating.set(material, out);
  }
  return out;
}

/** The camera's right and up in world space (the view's first two rows) and the frame's height, for refraction (I5). */
export function refractionCamera(view: Mat4, height: number): NonNullable<InstanceUniform["camera"]> {
  return { right: [view[0]!, view[4]!, view[8]!], up: [view[1]!, view[5]!, view[9]!], height };
}

/** Floats per vertex in the interleaved buffer: position(3) + normal(3) + uv(2) + light-map uv(2) + blend weight(1) + sway(1). */
export const VERTEX_FLOATS = 12;

/**
 * Interleave the separate attribute streams into the single buffer the pipeline
 * declares (arrayStride 48; WebGPU's adds a tangent, see below). A primitive with no UVs (or no light-map UVs, blend weights or sway) gets
 * zeros, which is what the software path effectively uses — and the shader
 * ignores them anyway because the matching texture flag is off.
 */
export function interleaveVertices(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array | null,
  uvs2: Float32Array | null = null,
  blend: Float32Array | null = null,
  sway: Float32Array | null = null,
): Float32Array {
  const count = Math.floor(positions.length / 3);
  const out = new Float32Array(count * VERTEX_FLOATS);
  for (let i = 0; i < count; i += 1) {
    const to = i * VERTEX_FLOATS;
    out[to] = positions[i * 3] ?? 0;
    out[to + 1] = positions[i * 3 + 1] ?? 0;
    out[to + 2] = positions[i * 3 + 2] ?? 0;
    out[to + 3] = normals[i * 3] ?? 0;
    out[to + 4] = normals[i * 3 + 1] ?? 0;
    out[to + 5] = normals[i * 3 + 2] ?? 0;
    out[to + 6] = uvs ? (uvs[i * 2] ?? 0) : 0;
    out[to + 7] = uvs ? (uvs[i * 2 + 1] ?? 0) : 0;
    out[to + 8] = uvs2 ? (uvs2[i * 2] ?? 0) : 0;
    out[to + 9] = uvs2 ? (uvs2[i * 2 + 1] ?? 0) : 0;
    out[to + 10] = blend ? (blend[i] ?? 0) : 0;
    out[to + 11] = sway ? (sway[i] ?? 0) : 0;
  }
  return out;
}

/** Floats per vertex in the WebGPU buffer: the {@link VERTEX_FLOATS} above, then a tangent(4) (F1c). */
export const TANGENT_VERTEX_FLOATS = VERTEX_FLOATS + 4;

/**
 * The WebGPU renderer's vertices (arrayStride 64): {@link interleaveVertices}'
 * twelve floats, then the vertex's stored MikkTSpace tangent (F1c). A
 * primitive without one per vertex gets zeros, whose w of 0 tells the shader
 * to take its tangent from the UVs' screen derivatives instead.
 */
export function interleaveVerticesWithTangents(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array | null,
  uvs2: Float32Array | null,
  blend: Float32Array | null,
  sway: Float32Array | null,
  tangents: Float32Array | null,
): Float32Array {
  const base = interleaveVertices(positions, normals, uvs, uvs2, blend, sway);
  const count = base.length / VERTEX_FLOATS;
  const own = tangents && tangents.length === count * 4 ? tangents : null;
  const out = new Float32Array(count * TANGENT_VERTEX_FLOATS);
  for (let i = 0; i < count; i += 1) {
    out.set(base.subarray(i * VERTEX_FLOATS, (i + 1) * VERTEX_FLOATS), i * TANGENT_VERTEX_FLOATS);
    if (own) out.set(own.subarray(i * 4, i * 4 + 4), i * TANGENT_VERTEX_FLOATS + VERTEX_FLOATS);
  }
  return out;
}

/**
 * Strip WebGPU's row padding from a mapped readback.
 *
 * `copyTextureToBuffer` writes each row at a 256-byte stride, so a 240-wide
 * frame arrives with 1024 bytes per row carrying 960 of image. Copying it
 * blindly shears the picture diagonally. `reuse` avoids allocating a fresh
 * frame buffer every readback.
 */
export function unpadRows(
  padded: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  reuse: Uint8Array | null = null,
): Uint8Array {
  const rowBytes = width * 4;
  const out = reuse && reuse.length === rowBytes * height ? reuse : new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
  }
  return out;
}
