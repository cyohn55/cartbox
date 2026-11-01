/**
 * The path-traced reference (AAA_FIDELITY_ROADMAP.md F10b): a progressive
 * WebGPU compute path tracer over the scene's BVH, with the materials and
 * lights the linear-light (AAA) renderer shades with. It is the ground truth
 * the raster's parity tests, the look-dev stage and the bakes are held to.
 *
 * - **The scene** is the lightmapper's own triangle BVH (`buildBvh`, packed by
 *   `packBvhNodes`, F3d), with what a camera path needs on top: each
 *   triangle's corner normals and UVs, and its material.
 * - **The materials** are the renderer's: base colour, metal/roughness and
 *   emissive factors times their maps (read from one texel store, filtered by
 *   hand, at the renderer's (u, 1 − v)), authored colour into linear light as
 *   the shader's `toLinear` takes it, and cut-outs and blended surfaces
 *   (stochastically, by their alpha) letting rays through.
 * - **The BRDF** is the AAA shader's (brdf.ts, F1c), term for term: GGX with
 *   the height-correlated Smith visibility, Schlick's Fresnel, the
 *   Kulla-Conty compensation on the specular, and a diffuse of
 *   `(1 − metal)(1 − F)·albedo`. In the renderer's units a light of radiance
 *   `c` gives `f·π·c·N·L` (its diffuse is albedo, not albedo / π), and so
 *   does each light here; the sky and emissive surfaces are radiance as they
 *   are.
 * - **Each path** leaves the eye through a jittered point of its pixel. At
 *   every surface it gathers the surface's emission, every directional light
 *   and one point, spot or area light (picked as the lightmapper picks them),
 *   each through a shadow ray, then bounces by one sample of the BRDF (the
 *   specular by its visible normals, Heitz 2018, or the diffuse by the
 *   cosine), weighed by the two lobes' mixed density. Russian roulette ends it
 *   after the third bounce. A miss sees the sky: the environment's panorama
 *   (F3a), or without one the flat ambient as a uniform sky, as the shader's
 *   fill is.
 * - **Accumulation.** The sums of every sample a pixel has taken stay in a
 *   storage buffer while the view and scene hold; each frame adds samples and
 *   a resolve pass writes the mean to a half-float texture the presenter
 *   shows (premultiplied, alpha 0 where the eye saw nothing, as the raster's).
 * - **The random numbers** are seeded by the pixel's place in the whole
 *   image and the sample's index, so a capture in tiles is the same image as
 *   one in a piece.
 *
 * {@link captureReference} renders it at any size up to 8K, a tile at a time,
 * for marketing shots and the roadmap's reference images.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { buildBvh, cameraPositionFromView, resolveExtensions, multiplyMat4, type DecodedTexture, type EnvironmentLight, type Mat4, type MeshSceneInstance, type SceneLight } from "@cartbox/editor";

import { brdfLut, brdfWgsl } from "./brdf.js";
import { MATERIAL_SET_FUNCTIONS_WGSL } from "./materialSet.js";
import { BAKE_SAMPLING_WGSL, LIGHTMAP_MAX_BOUNCES, bakeLights, packBakeLights, packBvhNodes } from "./gpuLightmapper.js";
import { environmentKey, environmentPanorama, type LinearPanorama } from "./ibl.js";
import { resolveLight, resolvePbr } from "./scenePacking.js";
import { invertMat4 } from "./temporal.js";
import { srgbEncode, toneMap, type ToneMapper } from "./toneMappers.js";

/** Bounces after the surface the eye sees, by default. */
export const REFERENCE_BOUNCES = 4;
/** The longest side a map keeps in the texel store; a larger one is box-filtered down (a reference needs its look, not its last texel). */
export const REFERENCE_TEXTURE_SIDE = 1024;
/** The largest capture, each side (8K). */
export const MAX_CAPTURE_SIDE = 8192;
/** A material's record: four vec4s (see {@link packReferenceScene}). */
const MAT_VEC4S = 11;
/** A triangle's record: its corner and edges, then its corner attributes; seven vec4s. */
const PRIM_VEC4S = 7;
const ATTR_VEC4S = 4;
const WORKGROUP = 8;
const PARAMS_BYTES = 176;
/** Paths a submit traces at most while capturing, so none nears a GPU's watchdog. */
const CAPTURE_PATHS_PER_SUBMIT = 1 << 20;

const STORAGE = 0x80;
const COPY_DST = 0x08;
const COPY_SRC = 0x04;
const MAP_READ = 0x01;
const UNIFORM = 0x40;
const TEXTURE_BINDING = 0x04;
const STORAGE_BINDING = 0x08;
const TEXTURE_COPY_SRC = 0x01;

/** Alpha modes as a material record's second w reads them. */
const ALPHA_MODE = { opaque: 0, mask: 1, blend: 2, additive: 3 } as const;

/** The scene as the path tracer reads it. */
export interface ReferenceScene {
  /** The BVH's nodes ({@link packBvhNodes}). */
  readonly nodes: Uint32Array;
  /**
   * Per triangle seven vec4s:
   * - a corner and its two edges (as the lightmapper's);
   * - the corners' normals (zero without one) with the UVs threaded through
   *   their w's, and the last's w the material's index (u32 bits):
   *   (n0, u0), (n1, v0), (n2, u1), (v1, u2, v2, material).
   */
  readonly prims: Float32Array;
  /**
   * Per material eleven vec4s:
   * - its base colour factor, as authored (RGBA);
   * - its emissive factor, as authored, and its alpha mode (0 opaque, 1 mask, 2 blend, 3 additive);
   * - metalness, roughness, and its base-colour and metal/roughness maps (−1 none);
   * - its emissive map, whether it shades as PBR, its alpha cutoff, and the lighting channels it is on;
   * - the full material set (F1d; {@link extensionRows}): sheen; a dielectric's f0 and transmission; the
   *   volume's thickness and attenuation distance, and the film's strength and IOR; the attenuation colour
   *   and the film's thickness; the UV transform; its offset, the emissive strength and whether it has one;
   *   a thin surface's transmission colour and share (F1d-2).
   *
   * Then per map, from vec4 {@link mapTable}, one vec4 of u32 bits: its first texel in {@link texels}, its width and height.
   */
  readonly mats: Float32Array;
  readonly mapTable: number;
  /** Every map's texels, RGBA8 a word. */
  readonly texels: Uint32Array;
  readonly triangles: number;
  readonly materials: number;
}

/** A key that changes when the instances, their meshes, transforms or maps do (numbers hashed, objects by identity). */
export function referenceSceneKey(instances: readonly MeshSceneInstance[]): string {
  let h = 2166136261 >>> 0;
  const mix = (v: number) => {
    h = Math.imul(h ^ (v | 0), 16777619) >>> 0;
  };
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  for (const instance of instances) {
    mix(objectId(instance.mesh));
    for (const p of instance.mesh.primitives) mix(objectId(p.positions));
    for (const list of [instance.textures, instance.mrTextures, instance.emissiveTextures]) for (const t of list ?? []) mix(t ? objectId(t) : 0);
    for (const v of instance.model) {
      f[0] = v;
      mix(u[0]!);
    }
    mix(instance.lightChannels ?? 1);
  }
  return `${instances.length}:${h.toString(36)}`;
}

