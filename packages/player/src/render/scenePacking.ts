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

import type { Mat4 } from "@cartbox/editor";

/**
 * WGSL uniform layout, in bytes:
 *
 * ```
 *   0  mvp    mat4x4<f32>   64
 *  64  nrm    mat3x3<f32>   48   (three vec3 columns, each padded to 16)
 * 112  base   vec4<f32>     16
 * 128  light  vec4<f32>     16   xyz = direction, w = ambient
 * 144  flags  vec4<f32>     16   x = 1 when a texture is bound
 * ```
 *
 * 160 bytes used, padded to the 256-byte minimum alignment a dynamic uniform
 * offset requires, so one buffer holds every draw in a frame.
 */
export const UNIFORM_STRIDE = 256;
/**
 * Bytes the struct actually occupies, before the stride padding. This is what a
 * bind group layout's `minBindingSize` must be: it makes a WGSL struct that
 * grows past what this module writes fail at pipeline creation.
 */
export const UNIFORM_BYTES_USED = 160;
/** The same stride counted in float32s, which is how `writeBuffer` sizes it. */
export const UNIFORM_FLOATS = UNIFORM_STRIDE / 4;

/** Float indices of each field within one stride. */
const OFFSET_MVP = 0;
const OFFSET_NRM = 16;
const OFFSET_BASE = 28;
const OFFSET_LIGHT = 32;
const OFFSET_FLAGS = 36;

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

export interface InstanceUniform {
  readonly mvp: Mat4;
  /** Column-major 3x3 from {@link normalBasis3x3}. */
  readonly normalBasis: readonly number[];
  readonly baseColor: readonly [number, number, number, number];
  readonly hasTexture: boolean;
  /** This frame's light, from {@link resolveLight}. */
  readonly light: ResolvedLight;
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

  target[base + OFFSET_FLAGS] = uniform.hasTexture ? 1 : 0;
  target[base + OFFSET_FLAGS + 1] = 0;
  target[base + OFFSET_FLAGS + 2] = 0;
  target[base + OFFSET_FLAGS + 3] = 0;
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
