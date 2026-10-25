/**
 * The GPU lightmapper (AAA_FIDELITY_ROADMAP.md F3d): a path tracer in compute
 * that bakes a laid-out mesh's light map in linear light, in seconds in the
 * browser where the CPU bake (lightmap.ts) takes minutes.
 *
 * - **The scene** is the CPU bake's own triangle BVH (`buildBvh`), flattened
 *   into storage buffers: two words per node, three vec4s per triangle (a
 *   corner and two edges) and its material in linear light (albedo, and an
 *   emissive colour that lights what sees it).
 * - **The texels** are the ones the CPU bake shades (`lightmapTexels`): each
 *   one's surface point and normal.
 * - **Each path** leaves the texel along a cosine-weighted direction (the
 *   first stratified over the bake, rotated per texel) and bounces diffusely
 *   up to `bounces` times. Open sky gives the sky's radiance (the IBL's own
 *   panorama, F3a); a surface gives its emission, and each surface it bounces
 *   off is lit by the directional lights (a shadow ray each). The texel's own
 *   sunlight is left out: the live cascades (F2a) draw it.
 * - **The mean** of what the paths bring back is the irradiance over π: what
 *   a white Lambertian surface there reflects, as the sky's SH irradiance is.
 *   The paths also give the light's dominant direction (luminance-weighted)
 *   and the share of the sky's light that came through unblocked.
 *
 * The result is an HDR directional light map (hdrLightmap.ts) for the AAA
 * tier, and, from the same paths, the 8-bit ambient scale every other tier
 * reads (the irradiance over the open sky's, per channel). Each dispatch is a
 * bounded number of paths, so no submit nears a GPU's watchdog.
 *
 * Then it is finished (F3d-2):
 * - **Invalid texels.** A texel whose first rays mostly hit the backs of
 *   surfaces (by their authored normals) lies inside something, a floor
 *   texel under a wall's foot, say. It is dropped and filled from its valid
 *   neighbours, so it neither darkens the floor beside the wall nor lets the
 *   light inside it out.
 * - **Denoising** on the GPU: an edge-avoiding à-trous wavelet (Dammertz et
 *   al. 2010) of four passes, 1 to 8 texels apart, stopped by the texels'
 *   normals and planes (so neither a corner nor a neighbouring chart blurs
 *   in) and by luminance against each texel's own variance, prefiltered over
 *   its 3×3 (Schied et al.'s SVGF), so a well-converged texel is left nearly
 *   as it is.
 * - **Seams** stitched: where one edge in the world sits on two charts, the
 *   texels along both are nudged (least squares) until the two lookups agree.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { LIGHTMAP_RANGE, buildBvh, dilateLightmapValues, lightmapTexels, stitchLightmapSeams, type HdrLightmap, type LightmapLayout, type LightmapTexels, type Occluder } from "@cartbox/editor";

import type { LinearPanorama } from "./ibl.js";

/** The most bounces a bake takes, and the most directional lights. */
export const LIGHTMAP_MAX_BOUNCES = 8;
export const LIGHTMAP_MAX_LIGHTS = 4;
const WORKGROUP = 64;
/** Texels a dispatch covers at most, and paths (texels × samples) a submit traces at most. */
const CHUNK_TEXELS = 65536;
const PATHS_PER_SUBMIT = 1 << 19;
const PARAMS_BYTES = 48 + LIGHTMAP_MAX_LIGHTS * 32;
/** The tracer's sums per texel: four vec4s. */
const ACC_FLOATS = 16;

const STORAGE = 0x80;
const COPY_DST = 0x08;
const COPY_SRC = 0x04;
const MAP_READ = 0x01;
const UNIFORM = 0x40;

/** A directional light the bounces are lit by: the direction toward it, and its radiance in linear light (colour × intensity). */
export interface BakeLight {
  readonly direction: readonly [number, number, number];
  readonly radiance: readonly [number, number, number];
}

