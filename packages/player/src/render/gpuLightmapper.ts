/**
 * The GPU lightmapper (AAA_FIDELITY_ROADMAP.md F3d): a path tracer in compute
 * that bakes a laid-out mesh's light map in linear light, in seconds in the
 * browser where the CPU bake (lightmap.ts) takes minutes.
 *
 * - **The scene** is the CPU bake's own triangle BVH (`buildBvh`), flattened
 *   into storage buffers: two words per node, three vec4s per triangle (a
 *   corner and two edges) and its material in linear light (the albedo a
 *   diffuse bounce takes, its lighting channels, and an emissive colour that
 *   lights what sees it).
 * - **The texels** are the ones the CPU bake shades (`lightmapTexels`): each
 *   one's surface point and normal.
 * - **Each path** leaves the texel along a cosine-weighted direction (the
 *   first stratified over the bake, rotated per texel) and bounces diffusely
 *   up to `bounces` times. Open sky gives the sky's radiance (the IBL's own
 *   panorama, F3a); a surface gives its emission, and each surface it bounces
 *   off is lit by the directional lights (a shadow ray each) and by one of the
 *   point, spot and area lights (F3d-4, below). The texel's own direct light
 *   is left out: the live cascades (F2a) and local lights draw it.
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
 *
 * And it bakes what the renderer lights (F3d-4):
 * - **Local lights' bounce.** At each surface a path bounces off, one point,
 *   spot or area light is picked by what it would give there unshadowed (with
 *   a tenth of the choice spread evenly, so none is ever unpickable), and its
 *   light, over the chance of picking it, comes through a shadow ray. With
 *   many lights that is one ray where each light's would be many, and the
 *   estimate stays unbiased.
 *   - A point or spot light falls off and narrows to its cone as the
 *     renderers' `distanceFalloff` and the shader's cone do.
 *   - An area light (F2e-2) is sampled on its surface: a point uniformly on
 *     its rectangle or disk, or on the rectangle a tube shows the point (as
 *     the LTC shader takes it, ltc.ts), as its luminance × the two cosines ×
 *     its area over π d², the renderer's units for its diffuse.
 *   - A light lights only what shares one of its lighting channels (F2e).
 * - **Metalness.** A surface bounces its albedo × (1 − metalness), as the
 *   renderer's diffuse is, plus a metal's own colour as far as it is rough: a
 *   rough metal's reflection is spread as a diffuser's is, a mirror's goes
 *   one way and is the reflection probes' (F3b) to carry.
 * - **Textured albedo** comes in with the occluders (`Occluder.surfaces`;
 *   bakeSurface.ts in @cartbox/editor), per triangle from its map.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  LIGHTMAP_RANGE,
  PROBE_DEPTH_SIDE,
  PROBE_SH,
  areaFrame,
  areaSize,
  buildBvh,
  dilateLightmapValues,
  lightChannelMask,
  lightColor,
  lightmapTexels,
  spotCone,
  stitchLightmapSeams,
  type DecodedTexture,
  type EncodedImage,
  type HdrLightmap,
  type LightmapLayout,
  type LightmapTexels,
  type MeshAsset,
  type Occluder,
  type OccluderSurface,
  type Bvh,
  type ProbeVolume,
  type SceneLight,
} from "@cartbox/editor";

import type { LinearPanorama } from "./ibl.js";
import { resolvePbr } from "./scenePacking.js";

/** The most bounces a bake takes, the most directional lights, and the most point, spot and area lights (F3d-4). */
export const LIGHTMAP_MAX_BOUNCES = 8;
export const LIGHTMAP_MAX_LIGHTS = 4;
export const LIGHTMAP_MAX_LOCAL_LIGHTS = 256;
const WORKGROUP = 64;
/** Texels a dispatch covers at most, and paths (texels × samples) a submit traces at most. */
const CHUNK_TEXELS = 65536;
const PATHS_PER_SUBMIT = 1 << 19;

/** Paths a submit traces at most with `local` point, spot and area lights, each weighed twice a bounce (F3d-4): fewer, so none nears a watchdog. */
function pathBudget(local: number): number {
  return Math.max(4096, Math.floor(PATHS_PER_SUBMIT / (1 + local / 16)));
}
const PARAMS_BYTES = 64;
/** A light's record in the tracer's storage: five vec4s (see {@link packBakeLights}). */
const LIGHT_VEC4S = 5;
/** A probe's sums: nine SH vec4s, its sky / backs / rays, and its 8 × 8 octahedral depth texels (F3d-3). */
const PROBE_ACC_VEC4S = 10 + PROBE_DEPTH_SIDE * PROBE_DEPTH_SIDE;
/** The tracer's sums per texel: four vec4s. */
const ACC_FLOATS = 16;

