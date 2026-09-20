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

import type { EnvironmentLight, Mat4 } from "@cartbox/editor";

/**
 * WGSL uniform layout, in bytes:
 *
 * ```
 *   0  mvp        mat4x4<f32>  64
 *  64  nrm        mat3x3<f32>  48   (three vec3 columns, each padded to 16)
 * 112  base       vec4<f32>    16
 * 128  light      vec4<f32>    16   xyz = direction, w = ambient
 * 144  view       vec4<f32>    16   xyz = direction towards the viewer (Modern PBR)
 * 160  pbr        vec4<f32>    16   x = metallic, y = roughness, z = 1 when PBR
 * 176  emissive   vec4<f32>    16   xyz = emissive factor
 * 192  texflags   vec4<f32>    16   x = base, y = mr, z = occlusion, w = emissive
 * 208  envSky     vec4<f32>    16   xyz = sky colour, w = 1 when an environment is set
 * 224  envHorizon vec4<f32>    16   xyz = horizon colour, w = intensity
 * 240  envGround  vec4<f32>    16   xyz = ground colour
 * 256  lightMvp   mat4x4<f32>  64   world→light-clip for this draw (shadow mapping)
 * 320  shadow     vec4<f32>    16   x = 1 when shadowed, y = map size, z = bias, w = strength
 * 336  envMeta    vec4<f32>    16   xyz = env-map mean radiance, w = 1 when an env map is bound
 * 352  tonemap    vec4<f32>    16   x = 1 when tone-mapping, y = exposure
 * ```
 *
 * 368 bytes used, padded to a 512-byte stride (the next 256-byte multiple a
 * dynamic uniform offset can address), so one buffer still holds every draw in a
 * frame. The metallic-roughness inputs and the environment carry the Modern
 * (AAA) tier's shading; a fantasy draw leaves `pbr.z` at 0 and the shader takes
 * the byte-identical Lambert path, `envSky.w` at 0 falls back to flat ambient,
 * `envMeta.w` at 0 uses the analytic gradient instead of a panorama, and
 * `shadow.x` at 0 skips the shadow test.
 */
export const UNIFORM_STRIDE = 512;
/**
 * Bytes the struct actually occupies, before the stride padding. This is what a
 * bind group layout's `minBindingSize` must be: it makes a WGSL struct that
 * grows past what this module writes fail at pipeline creation.
 */
export const UNIFORM_BYTES_USED = 368;
/** The same stride counted in float32s, which is how `writeBuffer` sizes it. */
export const UNIFORM_FLOATS = UNIFORM_STRIDE / 4;

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
    (emissiveFactor !== undefined && (emissiveFactor[0]! > 0 || emissiveFactor[1]! > 0 || emissiveFactor[2]! > 0));
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
  readonly shadow: { readonly size: number; readonly bias: number; readonly strength: number } | null;
  /** HDR tone-map exposure, or null to write the shaded colour straight through. */
  readonly tonemap: { readonly exposure: number } | null;
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
  target[base + OFFSET_VIEW + 3] = 0;

  target[base + OFFSET_PBR] = uniform.pbr.metallic;
  target[base + OFFSET_PBR + 1] = uniform.pbr.roughness;
  target[base + OFFSET_PBR + 2] = uniform.pbr.isPbr ? 1 : 0;
  target[base + OFFSET_PBR + 3] = 0;

  target[base + OFFSET_EMISSIVE] = uniform.pbr.emissive[0]!;
  target[base + OFFSET_EMISSIVE + 1] = uniform.pbr.emissive[1]!;
  target[base + OFFSET_EMISSIVE + 2] = uniform.pbr.emissive[2]!;
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
  target[base + OFFSET_TONEMAP + 2] = 0;
  target[base + OFFSET_TONEMAP + 3] = 0;
}

/** Floats per vertex in the interleaved buffer: position(3) + normal(3) + uv(2). */
export const VERTEX_FLOATS = 8;

/**
 * Interleave the separate attribute streams into the single buffer the pipeline
 * declares (arrayStride 32). A primitive with no UVs gets zeros, which is what
 * the software path effectively uses — and the shader ignores them anyway
 * because its texture flag is off.
 */
export function interleaveVertices(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array | null,
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