export interface GpuLightBakeOptions {
  /** Paths per texel (default 256). */
  readonly samples?: number;
  /** Diffuse bounces after the first surface a path meets (0..8, default 3): 0 is sky and emission seen directly. */
  readonly bounces?: number;
  /** The sky's radiance in linear light (`environmentPanorama`); none is a black sky. */
  readonly sky?: LinearPanorama | null;
  /** The directional lights (at most four) that light the surfaces paths bounce off. */
  readonly lights?: readonly BakeLight[];
  /** Denoise on the GPU (default true; F3d-2). */
  readonly denoise?: boolean;
  /** Stitch the seams between charts (default true; F3d-2). */
  readonly stitch?: boolean;
  /** The share of a texel's first rays that may hit backs of surfaces before it counts as inside one (default 0.6; F3d-2). */
  readonly backfaceLimit?: number;
}

/** A finished bake: the HDR directional light map and the 8-bit ambient scale, both `size × size`. */
export interface GpuLightmapBake {
  readonly hdr: HdrLightmap;
  /** RGBA bytes in lightmap.ts's format (× 1/{@link LIGHTMAP_RANGE}). */
  readonly ambient: Uint8ClampedArray;
  /** Texels dropped as inside geometry, and seam points stitched (F3d-2). */
  readonly invalid: number;
  readonly seams: number;
}

/** The scene as the tracer reads it. */
export interface PackedLightmapScene {
  /** Per node two vec4<u32>: min xyz (float bits) and the left child, or −1 − count for a leaf; max xyz and the right child, or the first triangle. */
  readonly nodes: Uint32Array;
  /** Per triangle three vec4s: a corner, and the two edges from it (in the BVH's order); their w's the side it faces by its authored normals. */
  readonly tris: Float32Array;
  /** Per triangle two vec4s: albedo and emission, linear. */
  readonly mats: Float32Array;
  readonly triangles: number;
}

