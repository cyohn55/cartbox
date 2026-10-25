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
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { LIGHTMAP_RANGE, buildBvh, finishLightmapValues, lightmapTexels, type HdrLightmap, type LightmapLayout, type Occluder } from "@cartbox/editor";

import type { LinearPanorama } from "./ibl.js";

/** The most bounces a bake takes, and the most directional lights. */
export const LIGHTMAP_MAX_BOUNCES = 8;
export const LIGHTMAP_MAX_LIGHTS = 4;
const WORKGROUP = 64;
/** Texels a dispatch covers at most, and paths (texels × samples) a submit traces at most. */
const CHUNK_TEXELS = 65536;
const PATHS_PER_SUBMIT = 1 << 19;
const PARAMS_BYTES = 48 + LIGHTMAP_MAX_LIGHTS * 32;

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
}

/** A finished bake: the HDR directional light map and the 8-bit ambient scale, both `size × size`. */
export interface GpuLightmapBake {
  readonly hdr: HdrLightmap;
  /** RGBA bytes in lightmap.ts's format (× 1/{@link LIGHTMAP_RANGE}). */
  readonly ambient: Uint8ClampedArray;
}

/** The scene as the tracer reads it. */
export interface PackedLightmapScene {
  /** Per node two vec4<u32>: min xyz (float bits) and the left child, or −1 − count for a leaf; max xyz and the right child, or the first triangle. */
  readonly nodes: Uint32Array;
  /** Per triangle three vec4s: a corner, and the two edges from it (in the BVH's order). */
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
  }
  accum[j * 3u] = accum[j * 3u] + vec4<f32>(e, 0.0);
  accum[j * 3u + 1u] = accum[j * 3u + 1u] + vec4<f32>(dirSum, lumSum);
  accum[j * 3u + 2u] = accum[j * 3u + 2u] + vec4<f32>(skyRef, skyOpen);
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
  const { size } = layout;
  const texels = lightmapTexels(layout);
  const count = texels.index.length;
  const acc = new Float32Array(count * 12);
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
  progress?.(1);
  return finishGpuLightmap(size, texels.index, texels.chart, acc, samples);
}

/**
 * Turn the tracer's sums into the finished maps: the irradiance, direction,
 * sky visibility and ambient scale per texel, blurred within each chart and
 * grown past its edges as the CPU bake's are.
 */
export function finishGpuLightmap(size: number, index: Int32Array, chart: Int32Array, acc: Float32Array, samples: number): GpuLightmapBake {
  const texels = size * size;
  const irradiance = new Float32Array(texels * 3);
  const dir = new Float32Array(texels * 3);
  const ratio = new Float32Array(texels * 3);
  const vis = new Float32Array(texels * 3);
  for (let j = 0; j < index.length; j += 1) {
    const i = index[j]!;
    const o = j * 12;
    for (let c = 0; c < 3; c += 1) irradiance[i * 3 + c] = acc[o + c]! / samples;
    const w = acc[o + 7]!;
    for (let c = 0; c < 3; c += 1) dir[i * 3 + c] = w > 1e-12 ? acc[o + 4 + c]! / w : 0;
    // The ambient scale: what arrived over what the open sky would give, per channel (1 under a black sky).
    for (let c = 0; c < 3; c += 1) {
      const open = acc[o + 8 + c]! / samples;
      ratio[i * 3 + c] = open > 1e-6 ? Math.min(LIGHTMAP_RANGE, irradiance[i * 3 + c]! / open) : 1;
    }
    const ref = luminance(acc[o + 8]!, acc[o + 9]!, acc[o + 10]!);
    vis[i * 3] = ref > 1e-12 ? Math.min(1, acc[o + 11]! / ref) : 1;
  }
  for (const values of [irradiance, dir, ratio, vis]) finishLightmapValues(values, chart, size);
  const direction = new Float32Array(texels * 4);
  const ambient = new Uint8ClampedArray(texels * 4);
  // Quantised to steps of 2, as the CPU bake's are.
  const q = (x: number) => Math.min(255, Math.round((x / LIGHTMAP_RANGE) * 127.5) * 2);
  for (let i = 0; i < texels; i += 1) {
    const length = Math.hypot(dir[i * 3]!, dir[i * 3 + 1]!, dir[i * 3 + 2]!);
    const k = length > 1 ? 1 / length : 1; // never past a single direction (unused atlas space reads (1, 1, 1))
    direction.set([dir[i * 3]! * k, dir[i * 3 + 1]! * k, dir[i * 3 + 2]! * k, vis[i * 3]!], i * 4);
    ambient.set([q(ratio[i * 3]!), q(ratio[i * 3 + 1]!), q(ratio[i * 3 + 2]!), 255], i * 4);
  }
  return { hdr: { width: size, height: size, irradiance, direction }, ambient };
}