const ids = new WeakMap<object, number>();
let nextId = 1;
function objectId(o: object): number {
  let id = ids.get(o);
  if (id === undefined) {
    id = nextId++;
    ids.set(o, id);
  }
  return id;
}

/** A map's texels as the store keeps them: at most {@link REFERENCE_TEXTURE_SIDE} a side, box-filtered down by halves. */
function storedTexels(texture: DecodedTexture): { width: number; height: number; data: Uint8ClampedArray } {
  let { width, height, data } = texture;
  while (width > REFERENCE_TEXTURE_SIDE || height > REFERENCE_TEXTURE_SIDE) {
    const w = Math.max(1, width >> 1);
    const h = Math.max(1, height >> 1);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        for (let c = 0; c < 4; c += 1) {
          let sum = 0;
          let n = 0;
          for (let dy = 0; dy < 2; dy += 1) {
            for (let dx = 0; dx < 2; dx += 1) {
              const sx = Math.min(width - 1, x * 2 + dx);
              const sy = Math.min(height - 1, y * 2 + dy);
              sum += data[(sy * width + sx) * 4 + c] ?? 255;
              n += 1;
            }
          }
          out[(y * w + x) * 4 + c] = sum / n;
        }
      }
    }
    width = w;
    height = h;
    data = out;
  }
  return { width, height, data };
}

/** A model's normal matrix (its 3×3's cofactors, which are det × the inverse transpose, signed so a mirror keeps facing out). */
function normalMatrix(m: Mat4): number[] {
  const a = m[0]!, b = m[1]!, c = m[2]!, d = m[4]!, e = m[5]!, f = m[6]!, g = m[8]!, h = m[9]!, i = m[10]!;
  const co = [e * i - f * h, f * g - d * i, d * h - e * g, c * h - b * i, a * i - c * g, b * g - a * h, b * f - c * e, c * d - a * f, a * e - b * d];
  const det = a * co[0]! + b * co[1]! + c * co[2]!;
  const s = det < 0 ? -1 : 1;
  return co.map((v) => v * s);
}

/** A material's full set (F1d) as its record's last seven vec4s; the defaults off the PBR path. */
function extensionRows(m: MeshSceneInstance["mesh"]["primitives"][number]["material"], pbr: boolean): number[] {
  const e = resolveExtensions(pbr ? m : { name: m.name, baseColorFactor: m.baseColorFactor, baseColorImage: null });
  const t = e.uvTransform;
  return [
    ...e.sheenColor,
    e.sheenRoughness,
    ...e.dielectricF0,
    e.transmission,
    e.thickness,
    e.attenuationDistance,
    e.iridescence,
    e.iridescenceIor,
    ...e.attenuationColor,
    e.iridescenceThickness,
    ...(t ? [t.scale[0], t.scale[1], Math.cos(t.rotation), Math.sin(t.rotation)] : [1, 1, 1, 0]),
    ...(t ? [t.offset[0], t.offset[1]] : [0, 0]),
    // The emissive strength applies with or without the PBR path (an emissive factor puts a material on it anyway).
    resolveExtensions(m).emissiveStrength,
    t ? 1 : 0,
    ...e.diffuseTransmissionColor,
    e.diffuseTransmission,
  ];
}

/**
 * The instances as the path tracer reads them; see {@link ReferenceScene}.
 * Its triangles are in `buildBvh`'s order, so they line up with its nodes.
 */
export function packReferenceScene(instances: readonly MeshSceneInstance[]): ReferenceScene {
  const occluders = instances.map((i) => ({ mesh: i.mesh, model: i.model, lightChannels: i.lightChannels ?? 1 }));
  const bvh = buildBvh(occluders);
  const triangles = bvh.order.length;

  // Maps and materials, each stored once.
  const textureIndex = new Map<DecodedTexture, number>();
  const textureList: { width: number; height: number; data: Uint8ClampedArray }[] = [];
  const texture = (t: DecodedTexture | null | undefined): number => {
    if (!t || t.width <= 0 || t.height <= 0 || t.data.length < t.width * t.height * 4) return -1;
    let index = textureIndex.get(t);
    if (index === undefined) {
      index = textureList.length;
      textureIndex.set(t, index);
      textureList.push(storedTexels(t));
    }
    return index;
  };
  const materialIndex = new Map<string, number>();
  const materialRows: number[][] = [];

  // Per triangle, in the order buildBvh meets them: its corners' normals and UVs, and its material.
  const attrsIn = new Float32Array(Math.max(1, triangles) * ATTR_VEC4S * 4);
  const matOf = new Uint32Array(Math.max(1, triangles));
  let t = 0;
  for (const instance of instances) {
    const nm = normalMatrix(instance.model);
    instance.mesh.primitives.forEach((p, pi) => {
      const m = p.material;
      const base = texture(instance.textures?.[pi]);
      const mr = texture(instance.mrTextures?.[pi]);
      const emis = texture(instance.emissiveTextures?.[pi]);
      const pbr = resolvePbr(m, mr >= 0, Boolean(instance.occlusionTextures?.[pi]), emis >= 0);
      const mode = ALPHA_MODE[m.alphaMode ?? "opaque"] ?? 0;
      const row = [
        ...m.baseColorFactor,
        ...(pbr.emissive as readonly number[]),
        mode,
        pbr.isPbr ? pbr.metallic : 0,
        pbr.isPbr ? pbr.roughness : 1,
        base,
        pbr.isPbr ? mr : -1,
        emis,
        pbr.isPbr ? 1 : 0,
        m.alphaCutoff ?? 0.5,
        instance.lightChannels ?? 1,
        ...extensionRows(m, pbr.isPbr),
      ];
      const key = row.join(",");
      let mat = materialIndex.get(key);
      if (mat === undefined) {
        mat = materialRows.length;
        materialIndex.set(key, mat);
        materialRows.push(row);
      }
      const { normals, uvs, indices } = p;
      for (let k = 0; k < indices.length; k += 3) {
        const o = t * ATTR_VEC4S * 4;
        for (let c = 0; c < 3; c += 1) {
          const v = indices[k + c]!;
          if (normals) {
            const x = normals[v * 3]!, y = normals[v * 3 + 1]!, z = normals[v * 3 + 2]!;
            const nx = nm[0]! * x + nm[3]! * y + nm[6]! * z;
            const ny = nm[1]! * x + nm[4]! * y + nm[7]! * z;
            const nz = nm[2]! * x + nm[5]! * y + nm[8]! * z;
            const len = Math.hypot(nx, ny, nz) || 1;
            attrsIn.set([nx / len, ny / len, nz / len], o + c * 4);
          }
        }
        const uv = (v: number, a: number) => (uvs ? uvs[v * 2 + a]! : 0);
        const [i0, i1, i2] = [indices[k]!, indices[k + 1]!, indices[k + 2]!];
        attrsIn[o + 3] = uv(i0, 0);
        attrsIn[o + 7] = uv(i0, 1);
        attrsIn[o + 11] = uv(i1, 0);
        attrsIn.set([uv(i1, 1), uv(i2, 0), uv(i2, 1)], o + 12);
        matOf[t] = mat;
        t += 1;
      }
    });
  }

  const stride = PRIM_VEC4S * 4;
  const prims = new Float32Array(Math.max(1, triangles) * stride);
  const primBits = new Uint32Array(prims.buffer);
  for (let i = 0; i < triangles; i += 1) {
    const src = bvh.order[i]!;
    const k = src * 9;
    const o = i * stride;
    for (let a = 0; a < 3; a += 1) {
      prims[o + a] = bvh.tri[k + a]!;
      prims[o + 4 + a] = bvh.tri[k + 3 + a]! - bvh.tri[k + a]!;
      prims[o + 8 + a] = bvh.tri[k + 6 + a]! - bvh.tri[k + a]!;
    }
    prims.set(attrsIn.subarray(src * 16, src * 16 + 15), o + 12);
    primBits[o + 27] = matOf[src]!;
  }

  const mapTable = materialRows.length * MAT_VEC4S;
  const mats = new Float32Array(Math.max(1, mapTable + textureList.length) * 4);
  const matBits = new Uint32Array(mats.buffer);
  materialRows.forEach((row, i) => mats.set(row, i * MAT_VEC4S * 4));
  let total = 0;
  textureList.forEach((tex, i) => {
    matBits.set([total, tex.width, tex.height, 0], (mapTable + i) * 4);
    total += tex.width * tex.height;
  });
  const texels = new Uint32Array(Math.max(1, total));
  textureList.forEach((tex, i) => {
    const words = new Uint32Array(tex.data.buffer.slice(tex.data.byteOffset, tex.data.byteOffset + tex.width * tex.height * 4));
    texels.set(words, matBits[(mapTable + i) * 4]!);
  });
  return { nodes: packBvhNodes(bvh), prims, mats, mapTable, texels, triangles, materials: materialRows.length };
}