/** Authored colour into linear light, as the AAA shader's `toLinear` decodes it (an emissive above 1 included). */
function toLinear(c: number): number {
  const v = Math.max(0, c);
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Flatten the occluders' BVH into the tracer's buffers. */
export function packLightmapScene(occluders: readonly Occluder[]): PackedLightmapScene {
  const bvh = buildBvh(occluders);
  const triangles = bvh.order.length;
  const nodeCount = bvh.meta.length / 3;
  // An empty scene still binds one node, an inside-out box no ray enters.
  const nodes = new Uint32Array(Math.max(1, nodeCount) * 8);
  const bits = new Float32Array(nodes.buffer);
  if (nodeCount === 0) {
    bits.set([1, 1, 1], 0);
    bits.set([-1, -1, -1], 4);
    nodes[3] = 0xffffffff; // −1: a leaf of no triangles
  }
  for (let n = 0; n < nodeCount; n += 1) {
    for (let a = 0; a < 3; a += 1) {
      bits[n * 8 + a] = bvh.nodes[n * 6 + a]!;
      bits[n * 8 + 4 + a] = bvh.nodes[n * 6 + 3 + a]!;
    }
    const left = bvh.meta[n * 3]!;
    nodes[n * 8 + 3] = (left >= 0 ? left : -1 - bvh.meta[n * 3 + 2]!) >>> 0;
    nodes[n * 8 + 7] = bvh.meta[n * 3 + 1]! >>> 0;
  }
  const tris = new Float32Array(Math.max(1, triangles) * 12);
  const mats = new Float32Array(Math.max(1, triangles) * 8);
  for (let i = 0; i < triangles; i += 1) {
    const t = bvh.order[i]!;
    const k = t * 9;
    for (let a = 0; a < 3; a += 1) {
      tris[i * 12 + a * 4 + 3] = bvh.front[t * 3 + a]!;
      tris[i * 12 + a] = bvh.tri[k + a]!;
      tris[i * 12 + 4 + a] = bvh.tri[k + 3 + a]! - bvh.tri[k + a]!;
      tris[i * 12 + 8 + a] = bvh.tri[k + 6 + a]! - bvh.tri[k + a]!;
      mats[i * 8 + a] = toLinear(bvh.col[t * 3 + a]!);
      mats[i * 8 + 4 + a] = toLinear(bvh.emi[t * 3 + a]!);
    }
  }
  return { nodes, tris, mats, triangles };
}

export const LIGHTMAP_TRACE_WGSL = /* wgsl */ `
struct Params {
  run: vec4<u32>,   // x = first texel, y = texels, z = first sample, w = samples this pass
  info: vec4<u32>,  // x = bounces, y = lights, z = sky width, w = sky height
  total: vec4<u32>, // x = samples in all
  lightDir: array<vec4<f32>, ${LIGHTMAP_MAX_LIGHTS}>,
  lightRad: array<vec4<f32>, ${LIGHTMAP_MAX_LIGHTS}>,
};
@group(0) @binding(0) var<storage, read> nodes: array<vec4<u32>>;
@group(0) @binding(1) var<storage, read> tris: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> mats: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> texels: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> accum: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> sky: array<vec4<f32>>;
@group(0) @binding(6) var<uniform> params: Params;

const PI = 3.14159265;
// How far a ray starts off its surface, and the nearest hit it takes (metres).
const EPS = 0.005;
const T_MIN = 1e-4;
const FAR = 1e30;

struct Hit {
  t: f32,
  tri: i32,
};

// The closest hit along o + t·d within tMax (or, with anyHit, the first found).
fn trace(o: vec3<f32>, d: vec3<f32>, tMax: f32, anyHit: bool) -> Hit {
  var best = Hit(tMax, -1);
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
    let b = nodes[n * 2u + 1u];
    let t0 = (bitcast<vec3<f32>>(a.xyz) - o) * inv;
    let t1 = (bitcast<vec3<f32>>(b.xyz) - o) * inv;
    let lo = min(t0, t1);
    let hi = max(t0, t1);
    let tn = max(max(lo.x, lo.y), max(lo.z, 0.0));
    let tf = min(min(hi.x, hi.y), min(hi.z, best.t));
    if (tn > tf) { continue; }
    let left = bitcast<i32>(a.w);
    if (left >= 0) {
      if (sp + 2u <= 64u) {
        stack[sp] = u32(left);
        stack[sp + 1u] = b.w;
        sp = sp + 2u;
      }
      continue;
    }
    let first = b.w;
    let count = u32(-1 - left);
    for (var i = first; i < first + count; i = i + 1u) {
      // Möller–Trumbore.
      let v0 = tris[i * 3u].xyz;
      let e1 = tris[i * 3u + 1u].xyz;
      let e2 = tris[i * 3u + 2u].xyz;
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
      if (t > T_MIN && t < best.t) {
        best = Hit(t, i32(i));
        if (anyHit) { return best; }
      }
    }
  }
  return best;
}

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
var<private> rng: u32;
fn rand() -> f32 {
  rng = pcg(rng);
  return f32(rng >> 8u) / 16777216.0;
}
fn radicalInverse(i: u32) -> f32 {
  return f32(reverseBits(i)) * 2.3283064365386963e-10;
}

// A cosine-weighted direction about n (Duff et al.'s branchless frame).
fn cosineDir(n: vec3<f32>, xi: vec2<f32>) -> vec3<f32> {
  let r = sqrt(xi.x);
  let phi = 2.0 * PI * xi.y;
  let sg = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (sg + n.z);
  let b = n.x * n.y * a;
  let t = vec3<f32>(1.0 + sg * n.x * n.x * a, sg * b, -sg * n.x);
  let bt = vec3<f32>(b, sg + n.y * n.y * a, -n.y);
  return normalize(t * (r * cos(phi)) + bt * (r * sin(phi)) + n * sqrt(max(0.0, 1.0 - xi.x)));
}

// The sky along d: the panorama's texel (u around from −x, v down from the zenith, as the IBL reads it).
fn skyAt(d: vec3<f32>) -> vec3<f32> {
  let w = params.info.z;
  let h = params.info.w;
  if (w == 0u) { return vec3<f32>(0.0); }
  let u = atan2(d.z, d.x) / (2.0 * PI) + 0.5;
  let v = acos(clamp(d.y, -1.0, 1.0)) / PI;
  let x = min(u32(max(u, 0.0) * f32(w)), w - 1u);
  let y = min(u32(max(v, 0.0) * f32(h)), h - 1u);
  return sky[y * w + x].rgb;
}

fn lum(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.run.y) { return; }
  let j = params.run.x + id.x;
  let P = texels[j * 2u].xyz;
  let Ng = normalize(texels[j * 2u + 1u].xyz);
  // The first bounce's directions: one stratified set for the bake, turned per texel (Cranley–Patterson).
  let turn = vec2<f32>(f32(pcg(j * 2u + 1u) >> 8u), f32(pcg(j * 2u + 2u) >> 8u)) / 16777216.0;
  let bounces = params.info.x;
  let lights = params.info.y;
  var e = vec3<f32>(0.0);
  var dirSum = vec3<f32>(0.0);
  var lumSum = 0.0;
  var skyRef = vec3<f32>(0.0);
  var skyOpen = 0.0;
  var lumSq = 0.0;
  var backs = 0.0;
  for (var k = 0u; k < params.run.w; k = k + 1u) {
    let s = params.run.z + k;
    rng = pcg(j ^ pcg(s + 0x9e3779b9u));
    let xi = fract(vec2<f32>(f32(s) / f32(params.total.x), radicalInverse(s)) + turn);
    let d0 = cosineDir(Ng, xi);
    let sky0 = skyAt(d0);
    skyRef = skyRef + sky0;
    var tp = vec3<f32>(1.0);
    var o = P + Ng * EPS;
    var d = d0;
    var L = vec3<f32>(0.0);
    for (var b = 0u; b <= bounces; b = b + 1u) {
      let h = trace(o, d, FAR, false);
      if (h.tri < 0) {
        if (b == 0u) {
          L = L + sky0;
          skyOpen = skyOpen + lum(sky0);
        } else {
          L = L + tp * skyAt(d);
        }
        break;
      }
      let i = u32(h.tri);
      // The first ray met the back of a surface: this texel may lie inside it (F3d-2).
      if (b == 0u && dot(d, vec3<f32>(tris[i * 3u].w, tris[i * 3u + 1u].w, tris[i * 3u + 2u].w)) > 0.0) { backs = backs + 1.0; }
      L = L + tp * mats[i * 2u + 1u].rgb;
      if (b == bounces) { break; }
      var n = normalize(cross(tris[i * 3u + 1u].xyz, tris[i * 3u + 2u].xyz));
      if (dot(n, d) > 0.0) { n = -n; } // the side the path arrived on (surfaces are two-sided)
      let hp = o + d * h.t + n * EPS;
      tp = tp * mats[i * 2u].rgb;
      for (var l = 0u; l < lights; l = l + 1u) {
        let Ld = params.lightDir[l].xyz;
        let ndl = dot(n, Ld);
        if (ndl > 0.0 && trace(hp, Ld, FAR, true).tri < 0) {
          L = L + tp * params.lightRad[l].rgb * ndl;
        }
      }
      if (max(tp.r, max(tp.g, tp.b)) < 1e-4) { break; }
      o = hp;
      d = cosineDir(n, vec2<f32>(rand(), rand()));
    }
    e = e + L;
    let y = lum(L);
    dirSum = dirSum + d0 * y;
    lumSum = lumSum + y;
    lumSq = lumSq + y * y;
  }
  accum[j * 4u] = accum[j * 4u] + vec4<f32>(e, 0.0);
  accum[j * 4u + 1u] = accum[j * 4u + 1u] + vec4<f32>(dirSum, lumSum);
  accum[j * 4u + 2u] = accum[j * 4u + 2u] + vec4<f32>(skyRef, skyOpen);
  accum[j * 4u + 3u] = accum[j * 4u + 3u] + vec4<f32>(lumSq, backs, 0.0, 0.0);
}
`;

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The tracer's parameters for one dispatch. */
export function lightmapParams(first: number, texels: number, firstSample: number, samples: number, total: number, bounces: number, sky: LinearPanorama | null, lights: readonly BakeLight[]): ArrayBuffer {
  const buffer = new ArrayBuffer(PARAMS_BYTES);
  const u = new Uint32Array(buffer);
  const f = new Float32Array(buffer);
  u.set([first, texels, firstSample, samples, bounces, Math.min(lights.length, LIGHTMAP_MAX_LIGHTS), sky?.width ?? 0, sky?.height ?? 0, total], 0);
  lights.slice(0, LIGHTMAP_MAX_LIGHTS).forEach((light, i) => {
    const [x, y, z] = light.direction;
    const len = Math.hypot(x, y, z) || 1;
    f.set([x / len, y / len, z / len, 0], 12 + i * 4);
    f.set([...light.radiance, 0], 12 + LIGHTMAP_MAX_LIGHTS * 4 + i * 4);
  });
  return buffer;
}

/**
 * Bake a laid-out mesh's light map on `device` against `occluders` (which
 * should include the mesh itself); see the module comment. `progress` hears
 * the share done after each submit.
 */
export async function bakeLightmapGpu(device: any, layout: LightmapLayout, occluders: readonly Occluder[], options: GpuLightBakeOptions = {}, progress?: (done: number) => void): Promise<GpuLightmapBake> {
  const samples = Math.max(1, Math.round(options.samples ?? 256));
  const bounces = Math.max(0, Math.min(LIGHTMAP_MAX_BOUNCES, Math.round(options.bounces ?? 3)));
  const sky = options.sky ?? null;
  const lights = options.lights ?? [];
  const texels = lightmapTexels(layout);
  const count = texels.index.length;
  const acc = new Float32Array(count * ACC_FLOATS);
  if (count > 0) {
    const scene = packLightmapScene(occluders);
    const points = new Float32Array(count * 8);
    for (let j = 0; j < count; j += 1) {
      for (let a = 0; a < 3; a += 1) {
        points[j * 8 + a] = texels.position[j * 3 + a]!;
        points[j * 8 + 4 + a] = texels.normal[j * 3 + a]!;
      }
    }
    const upload = (data: ArrayBufferView) => {
      const buffer = device.createBuffer({ size: Math.max(16, data.byteLength), usage: STORAGE | COPY_DST });
      device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
      return buffer;
    };
    const skyData = sky ? sky.data : new Float32Array(4);
    const buffers = [upload(scene.nodes), upload(scene.tris), upload(scene.mats), upload(points)];
    const accum = device.createBuffer({ size: acc.byteLength, usage: STORAGE | COPY_SRC });
    const skyBuffer = upload(skyData);
    const params = device.createBuffer({ size: PARAMS_BYTES, usage: UNIFORM | COPY_DST });
    const readback = device.createBuffer({ size: acc.byteLength, usage: MAP_READ | COPY_DST });
    try {
      const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: LIGHTMAP_TRACE_WGSL }), entryPoint: "main" } });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [...buffers, accum, skyBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })).concat([{ binding: 6, resource: { buffer: params } }]),
      });
      const chunk = Math.min(count, CHUNK_TEXELS);
      const perPass = Math.max(1, Math.min(samples, Math.floor(PATHS_PER_SUBMIT / chunk)));
      const submits = Math.ceil(samples / perPass) * Math.ceil(count / chunk);
      let done = 0;
      for (let s = 0; s < samples; s += perPass) {
        const n = Math.min(perPass, samples - s);
        for (let first = 0; first < count; first += chunk) {
          const texelsHere = Math.min(chunk, count - first);
          device.queue.writeBuffer(params, 0, lightmapParams(first, texelsHere, s, n, samples, bounces, sky, lights));
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(Math.ceil(texelsHere / WORKGROUP));
          pass.end();
          device.queue.submit([encoder.finish()]);
          // One submit in flight: each is bounded, and the page (or test) keeps its turn between them.
          await device.queue.onSubmittedWorkDone();
          done += 1;
          progress?.(done / submits);
        }
      }
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(accum, 0, readback, 0, acc.byteLength);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(MAP_READ);
      acc.set(new Float32Array(readback.getMappedRange()));
      readback.unmap();
    } finally {
      for (const buffer of [...buffers, accum, skyBuffer, params, readback]) buffer.destroy();
    }
  }
  const atlas = resolveLightmap(texels, acc, samples, options.backfaceLimit ?? 0.6);
  if (count > 0 && options.denoise !== false) await denoiseLightmap(device, atlas, 1 / layout.density);
  progress?.(1);
  return finishLightmap(layout, atlas, options.stitch !== false);
}

