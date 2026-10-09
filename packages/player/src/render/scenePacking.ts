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

import {
  DEFAULT_DETAIL_SCALE,
  DEFAULT_DETAIL_STRENGTH,
  EFFECT_RIM_POWER,
  MAX_FOG_VOLUMES,
  MAX_REFLECTION_PROBES,
  NO_LAYERS,
  effectActive,
  emissiveAnimation,
  materialHasLayers,
  materialRefracts,
  spotCone,
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
 *                                    z = soft-edge distance (EP6b; 0 = hard)
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
 * ```
 *
 * 848 bytes used, padded to a 1024-byte stride (a 256-byte multiple a dynamic
 * uniform offset can address), so one buffer still holds every draw in a
 * frame — uniforms are written per batch, not per copy, so the stride costs
 * little. The metallic-roughness inputs and the environment carry the Modern
 * (AAA) tier's shading; a fantasy draw leaves `pbr.z` at 0 and the shader takes
 * the byte-identical Lambert path, `envSky.w` at 0 falls back to flat ambient,
 * `envMeta.w` at 0 uses the analytic gradient instead of a panorama, and
 * `shadow.x` at 0 skips the shadow test.
 */
export const UNIFORM_STRIDE = 1024;
/**
 * Bytes the struct actually occupies, before the stride padding. This is what a
 * bind group layout's `minBindingSize` must be: it makes a WGSL struct that
 * grows past what this module writes fail at pipeline creation.
 */
export const UNIFORM_BYTES_USED = 848;
/** The same stride counted in float32s, which is how `writeBuffer` sizes it. */
export const UNIFORM_FLOATS = UNIFORM_STRIDE / 4;

/**
 * Floats per light in the storage buffer: four vec4s —
 *   d0: xyz = direction (directional) or world position (point, spot), w = kind (0 directional, 1 point, 2 spot)
 *   d1: rgb = colour, w = intensity
 *   d2: x = range (0 = no falloff), y = spot cone's outer cosine, z = its inner cosine,
 *       w = first shadow tile (EP8c), −1 when it casts none
 *   d3: xyz = spot beam axis (unit, the way it points)
 * Matches the `Light` struct in the WGSL and GLSL scene shaders.
 */
export const LIGHT_FLOATS = 16;

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
  readonly kind: "directional" | "point" | "spot";
  readonly direction?: readonly [number, number, number];
  readonly position?: readonly [number, number, number];
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly range?: number;
  readonly innerAngle?: number;
  readonly outerAngle?: number;
  readonly shadowTile?: number;
}

/**
 * Pack a light list into the storage-buffer layout the WGSL loop reads. Always
 * returns at least one (zeroed) light so the binding is never empty; the draw's
 * `lightCount` uniform, not the buffer length, bounds the loop.
 */
export function packLights(lights: readonly PackableLight[]): Float32Array {
  const out = new Float32Array(Math.max(1, lights.length) * LIGHT_FLOATS);
  lights.forEach((light, i) => {
    const base = i * LIGHT_FLOATS;
    const placed = light.kind !== "directional";
    const v = placed ? light.position ?? [0, 0, 0] : light.direction ?? [0, 1, 0];
    out[base] = v[0]!;
    out[base + 1] = v[1]!;
    out[base + 2] = v[2]!;
    out[base + 3] = light.kind === "spot" ? 2 : placed ? 1 : 0;
    out[base + 4] = light.color[0]!;
    out[base + 5] = light.color[1]!;
    out[base + 6] = light.color[2]!;
    out[base + 7] = light.intensity;
    out[base + 8] = light.range ?? 0;
    out[base + 11] = light.shadowTile ?? -1;
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
    materialRefracts(material);
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
  } | null;
  /** HDR tone-map exposure, or null to write the shaded colour straight through. */
  readonly tonemap: { readonly exposure: number } | null;
  /** Whether a screen-space AO buffer is bound (sampled per fragment on the GPU). */
  readonly hasSsao: boolean;
  /** A baked light map is bound (it scales the ambient/IBL term, PBR draws only). */
  readonly hasLightmap?: boolean;
  /** This draw's world matrix, for point-light world position in the shader. */
  readonly model: Mat4 | null;
  /** Number of lights in the shared storage buffer, or 0 for the single key light. */
  readonly lightCount: number;
  /** This draw's surface effects, or omitted for none. */
  readonly surface?: ResolvedSurface;
  /** This draw's clearcoat, anisotropy and relief (I4; see materialLayers.ts in @cartbox/editor), or omitted for none. */
  readonly layers?: ResolvedLayers;
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
  target[base + OFFSET_TONEMAP + 3] = 0;

  target[base + OFFSET_SSAO] = uniform.hasSsao ? 1 : 0;
  target[base + OFFSET_SSAO + 1] = uniform.lightCount; // light count for the storage-buffer loop
  target[base + OFFSET_SSAO + 2] = uniform.hasLightmap ? 1 : 0;
  target[base + OFFSET_SSAO + 3] = env?.probes ? Math.min(env.probes.probes.length, MAX_REFLECTION_PROBES) : 0;

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
  target[base + OFFSET_SHADOW2 + 1] = shadow && shadow.pcf ? 1 : 0;
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
}

/** The camera's right and up in world space (the view's first two rows) and the frame's height, for refraction (I5). */
export function refractionCamera(view: Mat4, height: number): NonNullable<InstanceUniform["camera"]> {
  return { right: [view[0]!, view[4]!, view[8]!], up: [view[1]!, view[5]!, view[9]!], height };
}

/** Floats per vertex in the interleaved buffer: position(3) + normal(3) + uv(2) + light-map uv(2) + blend weight(1). */
export const VERTEX_FLOATS = 11;

/**
 * Interleave the separate attribute streams into the single buffer the pipeline
 * declares (arrayStride 44). A primitive with no UVs (or no light-map UVs, or no blend weights) gets
 * zeros, which is what the software path effectively uses — and the shader
 * ignores them anyway because the matching texture flag is off.
 */
export function interleaveVertices(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array | null,
  uvs2: Float32Array | null = null,
  blend: Float32Array | null = null,
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