export const PATH_TRACE_WGSL = /* wgsl */ `
struct Params {
  invViewProj: mat4x4<f32>,
  eye: vec4<f32>,      // xyz = the camera, w = the clamp on what a bounce brings back (0 = none)
  info: vec4<u32>,     // x = bounces, y = directional lights, z = sky width, w = sky height
  image: vec4<u32>,    // x, y = the whole image's size; z, w = this tile's corner in it
  run: vec4<u32>,      // x, y = the tile's size; z = first sample; w = samples this pass
  extra: vec4<u32>,    // x = point, spot and area lights; y = 1 where a miss from the eye shows the sky; z = the map table's first vec4 in mats
  ambient: vec4<f32>,  // rgb = the uniform sky without a panorama (the flat ambient)
  lens: vec4<f32>,     // x = the thin lens's aperture radius (0 = a pinhole), y = the focus distance along the view (F10d)
};
@group(0) @binding(0) var<storage, read> nodes: array<vec4<u32>>;
@group(0) @binding(1) var<storage, read> prims: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> mats: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> texels: array<u32>;
@group(0) @binding(4) var<storage, read> lights: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> sky: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> accum: array<vec4<f32>>;
@group(0) @binding(7) var<uniform> params: Params;
${brdfWgsl(0, 8)}

const PI = 3.14159265;
const EPS = 0.002;
const T_MIN = 1e-4;
const FAR = 1e30;

${BAKE_SAMPLING_WGSL}
${MATERIAL_SET_FUNCTIONS_WGSL}

// A map's texel, wrapped.
fn texFetch(m: vec4<u32>, x: i32, y: i32) -> vec4<f32> {
  let w = i32(m.y);
  let h = i32(m.z);
  let xi = ((x % w) + w) % w;
  let yi = ((y % h) + h) % h;
  return unpack4x8unorm(texels[m.x + u32(yi * w + xi)]);
}
// Map \`tex\` at uv, bilinearly and wrapping, at the renderer's (u, 1 − v); white without one.
fn texSample(tex: f32, uv: vec2<f32>) -> vec4<f32> {
  if (tex < 0.0) { return vec4<f32>(1.0); }
  let m = bitcast<vec4<u32>>(mats[params.extra.z + u32(tex + 0.5)]);
  let p = fract(vec2<f32>(uv.x, 1.0 - uv.y)) * vec2<f32>(f32(m.y), f32(m.z)) - vec2<f32>(0.5);
  let f = floor(p);
  let t = p - f;
  let i = vec2<i32>(f);
  let top = mix(texFetch(m, i.x, i.y), texFetch(m, i.x + 1, i.y), t.x);
  let bottom = mix(texFetch(m, i.x, i.y + 1), texFetch(m, i.x + 1, i.y + 1), t.x);
  return mix(top, bottom, t.y);
}

fn tri(i: u32, k: u32) -> vec4<f32> {
  return prims[i * ${PRIM_VEC4S}u + k];
}
fn attr(i: u32, k: u32) -> vec4<f32> {
  return prims[i * ${PRIM_VEC4S}u + 3u + k];
}
fn matOf(i: u32) -> u32 {
  return bitcast<u32>(attr(i, 3u).w);
}
fn mat(m: u32, k: u32) -> vec4<f32> {
  return mats[m * ${MAT_VEC4S}u + k];
}
fn uvAt(i: u32, b: vec2<f32>) -> vec2<f32> {
  let uv0 = vec2<f32>(attr(i, 0u).w, attr(i, 1u).w);
  let uv1 = vec2<f32>(attr(i, 2u).w, attr(i, 3u).x);
  let uv2 = attr(i, 3u).yz;
  let uv = uv0 * (1.0 - b.x - b.y) + uv1 * b.x + uv2 * b.y;
  // The material's UV transform (F1d).
  let m = matOf(i);
  if (mat(m, 9u).w < 0.5) { return uv; }
  return khrTransform(uv, mat(m, 8u), mat(m, 9u).xy);
}

// Whether a ray stops at triangle i at barycentrics b: an opaque surface always; a cut-out where its
// alpha reaches the cutoff; a blended one as often as its alpha; an additive one never. A shadow ray
// passes a transmitting surface (F1d) as often as it lets light through.
fn stops(i: u32, b: vec2<f32>, shadow: bool) -> bool {
  let m = matOf(i);
  let mode = mat(m, 1u).w;
  if (shadow && mat(m, 5u).w > 0.0 && rand() < mat(m, 5u).w * (1.0 - mat(m, 2u).x)) { return false; }
  if (mode < 0.5) { return true; }
  if (mode > 2.5) { return false; }
  let a = mat(m, 0u).a * texSample(mat(m, 2u).z, uvAt(i, b)).a;
  if (mode < 1.5) { return a >= mat(m, 3u).z; }
  return rand() < a;
}

struct Hit {
  t: f32,
  tri: i32,
  b: vec2<f32>,
};

// The closest surface along o + t·d within tMax that stops it (or, with anyHit, the first found).
fn trace(o: vec3<f32>, d: vec3<f32>, tMax: f32, anyHit: bool) -> Hit {
  var best = Hit(tMax, -1, vec2<f32>(0.0));
  let tiny = abs(d) < vec3<f32>(1e-9);
  let inv = 1.0 / select(d, select(vec3<f32>(-1e-9), vec3<f32>(1e-9), d >= vec3<f32>(0.0)), tiny);
  var stack: array<u32, 64>;
  var sp = 1u;
  stack[0] = 0u;
  loop {
    if (sp == 0u) { break; }
    sp = sp - 1u;
    let n = stack[sp];
    let a = nodes[n * 2u];
    let bb = nodes[n * 2u + 1u];
    let t0 = (bitcast<vec3<f32>>(a.xyz) - o) * inv;
    let t1 = (bitcast<vec3<f32>>(bb.xyz) - o) * inv;
    let lo = min(t0, t1);
    let hi = max(t0, t1);
    let tn = max(max(lo.x, lo.y), max(lo.z, 0.0));
    let tf = min(min(hi.x, hi.y), min(hi.z, best.t));
    if (tn > tf) { continue; }
    let left = bitcast<i32>(a.w);
    if (left >= 0) {
      if (sp + 2u <= 64u) {
        stack[sp] = u32(left);
        stack[sp + 1u] = bb.w;
        sp = sp + 2u;
      }
      continue;
    }
    let first = bb.w;
    let count = u32(-1 - left);
    for (var i = first; i < first + count; i = i + 1u) {
      // Möller–Trumbore.
      let v0 = tri(i, 0u).xyz;
      let e1 = tri(i, 1u).xyz;
      let e2 = tri(i, 2u).xyz;
      let p = cross(d, e2);
      let det = dot(e1, p);
      if (abs(det) < 1e-12) { continue; }
      let id = 1.0 / det;
      let s = o - v0;
      let u = dot(s, p) * id;
      if (u < 0.0 || u > 1.0) { continue; }
      let q = cross(s, e1);
      let v = dot(d, q) * id;
      if (v < 0.0 || u + v > 1.0) { continue; }
      let t = dot(e2, q) * id;
      if (t > T_MIN && t < best.t && stops(i, vec2<f32>(u, v), anyHit)) {
        best = Hit(t, i32(i), vec2<f32>(u, v));
        if (anyHit) { return best; }
      }
    }
  }
  return best;
}

fn visible(p: vec3<f32>, d: vec3<f32>, tMax: f32) -> bool {
  return trace(p, d, tMax, true).tri < 0;
}

// The sky along d: the panorama, or the flat ambient as a uniform sky.
fn skyRadiance(d: vec3<f32>) -> vec3<f32> {
  if (params.info.z == 0u) { return params.ambient.rgb; }
  return skyAt(d);
}

fn toLinear(c: vec3<f32>) -> vec3<f32> {
  let v = max(c, vec3<f32>(0.0));
  return select(pow((v + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)), v / 12.92, v <= vec3<f32>(0.04045));
}

struct Surface {
  albedo: vec3<f32>,
  metal: f32,
  rough: f32,
  emission: vec3<f32>,
  pbr: bool,
  channels: u32,
  // The full material set (F1d): a dielectric's f0, sheen, transmission and what the volume lets through,
  // the film, and (set once N·V is known) the reflectance and what the sheen leaves the base.
  f0: vec3<f32>,
  sheen: vec3<f32>,
  sheenRough: f32,
  transmission: f32,
  absorb: vec3<f32>,
  irid: f32,
  iridIor: f32,
  iridThickness: f32,
  sheenScale: f32,
  // A thin surface's transmission (F1d-2): its share and colour.
  dt: f32,
  dtColor: vec3<f32>,
};

fn surfaceAt(i: u32, b: vec2<f32>) -> Surface {
  let m = matOf(i);
  let uv = uvAt(i, b);
  let m2 = mat(m, 2u);
  let m3 = mat(m, 3u);
  let base = mat(m, 0u).rgb * texSample(m2.z, uv).rgb;
  let mr = texSample(m2.w, uv);
  var s: Surface;
  s.albedo = toLinear(base);
  s.metal = clamp(m2.x * mr.b, 0.0, 1.0);
  s.rough = clamp(m2.y * mr.g, 0.045, 1.0);
  s.emission = toLinear(mat(m, 1u).rgb * texSample(m3.x, uv).rgb) * mat(m, 9u).z;
  s.pbr = m3.y > 0.5;
  s.channels = u32(m3.w + 0.5);
  let m4 = mat(m, 4u);
  let m5 = mat(m, 5u);
  let m6 = mat(m, 6u);
  let m7 = mat(m, 7u);
  s.f0 = mix(m5.rgb, s.albedo, s.metal);
  s.sheen = m4.rgb;
  s.sheenRough = m4.w;
  s.transmission = m5.w;
  s.absorb = vec3<f32>(1.0);
  if (m6.x > 0.0 && m6.y > 0.0) { s.absorb = pow(max(m7.rgb, vec3<f32>(1e-4)), vec3<f32>(m6.x / m6.y)); }
  s.irid = m6.z;
  s.iridIor = m6.w;
  s.iridThickness = m7.w;
  s.sheenScale = 1.0;
  let m10 = mat(m, 10u);
  s.dt = select(0.0, m10.w, s.pbr);
  s.dtColor = m10.rgb;
  return s;
}

// The BRDF toward L from V about N, without the cosine: the AAA shader's terms over π for the diffuse
// (its lights' units), and its specular with the Kulla-Conty scale.
fn brdf(s: Surface, N: vec3<f32>, V: vec3<f32>, L: vec3<f32>) -> vec3<f32> {
  let ndl = dot(N, L);
  // From behind, a thin surface's transmission (F1d-2): a diffuse of its own.
  if (ndl < 0.0 && s.dt > 0.0) { return s.dt * s.dtColor * s.albedo * (1.0 - s.metal) * (1.0 - s.transmission) / PI; }
  if (ndl <= 0.0) { return vec3<f32>(0.0); }
  if (!s.pbr) { return s.albedo / PI; }
  let ndv = max(1e-4, dot(N, V));
  let H = normalize(L + V);
  let ndh = max(0.0, dot(N, H));
  let vdh = max(0.0, dot(V, H));
  let a2 = s.rough * s.rough * s.rough * s.rough;
  let dd = ndh * ndh * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dd * dd + 1e-7);
  let f0 = s.f0;
  let F = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - vdh, 5.0);
  let eComp = energyCompensation(f0, dfgAt(ndv, s.rough));
  let diffuse = (1.0 - s.metal) * (1.0 - s.transmission) * (1.0 - s.dt) * (vec3<f32>(1.0) - F) * s.albedo / PI;
  return (diffuse + F * D * smithVisibility(ndl, ndv, a2) * eComp) * s.sheenScale + sheenBrdf(s.sheen, s.sheenRough, ndl, ndv, ndh);
}

// An orthonormal frame about n (Duff et al.): tangent, bitangent, n.
fn frameOf(n: vec3<f32>) -> mat3x3<f32> {
  let sg = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (sg + n.z);
  let b = n.x * n.y * a;
  return mat3x3<f32>(vec3<f32>(1.0 + sg * n.x * n.x * a, sg * b, -sg * n.x), vec3<f32>(b, sg + n.y * n.y * a, -n.y), n);
}

// A GGX normal visible from Ve (in the frame), for alpha = roughness² (Heitz 2018).
fn sampleVndf(Ve: vec3<f32>, alpha: f32, xi: vec2<f32>) -> vec3<f32> {
  let Vh = normalize(vec3<f32>(alpha * Ve.x, alpha * Ve.y, Ve.z));
  let lensq = Vh.x * Vh.x + Vh.y * Vh.y;
  let T1 = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-Vh.y, Vh.x, 0.0) / sqrt(lensq), lensq > 1e-12);
  let T2 = cross(Vh, T1);
  let r = sqrt(xi.x);
  let phi = 2.0 * PI * xi.y;
  let t1 = r * cos(phi);
  let sv = 0.5 * (1.0 + Vh.z);
  let t2 = (1.0 - sv) * sqrt(max(0.0, 1.0 - t1 * t1)) + sv * r * sin(phi);
  let Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * Vh;
  return normalize(vec3<f32>(alpha * Nh.x, alpha * Nh.y, max(0.0, Nh.z)));
}

// How likely a bounce takes the specular lobe: by the two lobes' share of what the surface reflects.
fn specularChance(s: Surface, ndv: f32) -> f32 {
  if (!s.pbr) { return 0.0; }
  let e = specularEnergy(s.f0, dfgAt(ndv, s.rough));
  let ls = lum(e);
  let ld = lum(s.albedo * (1.0 - s.metal) * (1.0 - s.transmission) * (vec3<f32>(1.0) - e) + s.sheen);
  return clamp(ls / max(ls + ld, 1e-6), 0.1, 0.9);
}

// The density of bouncing toward L: the two lobes' mixed.
fn bouncePdf(s: Surface, N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, ps: f32) -> f32 {
  let ndl = dot(N, L);
  if (ndl <= 0.0) { return 0.0; }
  var pdf = (1.0 - ps) * ndl / PI;
  if (ps > 0.0) {
    let ndv = max(1e-4, dot(N, V));
    let H = normalize(L + V);
    let ndh = max(0.0, dot(N, H));
    let alpha = s.rough * s.rough;
    let a2 = alpha * alpha;
    let dd = ndh * ndh * (a2 - 1.0) + 1.0;
    let D = a2 / (PI * dd * dd + 1e-7);
    let g1 = 2.0 * ndv / (ndv + sqrt(a2 + (1.0 - a2) * ndv * ndv));
    pdf = pdf + ps * g1 * D / (4.0 * ndv);
  }
  return pdf;
}

// The direct light on a surface at p facing N, seen from V: every directional light, and one point, spot or
// area light picked by what it would give there (a tenth spread evenly), over the chance of picking it.
fn directLight(s: Surface, p: vec3<f32>, N: vec3<f32>, V: vec3<f32>, pBack: vec3<f32>) -> vec3<f32> {
  var L = vec3<f32>(0.0);
  let directional = params.info.y;
  for (var l = 0u; l < directional; l = l + 1u) {
    if (!lightsMask(l, s.channels)) { continue; }
    let Ld = lightAt(l, 0u).xyz;
    let ndl = dot(N, Ld);
    // A light behind a thin surface (F1d-2) shines through from its far side.
    if (ndl <= 0.0 && !(s.dt > 0.0 && ndl < 0.0)) { continue; }
    let f = brdf(s, N, V, Ld);
    if (max(f.r, max(f.g, f.b)) > 0.0 && visible(select(pBack, p, ndl > 0.0), Ld, FAR)) {
      L = L + f * PI * lightAt(l, 1u).rgb * abs(ndl);
    }
  }
  let local = params.extra.x;
  if (local == 0u) { return L; }
  var total = 0.0;
  for (var k = 0u; k < local; k = k + 1u) { total = total + localWeight(directional + k, p, N, s.channels); }
  let even = select(1.0, 0.1, total > 0.0) / f32(local);
  let spread = select(0.0, 0.9 / total, total > 0.0);
  let u = rand();
  var pick = local - 1u;
  var pdf = 0.0;
  var cdf = 0.0;
  for (var k = 0u; k < local; k = k + 1u) {
    pdf = localWeight(directional + k, p, N, s.channels) * spread + even;
    cdf = cdf + pdf;
    if (u < cdf) { pick = k; break; }
  }
  if (pick == local - 1u) { pdf = localWeight(directional + pick, p, N, s.channels) * spread + even; }
  let l = directional + pick;
  if (!lightsMask(l, s.channels)) { return L; }
  // From behind a thin surface (F1d-2): the same light through its far side.
  if (s.dt > 0.0) {
    let lb = localSample(l, pBack, -N);
    let fb = brdf(s, N, V, lb.dir);
    if (max(lb.c.r, max(lb.c.g, lb.c.b)) > 0.0 && max(fb.r, max(fb.g, fb.b)) > 0.0 && visible(pBack, lb.dir, lb.dist - EPS)) {
      L = L + fb * PI * lb.c / pdf;
    }
  }
  let ls = localSample(l, p, N);
  if (max(ls.c.r, max(ls.c.g, ls.c.b)) <= 0.0) { return L; }
  let f = brdf(s, N, V, ls.dir);
  if (max(f.r, max(f.g, f.b)) > 0.0 && visible(p, ls.dir, ls.dist - EPS)) {
    L = L + f * PI * ls.c / pdf;
  }
  return L;
}

// What a path from the eye along d brings back (rgb), and whether the eye saw anything (a).
fn radiance(origin: vec3<f32>, dir: vec3<f32>) -> vec4<f32> {
  var L = vec3<f32>(0.0);
  var seen = 0.0;
  var tp = vec3<f32>(1.0);
  var o = origin;
  var d = dir;
  let clampTo = params.eye.w;
  for (var b = 0u; b <= params.info.x; b = b + 1u) {
    let h = trace(o, d, FAR, false);
    var add = vec3<f32>(0.0);
    if (h.tri < 0) {
      if (b > 0u) { add = tp * skyRadiance(d); }
      else if (params.extra.y > 0u) { add = skyRadiance(d); seen = 1.0; }
    } else {
      if (b == 0u) { seen = 1.0; }
    }
    if (h.tri < 0) {
      if (clampTo > 0.0 && b > 0u) { add = add * min(1.0, clampTo / max(lum(add), 1e-6)); }
      L = L + add;
      break;
    }
    let i = u32(h.tri);
    var s = surfaceAt(i, h.b);
    let V = -d;
    var ng = normalize(cross(tri(i, 1u).xyz, tri(i, 2u).xyz));
    if (dot(ng, V) < 0.0) { ng = -ng; } // two-sided, as the renderer's surfaces are
    let w = vec3<f32>(1.0 - h.b.x - h.b.y, h.b.x, h.b.y);
    var N = attr(i, 0u).xyz * w.x + attr(i, 1u).xyz * w.y + attr(i, 2u).xyz * w.z;
    if (dot(N, N) < 1e-8) { N = ng; } else { N = normalize(N); }
    if (dot(N, ng) < 0.0) { N = -N; }
    if (dot(N, V) <= 0.0) { N = ng; }
    let p = o + d * h.t + ng * EPS;
    // What depends on N·V (F1d): the film's reflectance, and what the sheen leaves the base.
    let ndv0 = max(1e-4, dot(N, V));
    if (s.pbr && s.irid > 0.0) { s.f0 = mix(s.f0, iridescenceFresnel(ndv0, s.f0, s.iridIor, s.iridThickness), s.irid); }
    if (s.pbr) { s.sheenScale = 1.0 - max(s.sheen.r, max(s.sheen.g, s.sheen.b)) * sheenE(ndv0, s.sheenRough); }
    let pBack = o + d * h.t - ng * EPS;
    add = s.emission + directLight(s, p, N, V, pBack);
    add = tp * add;
    if (clampTo > 0.0 && b > 0u) { add = add * min(1.0, clampTo / max(lum(add), 1e-6)); }
    L = L + add;
    if (b == params.info.x) { break; }
    let ndv = ndv0;
    // Transmission (F1d): as often as the surface lets light through, the path goes on through it, unbent
    // (as the renderer shows what's behind), tinted by the base colour and the volume.
    let pt = select(0.0, min(0.9, s.transmission * (1.0 - s.metal)), s.pbr);
    if (pt > 0.0 && rand() < pt) {
      let e = specularEnergy(s.f0, dfgAt(ndv, s.rough));
      tp = tp * s.transmission * (1.0 - s.metal) * (vec3<f32>(1.0) - e) * s.albedo * s.absorb * s.sheenScale / pt;
      o = o + d * h.t - ng * EPS;
      continue;
    }
    tp = tp / (1.0 - pt);
    // A thin surface's transmission (F1d-2): as often as it lets light through, the bounce goes out its far side.
    let pd = select(0.0, min(0.5, s.dt), s.dt > 0.0);
    if (pd > 0.0 && rand() < pd) {
      let back = cosineDir(-N, vec2<f32>(rand(), rand()));
      // f · |cos| over (pd · |cos| / π).
      tp = tp * brdf(s, N, V, back) * PI / pd;
      o = pBack;
      d = back;
      continue;
    }
    tp = tp / (1.0 - pd);
    // A bounce: the specular by its visible normals, or the diffuse by the cosine.
    let ps = specularChance(s, ndv);
    var next: vec3<f32>;
    if (rand() < ps) {
      let fr = frameOf(N);
      let Ve = transpose(fr) * V;
      let He = sampleVndf(Ve, s.rough * s.rough, vec2<f32>(rand(), rand()));
      next = reflect(-V, fr * He);
    } else {
      next = cosineDir(N, vec2<f32>(rand(), rand()));
    }
    let pdf = bouncePdf(s, N, V, next, ps);
    if (pdf <= 0.0 || dot(next, ng) <= 0.0) { break; }
    tp = tp * brdf(s, N, V, next) * dot(N, next) / pdf;
    if (b >= 2u) {
      let survive = clamp(max(tp.r, max(tp.g, tp.b)), 0.05, 0.95);
      if (rand() > survive) { break; }
      tp = tp / survive;
    }
    if (max(tp.r, max(tp.g, tp.b)) <= 0.0) { break; }
    o = p;
    d = next;
  }
  return vec4<f32>(L, seen);
}

fn unproject(ndc: vec2<f32>) -> vec3<f32> {
  let p = params.invViewProj * vec4<f32>(ndc, 0.5, 1.0);
  return p.xyz / p.w;
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.run.x || id.y >= params.run.y) { return; }
  let px = params.image.z + id.x;
  let py = params.image.w + id.y;
  let size = vec2<f32>(f32(params.image.x), f32(params.image.y));
  let pixel = py * params.image.x + px;
  var sum = vec4<f32>(0.0);
  for (var k = 0u; k < params.run.w; k = k + 1u) {
    let sIndex = params.run.z + k;
    rng = pcg(pixel ^ pcg(sIndex * 0x9e3779b9u + 0x632be5abu));
    let jitter = vec2<f32>(rand(), rand());
    let ndc = vec2<f32>((f32(px) + jitter.x) / size.x * 2.0 - 1.0, 1.0 - (f32(py) + jitter.y) / size.y * 2.0);
    let far = params.invViewProj * vec4<f32>(ndc, 0.5, 1.0);
    var d = normalize(far.xyz / far.w - params.eye.xyz);
    var o = params.eye.xyz;
    if (params.lens.x > 0.0) {
      // A thin lens: rays through a disc of the aperture meet again on the focus plane.
      let forward = normalize(unproject(vec2<f32>(0.0, 0.0)) - o);
      let right = normalize(unproject(vec2<f32>(1.0, 0.0)) - unproject(vec2<f32>(-1.0, 0.0)));
      let up = cross(right, forward);
      let focal = o + d * (params.lens.y / max(1e-4, dot(d, forward)));
      let r = sqrt(rand()) * params.lens.x;
      let a = 6.2831853 * rand();
      o = o + (right * cos(a) + up * sin(a)) * r;
      d = normalize(focal - o);
    }
    sum = sum + radiance(o, d);
  }
  let j = id.y * params.run.x + id.x;
  accum[j] = accum[j] + sum;
}
`;