/**
 * A baked light map over its atlas, between the tracer and the finished maps
 * (F3d-2): 12 floats per texel (the irradiance and its luminance's variance;
 * the direction and the sky's visibility; the ambient scale and 0), whether
 * each texel is baked and valid, and the denoiser's guide (position and
 * normal, 8 floats).
 */
export interface LightmapAtlas {
  readonly size: number;
  readonly values: Float32Array;
  /** Per texel: ≥ 0 baked and valid, −1 not (unused, or inside geometry). */
  readonly valid: Int32Array;
  readonly guide: Float32Array;
  readonly invalid: number;
}

/** The tracer's sums as per-texel means (see {@link LightmapAtlas}), a texel inside geometry dropped. */
export function resolveLightmap(texels: LightmapTexels, acc: Float32Array, samples: number, backfaceLimit: number): LightmapAtlas {
  const { size, index } = texels;
  const values = new Float32Array(size * size * 12);
  const guide = new Float32Array(size * size * 8);
  const valid = new Int32Array(size * size).fill(-1);
  let invalid = 0;
  for (let j = 0; j < index.length; j += 1) {
    const i = index[j]!;
    const o = j * ACC_FLOATS;
    if (acc[o + 13]! > backfaceLimit * samples) {
      invalid += 1;
      continue;
    }
    valid[i] = texels.chart[i]!;
    const v = i * 12;
    for (let c = 0; c < 3; c += 1) values[v + c] = acc[o + c]! / samples;
    // The variance of the texel's mean luminance: the denoiser's measure of its noise.
    const mean = acc[o + 7]! / samples;
    values[v + 3] = Math.max(0, acc[o + 12]! / samples - mean * mean) / samples;
    const w = acc[o + 7]!;
    for (let c = 0; c < 3; c += 1) values[v + 4 + c] = w > 1e-12 ? acc[o + 4 + c]! / w : 0;
    const ref = luminance(acc[o + 8]!, acc[o + 9]!, acc[o + 10]!);
    values[v + 7] = ref > 1e-12 ? Math.min(1, acc[o + 11]! / ref) : 1;
    // The ambient scale: what arrived over what the open sky would give, per channel (1 under a black sky).
    for (let c = 0; c < 3; c += 1) {
      const open = acc[o + 8 + c]! / samples;
      values[v + 8 + c] = open > 1e-6 ? Math.min(LIGHTMAP_RANGE, values[v + c]! / open) : 1;
    }
    for (let c = 0; c < 3; c += 1) {
      guide[i * 8 + c] = texels.position[j * 3 + c]!;
      guide[i * 8 + 4 + c] = texels.normal[j * 3 + c]!;
    }
    guide[i * 8 + 3] = 1;
  }
  return { size, values, valid, guide, invalid };
}