const STORAGE = 0x80;
const COPY_DST = 0x08;
const COPY_SRC = 0x04;
const MAP_READ = 0x01;
const UNIFORM = 0x40;

/**
 * A light the bounces are lit by: its radiance in linear light (colour ×
 * intensity; an area light's luminance) and, as a {@link SceneLight} reads
 * them, where it is and how it falls off. Without a kind it is directional,
 * `direction` toward it.
 */
export interface BakeLight extends Partial<Pick<SceneLight, "kind" | "direction" | "position" | "range" | "falloff" | "innerAngle" | "outerAngle" | "shape" | "size" | "tangent" | "channels">> {
  readonly radiance: readonly [number, number, number];
}

/** Authored colour into linear light, as the AAA shader's `toLinear` decodes it (an emissive above 1 included). */
function toLinear(c: number): number {
  const v = Math.max(0, c);
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** A rig's lights as the bake lights bounces with them: each one's linear colour (its temperature laid over it) × intensity. */
export function bakeLights(lights: readonly SceneLight[]): BakeLight[] {
  return lights.map((l) => {
    const c = lightColor(l);
    return { ...l, radiance: [toLinear(c[0]) * l.intensity, toLinear(c[1]) * l.intensity, toLinear(c[2]) * l.intensity] as [number, number, number] };
  });
}

/** Light kinds as the tracer reads a record's first w: 0 directional, 1 point, 2 spot, 3 rectangle, 4 disk, 5 tube. */
const BAKE_LIGHT_KIND = { directional: 0, point: 1, spot: 2, rect: 3, disk: 4, tube: 5 } as const;

/**
 * The lights as the tracer's storage reads them: the directional ones first
 * (at most {@link LIGHTMAP_MAX_LIGHTS}), then the point, spot and area ones (at
 * most {@link LIGHTMAP_MAX_LOCAL_LIGHTS}). Five vec4s each:
 * - the direction toward it (directional) or its position, and its kind;
 * - its radiance, and its lighting channels;
 * - its range, a spot's cone cosines (outer, inner) or an area's half width
 *   and height, and whether it falls off with the inverse square;
 * - a spot's axis or an area's facing direction;
 * - an area's tangent (its width, a tube's length).
 */
export function packBakeLights(lights: readonly BakeLight[]): { data: Float32Array; directional: number; local: number } {
  const directional = lights.filter((l) => (l.kind ?? "directional") === "directional" && l.direction).slice(0, LIGHTMAP_MAX_LIGHTS);
  const local = lights.filter((l) => l.kind !== undefined && l.kind !== "directional").slice(0, LIGHTMAP_MAX_LOCAL_LIGHTS);
  const data = new Float32Array(Math.max(1, directional.length + local.length) * LIGHT_VEC4S * 4);
  [...directional, ...local].forEach((light, i) => {
    const o = i * LIGHT_VEC4S * 4;
    const kind = light.kind ?? "directional";
    const channels = lightChannelMask(light.channels ?? 1);
    data.set([...light.radiance, channels], o + 4);
    if (kind === "directional") {
      const [x, y, z] = light.direction!;
      const len = Math.hypot(x, y, z) || 1;
      data.set([x / len, y / len, z / len, BAKE_LIGHT_KIND.directional], o);
      return;
    }
    data.set([...(light.position ?? [0, 0, 0]), kind === "area" ? BAKE_LIGHT_KIND[light.shape ?? "rect"] : BAKE_LIGHT_KIND[kind]], o);
    if (kind === "area") {
      const [w, h] = areaSize(light);
      const frame = areaFrame(light);
      // Physical by nature: its light falls as the square of the distance, unwindowed, as the LTC shader's does.
      data.set([0, w / 2, h / 2, 1], o + 8);
      data.set([...frame.normal, 0], o + 12);
      data.set([...frame.tangent, 0], o + 16);
      return;
    }
    data[o + 8] = light.range ?? 0;
    data[o + 11] = light.falloff === "inverseSquare" ? 1 : 0;
    if (kind === "spot") {
      // Its cone reads only the angles.
      const [cosOuter, cosInner] = spotCone(light as unknown as SceneLight);
      const axis = light.direction ?? [0, -1, 0];
      const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      data.set([cosOuter, cosInner], o + 9);
      data.set([axis[0] / len, axis[1] / len, axis[2] / len, 0], o + 12);
    }
  });
  return { data, directional: directional.length, local: local.length };
}

export interface GpuLightBakeOptions {
  /** Paths per texel (default 256). */
  readonly samples?: number;
  /** Diffuse bounces after the first surface a path meets (0..8, default 3): 0 is sky and emission seen directly. */
  readonly bounces?: number;
  /** The sky's radiance in linear light (`environmentPanorama`); none is a black sky. */
  readonly sky?: LinearPanorama | null;
  /** The lights that light the surfaces paths bounce off: at most four directional ones, and point, spot and area ones (F3d-4; {@link bakeLights}). */
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
  /** Per triangle two vec4s: the albedo a diffuse bounce takes (its w the triangle's lighting channels, as u32 bits) and emission, linear. */
  readonly mats: Float32Array;
  readonly triangles: number;
}

/**
 * A mesh's surfaces as the bake reads them (F3d-4; `Occluder.surfaces`): each
 * primitive's base-colour and metal/roughness maps, decoded by `decode` (null
 * where it can't; `data` asks for the pixels as stored, a data map's), and its
 * metalness and roughness as the renderer resolves them (no metalness on a
 * material the renderer doesn't shade as PBR).
 */
export async function bakeSurfaces(mesh: MeshAsset, decode: (image: EncodedImage, data: boolean) => Promise<DecodedTexture | null>): Promise<OccluderSurface[]> {
  const read = (image: EncodedImage | null | undefined, data: boolean) => (image && image.bytes.length > 0 ? decode(image, data).catch(() => null) : Promise.resolve(null));
  return Promise.all(
    mesh.primitives.map(async ({ material: m }) => {
      const [base, metallicRoughness] = await Promise.all([read(m.baseColorImage, false), read(m.metallicRoughnessImage, true)]);
      const pbr = resolvePbr(m, metallicRoughness !== null, !!m.occlusionImage, !!m.emissiveImage);
      return { base, metallicRoughness, metallic: pbr.isPbr ? pbr.metallic : 0, roughness: pbr.roughness };
    }),
  );
}

/** A BVH's nodes as the tracers read them (see {@link PackedLightmapScene.nodes}); shared with the path-traced reference (F10b). */
export function packBvhNodes(bvh: Bvh): Uint32Array {
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
  return nodes;
}

/** Flatten the occluders' BVH into the tracer's buffers. */
export function packLightmapScene(occluders: readonly Occluder[]): PackedLightmapScene {
  const bvh = buildBvh(occluders);
  const triangles = bvh.order.length;
  const nodes = packBvhNodes(bvh);
  const tris = new Float32Array(Math.max(1, triangles) * 12);
  const mats = new Float32Array(Math.max(1, triangles) * 8);
  const matBits = new Uint32Array(mats.buffer);
  for (let i = 0; i < triangles; i += 1) {
    const t = bvh.order[i]!;
    const k = t * 9;
    // The share of its albedo a diffuse bounce takes (F3d-4): the renderer's diffuse, and a metal's colour as far as it is rough.
    const metal = Math.min(1, Math.max(0, bvh.mr[t * 2]!));
    const bounce = 1 - metal + metal * Math.min(1, Math.max(0, bvh.mr[t * 2 + 1]!));
    for (let a = 0; a < 3; a += 1) {
      tris[i * 12 + a * 4 + 3] = bvh.front[t * 3 + a]!;
      tris[i * 12 + a] = bvh.tri[k + a]!;
      tris[i * 12 + 4 + a] = bvh.tri[k + 3 + a]! - bvh.tri[k + a]!;
      tris[i * 12 + 8 + a] = bvh.tri[k + 6 + a]! - bvh.tri[k + a]!;
      mats[i * 8 + a] = toLinear(bvh.col[t * 3 + a]!) * bounce;
      mats[i * 8 + 4 + a] = toLinear(bvh.emi[t * 3 + a]!);
    }
    matBits[i * 8 + 3] = bvh.channels[t]!;
  }
  return { nodes, tris, mats, triangles };
}

/**
 * The tracers' shared sampling WGSL (F3d, and the path-traced reference, F10b):
 * the random numbers, a cosine-weighted direction, the sky panorama's radiance
 * (bound as `sky`, its size in `params.info.zw`), and the packed
 * lights' falloff, weighting and sampling (bound as `lights`, {@link packBakeLights}).
 */
export const BAKE_SAMPLING_WGSL = /* wgsl */ `
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

// A unit direction's octahedral texel (probeVolume.ts's octTexel).
fn octTexel(d: vec3<f32>) -> u32 {
  var e = d.xz / (abs(d.x) + abs(d.y) + abs(d.z));
  if (d.y < 0.0) { e = (vec2<f32>(1.0) - abs(e.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), e >= vec2<f32>(0.0)); }
  let uv = e * 0.5 + vec2<f32>(0.5);
  let x = min(u32(uv.x * ${PROBE_DEPTH_SIDE}.0), ${PROBE_DEPTH_SIDE - 1}u);
  let y = min(u32(uv.y * ${PROBE_DEPTH_SIDE}.0), ${PROBE_DEPTH_SIDE - 1}u);
  return y * ${PROBE_DEPTH_SIDE}u + x;
}

// A light's record (packBakeLights): five vec4s from its first.
fn lightAt(l: u32, k: u32) -> vec4<f32> {
  return lights[l * ${LIGHT_VEC4S}u + k];
}

// Whether light l lights a surface on the channels \`mask\` (F2e).
fn lightsMask(l: u32, mask: u32) -> bool {
  return (u32(lightAt(l, 1u).w + 0.5) & mask) != 0u;
}

// A point or spot light's falloff toward a point d away along Ld (the renderers' distanceFalloff, and the shader's cone).
fn punctualAtten(l: u32, d: f32, Ld: vec3<f32>) -> f32 {
  let r = lightAt(l, 2u);
  var atten = 1.0;
  if (r.w > 0.5) {
    var win = 1.0;
    if (r.x > 0.0) { let q = d / r.x; let t = clamp(1.0 - q * q * q * q, 0.0, 1.0); win = t * t; }
    let dm = max(d, 0.01);
    atten = win / (dm * dm);
  } else if (r.x > 0.0) {
    let t = max(0.0, 1.0 - d / r.x);
    atten = t * t;
  }
  if (lightAt(l, 0u).w > 1.5) {
    let ct = clamp((-dot(Ld, lightAt(l, 3u).xyz) - r.y) / (r.z - r.y), 0.0, 1.0);
    atten = atten * ct * ct * (3.0 - 2.0 * ct);
  }
  return atten;
}

// What local light l would give a surface at p facing n, unshadowed, by luminance: how likely it is to be picked.
// An area light is taken as the point at its centre it is from far off.
fn localWeight(l: u32, p: vec3<f32>, n: vec3<f32>, mask: u32) -> f32 {
  if (!lightsMask(l, mask)) { return 0.0; }
  let a = lightAt(l, 0u);
  let toL = a.xyz - p;
  let d = max(length(toL), 1e-4);
  let Ld = toL / d;
  let ndl = max(dot(n, Ld), 0.0);
  let power = lum(lightAt(l, 1u).rgb);
  if (a.w < 2.5) { return power * punctualAtten(l, d, Ld) * ndl; }
  let r = lightAt(l, 2u);
  var area = 4.0 * r.y * r.z;
  var facing = 1.0;
  if (a.w > 4.5) { area = 2.0 * r.y * 2.0 * r.z + PI * r.z * r.z; }
  else {
    facing = max(-dot(Ld, lightAt(l, 3u).xyz), 0.0);
    if (a.w > 3.5) { area = PI * r.y * r.y; }
  }
  let dm = max(d, 0.1);
  return power * area * facing * max(ndl, 0.05) / (PI * dm * dm);
}

struct LightSample {
  c: vec3<f32>,  // what it gives the surface, unshadowed
  dir: vec3<f32>,
  dist: f32,
};

// Local light l's light on a surface at p facing n: a point or spot light's, or an area light's through one point
// on it (uniform on its rectangle or disk, or on the rectangle a tube shows p, as the LTC shader takes it).
fn localSample(l: u32, p: vec3<f32>, n: vec3<f32>) -> LightSample {
  var out = LightSample(vec3<f32>(0.0), vec3<f32>(0.0, 1.0, 0.0), 0.0);
  let a = lightAt(l, 0u);
  let rad = lightAt(l, 1u).rgb;
  if (a.w < 2.5) {
    let toL = a.xyz - p;
    let d = max(length(toL), 1e-4);
    out.dir = toL / d;
    out.dist = d;
    out.c = rad * punctualAtten(l, d, out.dir) * max(dot(n, out.dir), 0.0);
    return out;
  }
  let r = lightAt(l, 2u);
  let tan = lightAt(l, 4u).xyz;
  var nrm = lightAt(l, 3u).xyz;
  var hw = r.y;
  let hh = r.z;
  let toP = p - a.xyz;
  if (a.w > 4.5) {
    let off = toP - tan * dot(toP, tan);
    nrm = select(normalize(cross(tan, select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(tan.y) < 0.9))), normalize(off), length(off) > 1e-5);
    hw = hw + 0.78539816 * hh;
  } else if (dot(toP, nrm) <= 0.0) {
    return out;
  }
  let bt = cross(nrm, tan);
  let xi = vec2<f32>(rand(), rand());
  var s: vec3<f32>;
  var area: f32;
  if (a.w > 3.5 && a.w < 4.5) {
    let rr = hw * sqrt(xi.x);
    let phi = 2.0 * PI * xi.y;
    s = a.xyz + tan * (rr * cos(phi)) + bt * (rr * sin(phi));
    area = PI * hw * hw;
  } else {
    s = a.xyz + tan * (hw * (2.0 * xi.x - 1.0)) + bt * (hh * (2.0 * xi.y - 1.0));
    area = 4.0 * hw * hh;
  }
  let toS = s - p;
  let d = max(length(toS), 1e-4);
  out.dir = toS / d;
  out.dist = d;
  let cosS = dot(n, out.dir);
  let cosL = -dot(out.dir, nrm);
  if (cosS > 0.0 && cosL > 0.0) { out.c = rad * (cosS * cosL * area / (PI * max(d * d, 1e-4))); }
  return out;
}
`;

export const LIGHTMAP_TRACE_WGSL = /* wgsl */ `
struct Params {
  run: vec4<u32>,   // x = first texel, y = texels, z = first sample, w = samples this pass
  info: vec4<u32>,  // x = bounces, y = directional lights, z = sky width, w = sky height
  total: vec4<u32>, // x = samples in all, y = point, spot and area lights (F3d-4)
  extra: vec4<f32>, // x = a probe's depth cap (F3d-3)
};
@group(0) @binding(0) var<storage, read> nodes: array<vec4<u32>>;
@group(0) @binding(1) var<storage, read> tris: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> mats: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> texels: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> accum: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> sky: array<vec4<f32>>;
@group(0) @binding(6) var<uniform> params: Params;
@group(0) @binding(7) var<storage, read> lights: array<vec4<f32>>;

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

${BAKE_SAMPLING_WGSL}
// The lights on a surface a path bounced off at p, facing n, on the channels \`mask\`: every directional light, and one
// local light picked by localWeight (a tenth of the choice spread evenly), over the chance of picking it.
fn lightsOn(p: vec3<f32>, n: vec3<f32>, mask: u32) -> vec3<f32> {
  var L = vec3<f32>(0.0);
  let directional = params.info.y;
  for (var l = 0u; l < directional; l = l + 1u) {
    if (!lightsMask(l, mask)) { continue; }
    let Ld = lightAt(l, 0u).xyz;
    let ndl = dot(n, Ld);
    if (ndl > 0.0 && trace(p, Ld, FAR, true).tri < 0) {
      L = L + lightAt(l, 1u).rgb * ndl;
    }
  }
  let local = params.total.y;
  if (local == 0u) { return L; }
  var total = 0.0;
  for (var k = 0u; k < local; k = k + 1u) { total = total + localWeight(directional + k, p, n, mask); }
  let even = select(1.0, 0.1, total > 0.0) / f32(local);
  let spread = select(0.0, 0.9 / total, total > 0.0);
  let u = rand();
  var pick = local - 1u;
  var pdf = 0.0;
  var cdf = 0.0;
  for (var k = 0u; k < local; k = k + 1u) {
    pdf = localWeight(directional + k, p, n, mask) * spread + even;
    cdf = cdf + pdf;
    if (u < cdf) { pick = k; break; }
  }
  if (pick == local - 1u) { pdf = localWeight(directional + pick, p, n, mask) * spread + even; }
  let l = directional + pick;
  if (!lightsMask(l, mask)) { return L; }
  let ls = localSample(l, p, n);
  if (max(ls.c.r, max(ls.c.g, ls.c.b)) > 0.0 && trace(p, ls.dir, ls.dist - EPS, true).tri < 0) {
    L = L + ls.c / pdf;
  }
  return L;
}

struct Path {
  L: vec3<f32>,
  // The first segment's hit distance (FAR when it reached the sky), and whether it met the back of a surface (F3d-2).
  t: f32,
  back: bool,
};

// What a path from o along d brings back: the sky on a miss; on a hit, the surface's emission, and (while
// bounces remain) the lights on it and what a cosine-weighted bounce off it gathers.
fn pathFrom(origin: vec3<f32>, dir: vec3<f32>) -> Path {
  let bounces = params.info.x;
  var out = Path(vec3<f32>(0.0), FAR, false);
  var tp = vec3<f32>(1.0);
  var o = origin;
  var d = dir;
  for (var b = 0u; b <= bounces; b = b + 1u) {
    let h = trace(o, d, FAR, false);
    if (h.tri < 0) {
      out.L = out.L + tp * skyAt(d);
      break;
    }
    let i = u32(h.tri);
    if (b == 0u) {
      out.t = h.t;
      out.back = dot(d, vec3<f32>(tris[i * 3u].w, tris[i * 3u + 1u].w, tris[i * 3u + 2u].w)) > 0.0;
    }
    out.L = out.L + tp * mats[i * 2u + 1u].rgb;
    if (b == bounces) { break; }
    var n = normalize(cross(tris[i * 3u + 1u].xyz, tris[i * 3u + 2u].xyz));
    if (dot(n, d) > 0.0) { n = -n; } // the side the path arrived on (surfaces are two-sided)
    let hp = o + d * h.t + n * EPS;
    tp = tp * mats[i * 2u].rgb;
    out.L = out.L + tp * lightsOn(hp, n, bitcast<u32>(mats[i * 2u].w));
    if (max(tp.r, max(tp.g, tp.b)) < 1e-4) { break; }
    o = hp;
    d = cosineDir(n, vec2<f32>(rand(), rand()));
  }
  return out;
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.run.y) { return; }
  let j = params.run.x + id.x;
  let P = texels[j * 2u].xyz;
  let Ng = normalize(texels[j * 2u + 1u].xyz);
  // The first bounce's directions: one stratified set for the bake, turned per texel (Cranley–Patterson).
  let turn = vec2<f32>(f32(pcg(j * 2u + 1u) >> 8u), f32(pcg(j * 2u + 2u) >> 8u)) / 16777216.0;
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
    let path = pathFrom(P + Ng * EPS, d0);
    if (path.t >= FAR) { skyOpen = skyOpen + lum(sky0); }
    if (path.back) { backs = backs + 1.0; }
    e = e + path.L;
    let y = lum(path.L);
    dirSum = dirSum + d0 * y;
    lumSum = lumSum + y;
    lumSq = lumSq + y * y;
  }
  accum[j * 4u] = accum[j * 4u] + vec4<f32>(e, 0.0);
  accum[j * 4u + 1u] = accum[j * 4u + 1u] + vec4<f32>(dirSum, lumSum);
  accum[j * 4u + 2u] = accum[j * 4u + 2u] + vec4<f32>(skyRef, skyOpen);
  accum[j * 4u + 3u] = accum[j * 4u + 3u] + vec4<f32>(lumSq, backs, 0.0, 0.0);
}

// A probe (F3d-3): rays over the whole sphere (a Fibonacci set for the bake, turned per probe about the
// vertical), projected onto L2 SH; the sky's share; backs met; and per octahedral texel the distance the
// first segment travelled (capped), with its square.
@compute @workgroup_size(${WORKGROUP})
fn probeMain(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.run.y) { return; }
  let p = params.run.x + id.x;
  let P = texels[p].xyz;
  let total = params.total.x;
  let reach = params.extra.x;
  let turn = f32(pcg(p * 2u + 11u) >> 8u) / 16777216.0 * 2.0 * PI;
  var sh = array<vec3<f32>, 9>();
  var skyRef = 0.0;
  var skyOpen = 0.0;
  var backs = 0.0;
  let base = p * ${PROBE_ACC_VEC4S}u;
  for (var k = 0u; k < params.run.w; k = k + 1u) {
    let s = params.run.z + k;
    rng = pcg(p ^ pcg(s + 0x85ebca6bu));
    let y = 1.0 - (2.0 * f32(s) + 1.0) / f32(total);
    let r = sqrt(max(0.0, 1.0 - y * y));
    let phi = f32(s) * 2.39996323 + turn;
    let d = vec3<f32>(r * cos(phi), y, r * sin(phi));
    let path = pathFrom(P, d);
    let L = path.L;
    sh[0] = sh[0] + L * 0.282095;
    sh[1] = sh[1] + L * (0.488603 * d.y);
    sh[2] = sh[2] + L * (0.488603 * d.z);
    sh[3] = sh[3] + L * (0.488603 * d.x);
    sh[4] = sh[4] + L * (1.092548 * d.x * d.y);
    sh[5] = sh[5] + L * (1.092548 * d.y * d.z);
    sh[6] = sh[6] + L * (0.315392 * (3.0 * d.z * d.z - 1.0));
    sh[7] = sh[7] + L * (1.092548 * d.x * d.z);
    sh[8] = sh[8] + L * (0.546274 * (d.x * d.x - d.y * d.y));
    let sl = lum(skyAt(d));
    skyRef = skyRef + sl;
    if (path.t >= FAR) { skyOpen = skyOpen + sl; }
    if (path.back) { backs = backs + 1.0; }
    let t = min(path.t, reach);
    let texel = octTexel(d);
    accum[base + 10u + texel] = accum[base + 10u + texel] + vec4<f32>(t, t * t, 1.0, 0.0);
  }
  for (var c = 0u; c < 9u; c = c + 1u) { accum[base + c] = accum[base + c] + vec4<f32>(sh[c], 0.0); }
  accum[base + 9u] = accum[base + 9u] + vec4<f32>(skyRef, skyOpen, backs, f32(params.run.w));
}
`;

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The tracer's parameters for one dispatch; `lights` counts the packed lights ({@link packBakeLights}). */
export function lightmapParams(first: number, texels: number, firstSample: number, samples: number, total: number, bounces: number, sky: LinearPanorama | null, lights: { readonly directional: number; readonly local: number }, reach = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(PARAMS_BYTES);
  new Uint32Array(buffer).set([first, texels, firstSample, samples, bounces, lights.directional, sky?.width ?? 0, sky?.height ?? 0, total, lights.local], 0);
  new Float32Array(buffer)[12] = reach;
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
  const lights = packBakeLights(options.lights ?? []);
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
    const lightBuffer = upload(lights.data);
    const params = device.createBuffer({ size: PARAMS_BYTES, usage: UNIFORM | COPY_DST });
    const readback = device.createBuffer({ size: acc.byteLength, usage: MAP_READ | COPY_DST });
    try {
      const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: LIGHTMAP_TRACE_WGSL }), entryPoint: "main" } });
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [...buffers, accum, skyBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })).concat([{ binding: 6, resource: { buffer: params } }, { binding: 7, resource: { buffer: lightBuffer } }]),
      });
      const budget = pathBudget(lights.local);
      const chunk = Math.min(count, CHUNK_TEXELS, budget);
      const perPass = Math.max(1, Math.min(samples, Math.floor(budget / chunk)));
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
      for (const buffer of [...buffers, accum, skyBuffer, lightBuffer, params, readback]) buffer.destroy();
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