/** The resolve: each pixel's sums over its samples into the half-float frame. */
export const PATH_RESOLVE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> accum: array<vec4<f32>>;
@group(0) @binding(1) var frame: texture_storage_2d<rgba16float, write>;
@group(0) @binding(2) var<uniform> info: vec4<u32>; // x, y = size, z = samples
@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn resolve(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= info.x || id.y >= info.y) { return; }
  let n = max(1.0, f32(info.z));
  let v = accum[id.y * info.x + id.x] / n;
  textureStore(frame, vec2<i32>(id.xy), vec4<f32>(min(v.rgb, vec3<f32>(60000.0)), v.a));
}
`;

/** What the reference is lit by and seen through: the parts of a draw it reads. */
export interface ReferenceDraw {
  readonly view: Mat4;
  readonly projection: Mat4;
  readonly lightDirection?: readonly [number, number, number];
  readonly ambient?: number;
  readonly environment?: EnvironmentLight | null;
  readonly lights?: readonly SceneLight[] | null;
  /** A thin lens (F10d): its aperture radius and focus distance (m); absent, a pinhole. */
  readonly lens?: { readonly aperture: number; readonly focus: number } | null;
}

export interface ReferenceSettings {
  /** Bounces after the surface the eye sees (0..8, default {@link REFERENCE_BOUNCES}). */
  readonly bounces?: number;
  /** Samples a pixel takes each frame (default 1). */
  readonly samplesPerFrame?: number;
  /** Where a pixel stops taking samples (default 4096). */
  readonly maxSamples?: number;
  /** The most a bounce may bring back, by luminance (0 = no clamp, the default; a viewport may trade bias for fewer fireflies). */
  readonly clamp?: number;
  /** Whether a miss from the eye shows the sky (default false: alpha 0, so the presenter's sky shows, as with the raster). */
  readonly background?: boolean;
}

/** The lights a draw lights by, as the shader takes them: its rig, or the key light as a white directional of 1. */
export function referenceLights(draw: ReferenceDraw) {
  if (draw.lights && draw.lights.length > 0) return packBakeLights(bakeLights(draw.lights));
  const light = resolveLight(draw.lightDirection, draw.ambient);
  return packBakeLights([{ direction: light.direction, radiance: [1, 1, 1] }]);
}

/** The flat ambient as the uniform sky it stands for (the shader's `toLinear(ambient)`). */
export function referenceAmbient(draw: ReferenceDraw): number {
  const a = resolveLight(draw.lightDirection, draw.ambient).ambient;
  return a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4;
}

/** What a dispatch traces besides its tile: the bounces, sky, lights, flat ambient, clamp and background, and the scene's map table. */
export interface TraceSetup {
  readonly bounces: number;
  readonly sky: LinearPanorama | null;
  readonly lights: { readonly directional: number; readonly local: number };
  readonly ambient: number;
  readonly clamp: number;
  readonly background: boolean;
  readonly mapTable: number;
}

/** The tracer's parameters for one dispatch: `samples` from `firstSample` of the tile at (x, y) of the whole image. */
export function pathTraceParams(
  camera: { readonly inv: Mat4; readonly eye: readonly [number, number, number]; readonly lens?: { readonly aperture: number; readonly focus: number } | null },
  image: { readonly width: number; readonly height: number; readonly x: number; readonly y: number; readonly tileWidth: number; readonly tileHeight: number },
  firstSample: number,
  samples: number,
  setup: TraceSetup,
): ArrayBuffer {
  const buffer = new ArrayBuffer(PARAMS_BYTES);
  const f = new Float32Array(buffer);
  const u = new Uint32Array(buffer);
  f.set(camera.inv, 0);
  f.set([...camera.eye, setup.clamp], 16);
  u.set([Math.min(LIGHTMAP_MAX_BOUNCES, Math.max(0, Math.round(setup.bounces))), setup.lights.directional, setup.sky?.width ?? 0, setup.sky?.height ?? 0], 20);
  u.set([image.width, image.height, image.x, image.y], 24);
  u.set([image.tileWidth, image.tileHeight, firstSample, samples], 28);
  u.set([setup.lights.local, setup.background ? 1 : 0, setup.mapTable, 0], 32);
  f.set([setup.ambient, setup.ambient, setup.ambient, 0], 36);
  if (camera.lens && camera.lens.aperture > 0) f.set([camera.lens.aperture, Math.max(0.01, camera.lens.focus), 0, 0], 40);
  return buffer;
}

/** The scene's buffers and the pipelines, on one device. */
class TracerCore {
  private pipeline: any = null;
  private resolvePipeline: any = null;
  private readonly dfg: any;
  private scene: { key: string; buffers: any[]; mapTable: number } | null = null;
  private skyFor: { key: unknown[] | null; buffer: any; panorama: LinearPanorama | null } = { key: null, buffer: null, panorama: null };
  lightBuffer: any = null;

  constructor(readonly device: any) {
    const table = brdfLut();
    this.dfg = device.createBuffer({ size: table.byteLength, usage: STORAGE | COPY_DST });
    device.queue.writeBuffer(this.dfg, 0, table);
  }

  get tracePipeline(): any {
    this.pipeline ??= this.device.createComputePipeline({ layout: "auto", compute: { module: this.device.createShaderModule({ code: PATH_TRACE_WGSL }), entryPoint: "main" } });
    return this.pipeline;
  }

  get resolver(): any {
    this.resolvePipeline ??= this.device.createComputePipeline({ layout: "auto", compute: { module: this.device.createShaderModule({ code: PATH_RESOLVE_WGSL }), entryPoint: "resolve" } });
    return this.resolvePipeline;
  }

  private storage(data: ArrayBufferView): any {
    const buffer = this.device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 16) * 16), usage: STORAGE | COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
    return buffer;
  }

  /** The scene's buffers for `instances`, packed again only when its key changes. Returns whether it did. */
  setScene(instances: readonly MeshSceneInstance[], key = referenceSceneKey(instances)): boolean {
    if (this.scene?.key === key) return false;
    for (const b of this.scene?.buffers ?? []) b.destroy();
    const packed = packReferenceScene(instances);
    this.scene = { key, buffers: [packed.nodes, packed.prims, packed.mats, packed.texels].map((d) => this.storage(d)), mapTable: packed.mapTable };
    return true;
  }

  get mapTable(): number {
    return this.scene?.mapTable ?? 0;
  }

  /** The sky's panorama for `environment` (null: the flat ambient), uploaded once per environment. */
  setSky(environment: EnvironmentLight | null | undefined): LinearPanorama | null {
    const key = environment ? environmentKey(environment) : null;
    const same = (a: unknown[] | null, b: unknown[] | null) => (a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => v === b[i]));
    if (this.skyFor.buffer && same(this.skyFor.key, key)) return this.skyFor.panorama;
    this.skyFor.buffer?.destroy();
    const panorama = environment ? environmentPanorama(environment) : null;
    this.skyFor = { key, panorama, buffer: this.storage(panorama?.data ?? new Float32Array(4)) };
    return panorama;
  }

  setLights(data: Float32Array): void {
    this.lightBuffer?.destroy();
    this.lightBuffer = this.storage(data);
  }

  /** The trace's bind group against `accum` and `params`. */
  traceGroup(accum: any, params: any): any {
    const [nodes, prims, mats, texels] = this.scene!.buffers;
    const buffers = [nodes, prims, mats, texels, this.lightBuffer, this.skyFor.buffer, accum, params, this.dfg];
    return this.device.createBindGroup({ layout: this.tracePipeline.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
  }

  destroy(): void {
    for (const b of this.scene?.buffers ?? []) b.destroy();
    this.skyFor.buffer?.destroy();
    this.lightBuffer?.destroy();
    this.dfg.destroy();
    this.scene = null;
  }
}

/** A draw's camera: its inverse view-projection, eye and lens. */
function cameraOf(draw: ReferenceDraw): { inv: Mat4; eye: [number, number, number]; lens: ReferenceDraw["lens"] } {
  const inv = invertMat4(multiplyMat4(draw.projection, draw.view)) ?? (new Array(16).fill(0) as unknown as Mat4);
  return { inv, eye: cameraPositionFromView(draw.view), lens: draw.lens ?? null };
}

/** A key for what the image depends on besides the scene: the camera, the lights and the sky. */
function drawKey(draw: ReferenceDraw, width: number, height: number, settings: ReferenceSettings): string {
  const env = draw.environment ? environmentKey(draw.environment).map((v) => (typeof v === "object" && v !== null ? objectId(v) : v)) : null;
  return JSON.stringify([width, height, draw.view, draw.projection, draw.lightDirection ?? null, draw.ambient ?? null, draw.lights ?? null, draw.lens ?? null, env, settings.bounces ?? REFERENCE_BOUNCES, settings.clamp ?? 0, settings.background ?? false]);
}

/**
 * The progressive reference for a viewport (F10b): each {@link render} adds
 * samples to every pixel while the scene, camera, lights and sky hold, and
 * starts again when any changes.
 */
export class PathTracer {
  private readonly core: TracerCore;
  private accum: any = null;
  private frame: any = null;
  private readonly params: any;
  private readonly resolveInfo: any;
  private size = { width: 0, height: 0 };
  private key = "";
  /** Samples each pixel holds. */
  samples = 0;

  private constructor(readonly device: any) {
    this.core = new TracerCore(device);
    this.params = device.createBuffer({ size: PARAMS_BYTES, usage: UNIFORM | COPY_DST });
    this.resolveInfo = device.createBuffer({ size: 16, usage: UNIFORM | COPY_DST });
  }

  static create(device: any): PathTracer {
    return new PathTracer(device);
  }

  /** Start accumulating again. */
  reset(): void {
    this.samples = 0;
    this.key = "";
  }

  private ensureTargets(width: number, height: number): void {
    if (this.size.width === width && this.size.height === height && this.accum) return;
    this.accum?.destroy();
    this.frame?.destroy();
    this.accum = this.device.createBuffer({ size: width * height * 16, usage: STORAGE | COPY_DST | COPY_SRC });
    this.frame = this.device.createTexture({ size: { width, height }, format: "rgba16float", usage: TEXTURE_BINDING | STORAGE_BINDING | TEXTURE_COPY_SRC });
    this.size = { width, height };
    this.samples = 0;
  }

  /**
   * Add a frame's samples of `instances` seen through `draw` at `width × height`,
   * and return the mean so far: an rgba16float texture, premultiplied, alpha
   * 0 where the eye saw nothing (unless `background`).
   */
  render(instances: readonly MeshSceneInstance[], draw: ReferenceDraw, width: number, height: number, settings: ReferenceSettings = {}): any {
    this.ensureTargets(width, height);
    const sceneChanged = this.core.setScene(instances);
    const key = drawKey(draw, width, height, settings);
    if (sceneChanged || key !== this.key) {
      this.key = key;
      this.samples = 0;
      this.core.setLights(referenceLights(draw).data);
    }
    const maxSamples = settings.maxSamples ?? 4096;
    const encoder = this.device.createCommandEncoder();
    if (this.samples === 0) encoder.clearBuffer(this.accum);
    const take = Math.max(0, Math.min(settings.samplesPerFrame ?? 1, maxSamples - this.samples));
    if (take > 0) {
      const camera = cameraOf(draw);
      const lights = referenceLights(draw);
      const sky = this.core.setSky(draw.environment);
      const setup = { bounces: settings.bounces ?? REFERENCE_BOUNCES, sky, lights, ambient: referenceAmbient(draw), clamp: settings.clamp ?? 0, background: settings.background ?? false, mapTable: this.core.mapTable };
      const params = pathTraceParams(camera, { width, height, x: 0, y: 0, tileWidth: width, tileHeight: height }, this.samples, take, setup);
      this.device.queue.writeBuffer(this.params, 0, params);
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.core.tracePipeline);
      pass.setBindGroup(0, this.core.traceGroup(this.accum, this.params));
      pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP), Math.ceil(height / WORKGROUP));
      pass.end();
      this.samples += take;
    }
    this.device.queue.writeBuffer(this.resolveInfo, 0, new Uint32Array([width, height, this.samples, 0]));
    const resolve = encoder.beginComputePass();
    resolve.setPipeline(this.core.resolver);
    resolve.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.core.resolver.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.accum } },
          { binding: 1, resource: this.frame.createView() },
          { binding: 2, resource: { buffer: this.resolveInfo } },
        ],
      }),
    );
    resolve.dispatchWorkgroups(Math.ceil(width / WORKGROUP), Math.ceil(height / WORKGROUP));
    resolve.end();
    this.device.queue.submit([encoder.finish()]);
    return this.frame;
  }

  destroy(): void {
    this.core.destroy();
    this.accum?.destroy();
    this.frame?.destroy();
    this.params.destroy();
    this.resolveInfo.destroy();
  }
}

export interface CaptureOptions extends ReferenceSettings {
  readonly width: number;
  readonly height: number;
  /** Samples a pixel takes (default 256). */
  readonly samples?: number;
  /** The tile's side in pixels (default 512). */
  readonly tile?: number;
  /** Keep the linear HDR image too (RGBA floats; 16 bytes a pixel). */
  readonly hdr?: boolean;
  /** The display image's exposure and tone map (default 1, ACES). */
  readonly exposure?: number;
  readonly toneMapper?: ToneMapper;
  /** Hears the share done, 0..1, after each submit. */
  readonly progress?: (done: number) => void;
}

/** A finished capture: the display image (sRGB bytes, tone-mapped), and the linear one if asked. */
export interface ReferenceCapture {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
  readonly hdr: Float32Array | null;
}

/**
 * Render the reference at `width × height` (up to {@link MAX_CAPTURE_SIDE} a
 * side) a tile at a time, each tile's samples spread over submits small
 * enough for any watchdog. A miss from the eye shows the sky unless the
 * options say otherwise.
 */
export async function captureReference(device: any, instances: readonly MeshSceneInstance[], draw: ReferenceDraw, options: CaptureOptions): Promise<ReferenceCapture> {
  const width = Math.max(1, Math.min(MAX_CAPTURE_SIDE, Math.round(options.width)));
  const height = Math.max(1, Math.min(MAX_CAPTURE_SIDE, Math.round(options.height)));
  const samples = Math.max(1, Math.round(options.samples ?? 256));
  const tile = Math.max(WORKGROUP, Math.min(2048, Math.round(options.tile ?? 512)));
  const core = new TracerCore(device);
  core.setScene(instances);
  const sky = core.setSky(draw.environment);
  const lights = referenceLights(draw);
  core.setLights(lights.data);
  const camera = cameraOf(draw);
  const setup: TraceSetup = { bounces: options.bounces ?? REFERENCE_BOUNCES, sky, lights, ambient: referenceAmbient(draw), clamp: options.clamp ?? 0, background: options.background ?? true, mapTable: core.mapTable };
  const accum = device.createBuffer({ size: tile * tile * 16, usage: STORAGE | COPY_DST | COPY_SRC });
  const params = device.createBuffer({ size: PARAMS_BYTES, usage: UNIFORM | COPY_DST });
  const readback = device.createBuffer({ size: tile * tile * 16, usage: MAP_READ | COPY_DST });
  const rgba = new Uint8ClampedArray(width * height * 4);
  const hdr = options.hdr ? new Float32Array(width * height * 4) : null;
  const exposure = options.exposure ?? 1;
  const mapper = options.toneMapper ?? "aces";
  const tilesX = Math.ceil(width / tile);
  const tilesY = Math.ceil(height / tile);
  let done = 0;
  try {
    for (let ty = 0; ty < tilesY; ty += 1) {
      for (let tx = 0; tx < tilesX; tx += 1) {
        const x = tx * tile;
        const y = ty * tile;
        const tw = Math.min(tile, width - x);
        const th = Math.min(tile, height - y);
        const perSubmit = Math.max(1, Math.floor(CAPTURE_PATHS_PER_SUBMIT / (tw * th)));
        const clear = device.createCommandEncoder();
        clear.clearBuffer(accum);
        device.queue.submit([clear.finish()]);
        const group = core.traceGroup(accum, params);
        for (let first = 0; first < samples; first += perSubmit) {
          const take = Math.min(perSubmit, samples - first);
          device.queue.writeBuffer(params, 0, pathTraceParams(camera, { width, height, x, y, tileWidth: tw, tileHeight: th }, first, take, setup));
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(core.tracePipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(Math.ceil(tw / WORKGROUP), Math.ceil(th / WORKGROUP));
          pass.end();
          device.queue.submit([encoder.finish()]);
          await device.queue.onSubmittedWorkDone();
          done += take * tw * th;
          options.progress?.(done / (samples * width * height));
        }
        const copy = device.createCommandEncoder();
        copy.copyBufferToBuffer(accum, 0, readback, 0, tw * th * 16);
        device.queue.submit([copy.finish()]);
        await readback.mapAsync(MAP_READ, 0, tw * th * 16);
        const sums = new Float32Array(readback.getMappedRange(0, tw * th * 16).slice(0));
        readback.unmap();
        for (let j = 0; j < th; j += 1) {
          for (let i = 0; i < tw; i += 1) {
            const s = (j * tw + i) * 4;
            const o = ((y + j) * width + (x + i)) * 4;
            const c: [number, number, number] = [sums[s]! / samples, sums[s + 1]! / samples, sums[s + 2]! / samples];
            const a = sums[s + 3]! / samples;
            if (hdr) hdr.set([c[0], c[1], c[2], a], o);
            const shown = toneMap(mapper, [c[0] * exposure, c[1] * exposure, c[2] * exposure]);
            rgba[o] = Math.round(srgbEncode(shown[0]) * 255);
            rgba[o + 1] = Math.round(srgbEncode(shown[1]) * 255);
            rgba[o + 2] = Math.round(srgbEncode(shown[2]) * 255);
            rgba[o + 3] = Math.round(Math.min(1, a) * 255);
          }
        }
      }
    }
  } finally {
    core.destroy();
    accum.destroy();
    params.destroy();
    readback.destroy();
  }
  return { width, height, rgba, hdr };
}