/**
 * How many à-trous passes the denoiser runs (1, 2, 4 and 8 texels apart), and
 * its luminance edge-stop in standard deviations. Measured on a sunlit red
 * wall's bounce (gpu-lightmapper tests): at 8 paths a texel this leaves under
 * half the error, while a glowing ceiling's smooth falloff loses about 3% at
 * its peak. A wider stop blurs real gradients more than it removes noise.
 */
export const DENOISE_PASSES = 4;
const DENOISE_SIGMA = 1.5;

export const LIGHTMAP_DENOISE_WGSL = /* wgsl */ `
struct Params {
  size: u32,
  step: u32,
  texel: f32, // world units per texel
  sigma: f32,
};
@group(0) @binding(0) var<storage, read> guide: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> params: Params;

fn lum(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = params.size;
  if (id.x >= size || id.y >= size) { return; }
  let i = id.y * size + id.x;
  let a0 = src[i * 3u];
  let a1 = src[i * 3u + 1u];
  let a2 = src[i * 3u + 2u];
  let g = guide[i * 2u];
  if (g.w < 0.5) {
    dst[i * 3u] = a0;
    dst[i * 3u + 1u] = a1;
    dst[i * 3u + 2u] = a2;
    return;
  }
  let p = g.xyz;
  let n = guide[i * 2u + 1u].xyz;
  let l = lum(a0.rgb);
  // The variance the luminance stop is scaled by, prefiltered over the texel's 3×3 (SVGF): a few paths' estimate is noisy itself.
  var vsum = 0.0;
  var vw = 0.0;
  for (var vy = -1; vy <= 1; vy = vy + 1) {
    for (var vx = -1; vx <= 1; vx = vx + 1) {
      let qx = i32(id.x) + vx;
      let qy = i32(id.y) + vy;
      if (qx < 0 || qy < 0 || qx >= i32(size) || qy >= i32(size)) { continue; }
      let j = u32(qy) * size + u32(qx);
      if (guide[j * 2u].w < 0.5) { continue; }
      let k = select(0.5, 1.0, vx == 0) * select(0.5, 1.0, vy == 0);
      vsum = vsum + src[j * 3u].w * k;
      vw = vw + k;
    }
  }
  let sigma = params.sigma * sqrt(max(vsum / vw, 0.0)) + 1e-4;
  // Farther than this in the world, a texel the kernel reaches is on another chart that merely sits beside this one in the atlas.
  let reach = (2.83 * f32(params.step) + 1.5) * params.texel;
  var kernel = array<f32, 5>(0.0625, 0.25, 0.375, 0.25, 0.0625);
  var s0 = vec3<f32>(0.0);
  var sv = 0.0;
  var s1 = vec4<f32>(0.0);
  var s2 = vec4<f32>(0.0);
  var ws = 0.0;
  for (var dy = -2; dy <= 2; dy = dy + 1) {
    for (var dx = -2; dx <= 2; dx = dx + 1) {
      let qx = i32(id.x) + dx * i32(params.step);
      let qy = i32(id.y) + dy * i32(params.step);
      if (qx < 0 || qy < 0 || qx >= i32(size) || qy >= i32(size)) { continue; }
      let j = u32(qy) * size + u32(qx);
      let gq = guide[j * 2u];
      if (gq.w < 0.5) { continue; }
      let dp = gq.xyz - p;
      if (length(dp) > reach) { continue; }
      let b0 = src[j * 3u];
      let wn = pow(max(0.0, dot(n, guide[j * 2u + 1u].xyz)), 32.0);
      let wp = exp(-abs(dot(dp, n)) / params.texel);
      let wl = exp(-abs(lum(b0.rgb) - l) / sigma);
      let w = kernel[dx + 2] * kernel[dy + 2] * wn * wp * wl;
      s0 = s0 + b0.rgb * w;
      sv = sv + b0.w * w * w;
      s1 = s1 + src[j * 3u + 1u] * w;
      s2 = s2 + src[j * 3u + 2u] * w;
      ws = ws + w;
    }
  }
  // The texel itself always weighs in, so ws > 0.
  dst[i * 3u] = vec4<f32>(s0 / ws, sv / (ws * ws));
  dst[i * 3u + 1u] = s1 / ws;
  dst[i * 3u + 2u] = s2 / ws;
}
`;