// --- Probe volumes (F3d-3) --------------------------------------------------------

/** The clamped cosine's SH bands over π (ibl.ts's COSINE_BANDS): the SH of radiance into irradiance over π. */
const COSINE_BANDS = [1, 2 / 3, 2 / 3, 2 / 3, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4];

export interface ProbeVolumeBakeOptions extends Pick<GpuLightBakeOptions, "bounces" | "sky" | "lights" | "backfaceLimit"> {
  /** Rays per probe (default 1024). */
  readonly rays?: number;
}

/**
 * Bake a probe volume over `counts` probes spanning `min`–`max` against
 * `occluders` on `device` (see probeVolume.ts): each probe's rays over the
 * whole sphere, through the same paths as a light map's texels. A probe's
 * depths are capped at 1.5 times the probe spacing, as DDGI's are.
 */
export async function bakeProbeVolumeGpu(
  device: any,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  counts: readonly [number, number, number],
  occluders: readonly Occluder[],
  options: ProbeVolumeBakeOptions = {},
  progress?: (done: number) => void,
): Promise<ProbeVolume> {
  const rays = Math.max(16, Math.round(options.rays ?? 1024));
  const bounces = Math.max(0, Math.min(LIGHTMAP_MAX_BOUNCES, Math.round(options.bounces ?? 3)));
  const sky = options.sky ?? null;
  const lights = packBakeLights(options.lights ?? []);
  const [cx, cy, cz] = counts;
  const count = cx * cy * cz;
  const spacing = [0, 1, 2].map((a) => (max[a]! - min[a]!) / Math.max(1, counts[a]! - 1));
  const reach = 1.5 * Math.max(...spacing, 1e-3);
  const positions = new Float32Array(count * 4);
  for (let z = 0; z < cz; z += 1) for (let y = 0; y < cy; y += 1) for (let x = 0; x < cx; x += 1) {
    const p = (z * cy + y) * cx + x;
    positions.set([min[0] + x * spacing[0]!, min[1] + y * spacing[1]!, min[2] + z * spacing[2]!, 1], p * 4);
  }
  const acc = new Float32Array(count * PROBE_ACC_VEC4S * 4);
  const scene = packLightmapScene(occluders);
  const upload = (data: ArrayBufferView) => {
    const buffer = device.createBuffer({ size: Math.max(16, data.byteLength), usage: STORAGE | COPY_DST });
    device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
    return buffer;
  };
  const buffers = [upload(scene.nodes), upload(scene.tris), upload(scene.mats), upload(positions)];
  const accum = device.createBuffer({ size: acc.byteLength, usage: STORAGE | COPY_SRC });
  const skyBuffer = upload(sky ? sky.data : new Float32Array(4));
  const lightBuffer = upload(lights.data);
  const params = device.createBuffer({ size: PARAMS_BYTES, usage: UNIFORM | COPY_DST });
  const readback = device.createBuffer({ size: acc.byteLength, usage: MAP_READ | COPY_DST });
  try {
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: LIGHTMAP_TRACE_WGSL }), entryPoint: "probeMain" } });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [...buffers, accum, skyBuffer].map((buffer, binding) => ({ binding, resource: { buffer } })).concat([{ binding: 6, resource: { buffer: params } }, { binding: 7, resource: { buffer: lightBuffer } }]),
    });
    const perPass = Math.max(1, Math.min(rays, Math.floor(pathBudget(lights.local) / count)));
    const submits = Math.ceil(rays / perPass);
    for (let s = 0, done = 0; s < rays; s += perPass) {
      device.queue.writeBuffer(params, 0, lightmapParams(0, count, s, Math.min(perPass, rays - s), rays, bounces, sky, lights, reach));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP));
      pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      done += 1;
      progress?.(done / submits);
    }
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(accum, 0, readback, 0, acc.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(MAP_READ);
    acc.set(new Float32Array(readback.getMappedRange()));
    readback.unmap();
  } finally {
    for (const buffer of [...buffers, accum, skyBuffer, lightBuffer, params, readback]) buffer.destroy();
  }
  return finishProbeVolume(min, max, counts, acc, reach, options.backfaceLimit ?? 0.6);
}