/** Denoise a resolved light map on `device`, in place (see the module comment); `texel` is its world size. */
export async function denoiseLightmap(device: any, atlas: LightmapAtlas, texel: number, passes = DENOISE_PASSES, sigma = DENOISE_SIGMA): Promise<void> {
  const { size, values, guide } = atlas;
  const guideBuffer = device.createBuffer({ size: guide.byteLength, usage: STORAGE | COPY_DST });
  device.queue.writeBuffer(guideBuffer, 0, guide.buffer, guide.byteOffset, guide.byteLength);
  const ping = [0, 1].map(() => device.createBuffer({ size: values.byteLength, usage: STORAGE | COPY_DST | COPY_SRC }));
  device.queue.writeBuffer(ping[0], 0, values.buffer, values.byteOffset, values.byteLength);
  const params = device.createBuffer({ size: 16, usage: UNIFORM | COPY_DST });
  const readback = device.createBuffer({ size: values.byteLength, usage: MAP_READ | COPY_DST });
  try {
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: LIGHTMAP_DENOISE_WGSL }), entryPoint: "main" } });
    const groups = [0, 1].map((k) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: guideBuffer } },
          { binding: 1, resource: { buffer: ping[k] } },
          { binding: 2, resource: { buffer: ping[1 - k] } },
          { binding: 3, resource: { buffer: params } },
        ],
      }),
    );
    for (let pass = 0; pass < passes; pass += 1) {
      const p = new ArrayBuffer(16);
      new Uint32Array(p).set([size, 1 << pass]);
      new Float32Array(p).set([texel, sigma], 2);
      device.queue.writeBuffer(params, 0, p);
      const encoder = device.createCommandEncoder();
      const compute = encoder.beginComputePass();
      compute.setPipeline(pipeline);
      compute.setBindGroup(0, groups[pass % 2]);
      compute.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
      compute.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
    }
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(ping[passes % 2], 0, readback, 0, values.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(MAP_READ);
    values.set(new Float32Array(readback.getMappedRange()));
    readback.unmap();
  } finally {
    for (const buffer of [guideBuffer, ...ping, params, readback]) buffer.destroy();
  }
}

/**
 * The finished maps from a resolved (and denoised) light map: grown past each
 * chart's edge and into the invalid texels, its seams stitched, then split
 * into the HDR directional map and the 8-bit ambient scale.
 */
export function finishLightmap(layout: LightmapLayout, atlas: LightmapAtlas, stitch = true): GpuLightmapBake {
  const { size, values, valid } = atlas;
  dilateLightmapValues(values, valid, size, 12);
  const seams = stitch ? stitchLightmapSeams(layout, values, 12) : 0;
  const texels = size * size;
  const irradiance = new Float32Array(texels * 3);
  const direction = new Float32Array(texels * 4);
  const ambient = new Uint8ClampedArray(texels * 4);
  // Quantised to steps of 2, as the CPU bake's are.
  const q = (x: number) => Math.min(255, Math.round((Math.max(0, x) / LIGHTMAP_RANGE) * 127.5) * 2);
  for (let i = 0; i < texels; i += 1) {
    const v = i * 12;
    for (let c = 0; c < 3; c += 1) irradiance[i * 3 + c] = Math.max(0, values[v + c]!);
    const length = Math.hypot(values[v + 4]!, values[v + 5]!, values[v + 6]!);
    const k = length > 1 ? 1 / length : 1; // never past a single direction (unused atlas space reads (1, 1, 1))
    direction.set([values[v + 4]! * k, values[v + 5]! * k, values[v + 6]! * k, Math.min(1, Math.max(0, values[v + 7]!))], i * 4);
    ambient.set([q(values[v + 8]!), q(values[v + 9]!), q(values[v + 10]!), 255], i * 4);
  }
  return { hdr: { width: size, height: size, irradiance, direction }, ambient, invalid: atlas.invalid, seams };
}