/** A probe volume from the tracer's sums (see {@link bakeProbeVolumeGpu}). */
export function finishProbeVolume(min: readonly [number, number, number], max: readonly [number, number, number], counts: readonly [number, number, number], acc: Float32Array, reach: number, backfaceLimit: number): ProbeVolume {
  const count = counts[0] * counts[1] * counts[2];
  const depthTexels = PROBE_DEPTH_SIDE * PROBE_DEPTH_SIDE;
  const sh = new Float32Array(count * PROBE_SH * 3);
  const visibility = new Float32Array(count);
  const valid = new Uint8Array(count);
  const depth = new Float32Array(count * depthTexels * 2);
  for (let p = 0; p < count; p += 1) {
    const o = p * PROBE_ACC_VEC4S * 4;
    const rays = acc[o + 39]!;
    valid[p] = rays > 0 && acc[o + 38]! <= backfaceLimit * rays ? 1 : 0;
    visibility[p] = acc[o + 36]! > 1e-12 ? Math.min(1, acc[o + 37]! / acc[o + 36]!) : 1;
    // Each ray stands for 4π / rays of the sphere; the cosine's bands make it irradiance over π.
    if (valid[p]) for (let k = 0; k < PROBE_SH; k += 1) for (let c = 0; c < 3; c += 1) sh[(p * PROBE_SH + k) * 3 + c] = ((acc[o + k * 4 + c]! * 4 * Math.PI) / rays) * COSINE_BANDS[k]!;
    for (let t = 0; t < depthTexels; t += 1) {
      const d = o + (10 + t) * 4;
      const n = acc[d + 2]!;
      // A texel no ray fell in reads as open to the cap.
      depth[(p * depthTexels + t) * 2] = n > 0 ? acc[d]! / n : reach;
      depth[(p * depthTexels + t) * 2 + 1] = n > 0 ? acc[d + 1]! / n : reach * reach;
    }
  }
  return { min, max, counts, sh, visibility, valid, depth };
}
