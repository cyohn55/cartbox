/**
 * Real-time global illumination on the AAA tier (AAA_FIDELITY_ROADMAP.md
 * F3e): DDGI (Majercik et al. 2019) over the probe volume the scene shader
 * already lights by (F3d-3), traced every frame in compute with the GPU
 * lightmapper's own BVH tracer (gpuLightmapper.ts), so moving lights, a time
 * of day and a cart's sun bounce without a bake.
 *
 * - **Trace** (a thread a ray): each probe casts its rays over the sphere, a
 *   Fibonacci set turned by a fresh random rotation each frame. A miss takes
 *   the sky; a hit takes its emission, and its albedo × the light on it —
 *   the lights (directional ones through a shadow ray, one local light picked
 *   by what it would give, as the bake picks it) and the volume's own
 *   irradiance there, which is how light bounces again each frame. A hit on a
 *   surface's back is dark and counted, and its distance shortened, so light
 *   doesn't leak through walls.
 * - **Update** (a thread a probe's slot): the rays projected onto L2 SH
 *   (irradiance over π, as the bake's), the probe's validity (most rays on
 *   backs: inside something) and its sky visibility, and per octahedral texel
 *   the mean distance and its square; each blended into what the probe held
 *   by the hysteresis, in the same buffer the scene samples (its layout:
 *   probeVolumeTexels in @cartbox/editor).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { PROBE_NORMAL_BIAS, PROBE_SH, PROBE_VOLUME_SLOTS, type DynamicGi, type Occluder, type ProbeVolume, type SceneLight } from "@cartbox/editor";

import { LIGHTMAP_TRACE_WGSL, bakeLights, lightmapParams, packBakeLights, packLightmapScene } from "./gpuLightmapper.js";
import type { LinearPanorama } from "./ibl.js";

/** Floats in the GI passes' uniform block. */
export const GI_UNIFORM_FLOATS = 32;
/** A probe's rays' depth is capped at this many spacings, as the bake caps it. */
const GI_REACH = 1.5;
/** A probe whose rays meet more backs than this share is taken as inside something (the bake's limit). */
const GI_BACKFACE_LIMIT = 0.6;

const STORAGE = 0x80;
const COPY_DST = 0x08;
const UNIFORM = 0x40;

/** A rotation of the sphere drawn uniformly at random (Shoemake's quaternion), as three row vectors. */
export function randomRotation(u1: number, u2: number, u3: number): [number, number, number][] {
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  const [x, y, z, w] = [a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2), b * Math.sin(2 * Math.PI * u3), b * Math.cos(2 * Math.PI * u3)];
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** The probes' spacing per axis, and the distance their depths are capped at. */
export function giSpacing(volume: Pick<ProbeVolume, "min" | "max" | "counts">): { spacing: number[]; reach: number } {
  const spacing = [0, 1, 2].map((a) => (volume.max[a]! - volume.min[a]!) / Math.max(1, volume.counts[a]! - 1) || 1);
  return { spacing, reach: GI_REACH * Math.max(...spacing) };
}

/**
 * The GI passes' uniforms: the volume's corner (w the rays a probe casts),
 * its grid units per metre (w the hysteresis), its counts (w its slots),
 * this frame's rotation (row 0's w its seed), the depth cap, the backface
 * limit, and whether the volume yet lights what the rays hit.
 */
export function packGiUniforms(volume: Pick<ProbeVolume, "min" | "max" | "counts">, gi: DynamicGi, rotation: readonly (readonly number[])[], seed: number, bounce: boolean, out = new Float32Array(GI_UNIFORM_FLOATS)): Float32Array {
  const { spacing, reach } = giSpacing(volume);
  out.set([...volume.min, gi.rays], 0);
  out.set([...spacing.map((s) => 1 / s), gi.hysteresis], 4);
  out.set([...volume.counts, PROBE_VOLUME_SLOTS], 8);
  out.set([...rotation[0]!, seed], 12);
  out.set([...rotation[1]!, 0], 16);
  out.set([...rotation[2]!, 0], 20);
  out.set([reach, GI_BACKFACE_LIMIT, bounce ? 1 : 0, PROBE_NORMAL_BIAS * Math.min(...spacing)], 24);
  return out;
}

/** The GI kernels, beside the lightmapper's tracer, lights and sky they share. */
export const GI_WGSL = /* wgsl */ `
${LIGHTMAP_TRACE_WGSL}
struct Gi {
  min: vec4<f32>,    // w: rays a probe
  scale: vec4<f32>,  // grid units per metre, w: hysteresis
  counts: vec4<f32>, // w: slots a probe
  rot0: vec4<f32>,   // this frame's rotation, row by row; rot0.w its seed
  rot1: vec4<f32>,
  rot2: vec4<f32>,
  info: vec4<f32>,   // the depth cap, the backface limit, 1 when the volume lights hits, the normal bias
};
@group(0) @binding(8) var<storage, read_write> probeData: array<vec4<f32>>;
@group(0) @binding(9) var<uniform> gi: Gi;
@group(0) @binding(10) var<storage, read_write> giRays: array<vec4<f32>>;

fn giCount() -> vec3<u32> { return vec3<u32>(gi.counts.xyz + vec3<f32>(0.5)); }
fn giSlot(slot: u32, i: vec3<u32>) -> u32 {
  let n = giCount();
  return (i.z * n.y + i.y) * (${PROBE_VOLUME_SLOTS}u * n.x) + slot * n.x + i.x;
}
fn giProbe(p: u32) -> vec3<u32> {
  let n = giCount();
  return vec3<u32>(p % n.x, (p / n.x) % n.y, p / (n.x * n.y));
}
fn giAt(i: vec3<u32>) -> vec3<f32> { return gi.min.xyz + vec3<f32>(i) / gi.scale.xyz; }

// The volume's irradiance (over π) at P with normal N (the scene shader's probeVolumeAt): the eight probes
// round it, trilinear, by a wrapped cosine toward each and Chebyshev's bound on each seeing P.
fn giIrradiance(P: vec3<f32>, N: vec3<f32>) -> vec3<f32> {
  let n = vec3<f32>(giCount());
  let Pb = P + N * gi.info.w;
  let g = clamp((Pb - gi.min.xyz) * gi.scale.xyz, vec3<f32>(0.0), n - vec3<f32>(1.0));
  let i0 = min(vec3<u32>(floor(g)), vec3<u32>(n) - vec3<u32>(2u));
  let f = g - vec3<f32>(i0);
  var sum = vec3<f32>(0.0);
  var wsum = 0.0;
  for (var c = 0u; c < 8u; c = c + 1u) {
    let o = vec3<u32>(c & 1u, (c >> 1u) & 1u, (c >> 2u) & 1u);
    let i = i0 + o;
    let s0 = probeData[giSlot(0u, i)];
    if (s0.w < 0.5) { continue; }
    let tri = select(vec3<f32>(1.0) - f, f, o == vec3<u32>(1u));
    let at = giAt(i);
    let to = at - P;
    let wrap = (dot(to, N) / max(length(to), 1e-6) + 1.0) * 0.5;
    var w = wrap * wrap + 0.2;
    let off = Pb - at;
    let dist = length(off);
    if (dist > 1e-4) {
      let k = octTexel(off / dist);
      let pair = probeData[giSlot(${PROBE_SH}u + k / 2u, i)];
      let m = select(pair.xy, pair.zw, (k & 1u) == 1u);
      if (dist > m.x) {
        let variance = max(m.y - m.x * m.x, 1e-4);
        let cheb = variance / (variance + (dist - m.x) * (dist - m.x));
        w = w * cheb * cheb * cheb;
      }
    }
    w = w * tri.x * tri.y * tri.z;
    if (w <= 1e-6) { continue; }
    let e = s0.xyz * 0.282095
      + (probeData[giSlot(1u, i)].xyz * N.y + probeData[giSlot(2u, i)].xyz * N.z + probeData[giSlot(3u, i)].xyz * N.x) * 0.488603
      + (probeData[giSlot(4u, i)].xyz * (N.x * N.y) + probeData[giSlot(5u, i)].xyz * (N.y * N.z) + probeData[giSlot(7u, i)].xyz * (N.x * N.z)) * 1.092548
      + probeData[giSlot(6u, i)].xyz * (0.315392 * (3.0 * N.z * N.z - 1.0))
      + probeData[giSlot(8u, i)].xyz * (0.546274 * (N.x * N.x - N.y * N.y));
    sum = sum + max(e, vec3<f32>(0.0)) * w;
    wsum = wsum + w;
  }
  return select(vec3<f32>(0.0), sum / wsum, wsum > 0.0);
}

fn giRay(r: u32, rays: u32) -> vec3<f32> {
  let y = 1.0 - (2.0 * f32(r) + 1.0) / f32(rays);
  let rr = sqrt(max(0.0, 1.0 - y * y));
  let phi = f32(r) * 2.39996323;
  let d = vec3<f32>(rr * cos(phi), y, rr * sin(phi));
  return vec3<f32>(dot(gi.rot0.xyz, d), dot(gi.rot1.xyz, d), dot(gi.rot2.xyz, d));
}

@compute @workgroup_size(64)
fn giTrace(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = giCount();
  let rays = u32(gi.min.w + 0.5);
  let p = id.x / rays;
  if (p >= n.x * n.y * n.z) { return; }
  let r = id.x % rays;
  rng = pcg(id.x ^ pcg(u32(gi.rot0.w)));
  let P = giAt(giProbe(p));
  let d = giRay(r, rays);
  let h = trace(P, d, FAR, false);
  var L = vec3<f32>(0.0);
  var t = FAR;
  var back = 0.0;
  if (h.tri < 0) {
    L = skyAt(d);
  } else {
    let i = u32(h.tri);
    t = h.t;
    if (dot(d, vec3<f32>(tris[i * 3u].w, tris[i * 3u + 1u].w, tris[i * 3u + 2u].w)) > 0.0) {
      // Inside something: dark, and nearer than it is, so the probe's visibility keeps the light out.
      back = 1.0;
      t = t * 0.2;
    } else {
      var nrm = normalize(cross(tris[i * 3u + 1u].xyz, tris[i * 3u + 2u].xyz));
      if (dot(nrm, d) > 0.0) { nrm = -nrm; }
      let hp = P + d * h.t + nrm * EPS;
      var light = lightsOn(hp, nrm, bitcast<u32>(mats[i * 2u].w));
      if (gi.info.z > 0.5) { light = light + giIrradiance(hp, nrm); }
      L = mats[i * 2u + 1u].rgb + mats[i * 2u].rgb * light;
    }
  }
  giRays[id.x * 2u] = vec4<f32>(L, t);
  giRays[id.x * 2u + 1u] = vec4<f32>(d, back);
}

// --- Reflections the screen can't show (F3f, Epic), traced at half resolution ---
struct ReflectFrame {
  invViewProj: mat4x4<f32>, // clip → world, as drawn
  eye: vec4<f32>,           // w: this frame's seed
  info: vec4<f32>,          // the frame's full width and height, 1 when the volume lights hits, the roughness limit
};
@group(0) @binding(11) var<uniform> rf: ReflectFrame;
@group(0) @binding(12) var reflectDepth: texture_2d<f32>;
@group(0) @binding(13) var reflectGbuffer: texture_2d<f32>;
@group(0) @binding(14) var reflectOut: texture_storage_2d<rgba16float, write>;

fn reflectOct(e: vec2<f32>) -> vec3<f32> {
  var n = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x = n.x + select(t, -t, n.x >= 0.0);
  n.y = n.y + select(t, -t, n.y >= 0.0);
  return normalize(n);
}

// GGX's visible normals (Heitz 2018), in the frame where the normal is +z.
fn reflectVndf(Ve: vec3<f32>, alpha: f32, u1: f32, u2: f32) -> vec3<f32> {
  let Vh = normalize(vec3<f32>(alpha * Ve.x, alpha * Ve.y, Ve.z));
  let lensq = Vh.x * Vh.x + Vh.y * Vh.y;
  let T1 = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-Vh.y, Vh.x, 0.0) / sqrt(max(lensq, 1e-12)), lensq > 1e-12);
  let T2 = cross(Vh, T1);
  let r = sqrt(u1);
  let phi = 6.2831853 * u2;
  let t1 = r * cos(phi);
  let s = 0.5 * (1.0 + Vh.z);
  let t2 = (1.0 - s) * sqrt(max(0.0, 1.0 - t1 * t1)) + s * (r * sin(phi));
  let Nh = t1 * T1 + t2 * T2 + sqrt(max(0.0, 1.0 - t1 * t1 - t2 * t2)) * Vh;
  return normalize(vec3<f32>(alpha * Nh.x, alpha * Nh.y, max(0.0, Nh.z)));
}

@compute @workgroup_size(8, 8)
fn giReflect(@builtin(global_invocation_id) id: vec3<u32>) {
  let out = vec2<i32>(textureDimensions(reflectOut));
  if (i32(id.x) >= out.x || i32(id.y) >= out.y) { return; }
  let full = vec2<i32>(i32(rf.info.x), i32(rf.info.y));
  let p = min(vec2<i32>(id.xy) * 2, full - 1);
  let z = textureLoad(reflectDepth, p, 0).r;
  let g = textureLoad(reflectGbuffer, p, 0);
  if (z >= 1.0 || g.z > rf.info.w) { textureStore(reflectOut, vec2<i32>(id.xy), vec4<f32>(0.0)); return; }
  rng = pcg((id.y * 4096u + id.x) ^ pcg(u32(rf.eye.w)));
  let ndc = vec2<f32>((f32(p.x) + 0.5) / f32(full.x) * 2.0 - 1.0, 1.0 - (f32(p.y) + 0.5) / f32(full.y) * 2.0);
  let w = rf.invViewProj * vec4<f32>(ndc, z, 1.0);
  let P = w.xyz / w.w;
  let V = normalize(rf.eye.xyz - P);
  var N = reflectOct(g.xy);
  if (dot(N, V) < 0.0) { N = -N; }
  let alpha = g.z * g.z;
  var H = N;
  if (alpha > 0.0025) {
    let up = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(N.y) > 0.9);
    let T = normalize(cross(up, N));
    let B = cross(N, T);
    let h = reflectVndf(vec3<f32>(dot(V, T), dot(V, B), dot(V, N)), alpha, rand(), rand());
    H = normalize(T * h.x + B * h.y + N * h.z);
  }
  let d = reflect(-V, H);
  let o = P + N * (EPS * 4.0 + 0.002 * length(rf.eye.xyz - P));
  let h = trace(o, d, FAR, false);
  var L = vec3<f32>(0.0);
  if (h.tri < 0) {
    L = skyAt(d);
  } else {
    let i = u32(h.tri);
    // A surface's back shows nothing (it is inside something).
    if (dot(d, vec3<f32>(tris[i * 3u].w, tris[i * 3u + 1u].w, tris[i * 3u + 2u].w)) <= 0.0) {
      var nrm = normalize(cross(tris[i * 3u + 1u].xyz, tris[i * 3u + 2u].xyz));
      if (dot(nrm, d) > 0.0) { nrm = -nrm; }
      let hp = o + d * h.t + nrm * EPS;
      var light = lightsOn(hp, nrm, bitcast<u32>(mats[i * 2u].w));
      if (rf.info.z > 0.5) { light = light + giIrradiance(hp, nrm); }
      L = mats[i * 2u + 1u].rgb + mats[i * 2u].rgb * light;
    }
  }
  textureStore(reflectOut, vec2<i32>(id.xy), vec4<f32>(L, 1.0));
}

@compute @workgroup_size(64)
fn giUpdate(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = giCount();
  let p = id.x / ${PROBE_VOLUME_SLOTS}u;
  if (p >= n.x * n.y * n.z) { return; }
  let slot = id.x % ${PROBE_VOLUME_SLOTS}u;
  let rays = u32(gi.min.w + 0.5);
  let base = p * rays;
  let at = giSlot(slot, giProbe(p));
  let old = probeData[at];
  let h = gi.scale.w;
  if (slot < ${PROBE_SH}u) {
    let band = select(select(0.25, 2.0 / 3.0, slot < 4u), 1.0, slot == 0u);
    var e = vec3<f32>(0.0);
    var backs = 0.0;
    var skyAll = 0.0;
    var skyOpen = 0.0;
    for (var r = 0u; r < rays; r = r + 1u) {
      let a = giRays[(base + r) * 2u];
      let b = giRays[(base + r) * 2u + 1u];
      let d = b.xyz;
      let y = array<f32, 9>(0.282095, 0.488603 * d.y, 0.488603 * d.z, 0.488603 * d.x, 1.092548 * d.x * d.y, 1.092548 * d.y * d.z, 0.315392 * (3.0 * d.z * d.z - 1.0), 1.092548 * d.x * d.z, 0.546274 * (d.x * d.x - d.y * d.y));
      e = e + a.rgb * y[slot];
      backs = backs + b.w;
      let s = lum(skyAt(d));
      skyAll = skyAll + s;
      if (a.w >= FAR) { skyOpen = skyOpen + s; }
    }
    let estimate = e * (4.0 * PI / f32(rays)) * band;
    var w = 0.0;
    if (slot == 0u) { w = mix(select(0.0, 1.0, backs <= gi.info.y * f32(rays)), old.w, h); }
    if (slot == 1u) { w = mix(select(1.0, min(1.0, skyOpen / skyAll), skyAll > 1e-12), old.w, h); }
    probeData[at] = vec4<f32>(mix(estimate, old.rgb, h), w);
    return;
  }
  // Two octahedral depth texels a slot: their mean distance and its square, where this frame's rays fell.
  let first = (slot - ${PROBE_SH}u) * 2u;
  var acc = vec4<f32>(0.0);
  var hits = vec2<f32>(0.0);
  for (var r = 0u; r < rays; r = r + 1u) {
    let a = giRays[(base + r) * 2u];
    let k = octTexel(giRays[(base + r) * 2u + 1u].xyz);
    let t = min(a.w, gi.info.x);
    if (k == first) { acc = acc + vec4<f32>(t, t * t, 0.0, 0.0); hits.x = hits.x + 1.0; }
    if (k == first + 1u) { acc = acc + vec4<f32>(0.0, 0.0, t, t * t); hits.y = hits.y + 1.0; }
  }
  var out = old;
  if (hits.x > 0.0) { out = vec4<f32>(mix(acc.xy / hits.x, old.xy, h), out.zw); }
  if (hits.y > 0.0) { out = vec4<f32>(out.xy, mix(acc.zw / hits.y, old.zw, h)); }
  probeData[at] = out;
}
`;

/** A cheap repeatable random sequence for the frames' rotations. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The live probe volume's tracer on a device, for one still scene: its BVH
 * (built once, on the CPU, as the bake's), the rays' buffer, and each frame's
 * passes into the scene's probe buffer.
 */
export class GpuProbeGi {
  private readonly scene: any[];
  private readonly uniforms: any;
  private readonly params: any;
  private readonly data = new Float32Array(GI_UNIFORM_FLOATS);
  private rays: any = null;
  private lights: any = null;
  private lightsSize = 0;
  private sky: any = null;
  private skySource: LinearPanorama | null | undefined = undefined;
  private skySize: readonly [number, number] = [0, 0];
  private pipelines: { trace: any; update: any } | null = null;
  private reflectPipeline: any = null;
  private reflectUniforms: any = null;
  private reflectGi: any = null;
  private blankProbes: any = null;
  private readonly reflectData = new Float32Array(24);
  private readonly random = mulberry(0x5eed);
  private frames = 0;
  /** The probe buffer the passes last wrote into, so a new one (a re-uploaded volume) starts its bounce afresh. */
  private target: any = null;

  constructor(
    private readonly device: any,
    occluders: readonly Occluder[],
  ) {
    const packed = packLightmapScene(occluders);
    const upload = (view: ArrayBufferView) => {
      const buffer = device.createBuffer({ size: Math.max(16, view.byteLength), usage: STORAGE | COPY_DST });
      device.queue.writeBuffer(buffer, 0, view.buffer, view.byteOffset, view.byteLength);
      return buffer;
    };
    this.scene = [upload(packed.nodes), upload(packed.tris), upload(packed.mats)];
    this.uniforms = device.createBuffer({ size: GI_UNIFORM_FLOATS * 4, usage: UNIFORM | COPY_DST });
    this.params = device.createBuffer({ size: 64, usage: UNIFORM | COPY_DST });
  }

  /**
   * Write this frame's uniforms and encode its passes into `encoder`: the
   * volume `layout` (the probe buffer `probes` holds it as the scene reads
   * it), lit by `lights` and `sky`.
   */
  update(encoder: any, probes: any, layout: Pick<ProbeVolume, "min" | "max" | "counts">, settings: DynamicGi, lights: readonly SceneLight[], sky: LinearPanorama | null, timing: { readonly timestampWrites?: object } = {}): void {
    const device = this.device;
    const count = layout.counts[0] * layout.counts[1] * layout.counts[2];
    const rays = settings.rays;
    const raysBytes = count * rays * 32;
    if (!this.rays || this.rays.size < raysBytes) {
      this.rays?.destroy();
      this.rays = device.createBuffer({ size: raysBytes, usage: STORAGE });
    }
    const packedLights = this.prepare(lights, sky);
    const { reach } = giSpacing(layout);
    device.queue.writeBuffer(this.params, 0, lightmapParams(0, count, 0, rays, rays, 1, sky, packedLights, reach));
    // The first frame on a buffer lights its hits by the lights alone; then the volume adds its bounce.
    const bounce = this.target === probes;
    this.target = probes;
    const rotation = randomRotation(this.random(), this.random(), this.random());
    // The frame's seed, a whole number a float holds exactly.
    device.queue.writeBuffer(this.uniforms, 0, packGiUniforms(layout, settings, rotation, this.frames % 16777216, bounce, this.data));
    this.frames += 1;
    const pipeline = (entryPoint: string) => device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: GI_WGSL }), entryPoint } });
    this.pipelines ??= { trace: pipeline("giTrace"), update: pipeline("giUpdate") };
    const pass = encoder.beginComputePass(timing);
    pass.setPipeline(this.pipelines.trace);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.pipelines.trace.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.scene[0] } },
          { binding: 1, resource: { buffer: this.scene[1] } },
          { binding: 2, resource: { buffer: this.scene[2] } },
          { binding: 5, resource: { buffer: this.sky } },
          { binding: 6, resource: { buffer: this.params } },
          { binding: 7, resource: { buffer: this.lights } },
          { binding: 8, resource: { buffer: probes } },
          { binding: 9, resource: { buffer: this.uniforms } },
          { binding: 10, resource: { buffer: this.rays } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil((count * rays) / 64));
    pass.setPipeline(this.pipelines.update);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.pipelines.update.getBindGroupLayout(0),
        entries: [
          { binding: 5, resource: { buffer: this.sky } },
          { binding: 6, resource: { buffer: this.params } },
          { binding: 8, resource: { buffer: probes } },
          { binding: 9, resource: { buffer: this.uniforms } },
          { binding: 10, resource: { buffer: this.rays } },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil((count * PROBE_VOLUME_SLOTS) / 64));
    pass.end();
  }

  /** Upload the frame's lights and (when it changed) the sky the tracer lights its hits by. */
  private prepare(lights: readonly SceneLight[], sky: LinearPanorama | null): ReturnType<typeof packBakeLights> {
    const device = this.device;
    const packedLights = packBakeLights(bakeLights(lights));
    if (!this.lights || this.lightsSize < packedLights.data.byteLength) {
      this.lights?.destroy();
      this.lightsSize = Math.max(16, packedLights.data.byteLength);
      this.lights = device.createBuffer({ size: this.lightsSize, usage: STORAGE | COPY_DST });
    }
    device.queue.writeBuffer(this.lights, 0, packedLights.data);
    if (sky !== this.skySource) {
      this.sky?.destroy();
      const data = sky ? sky.data : new Float32Array(4);
      this.sky = device.createBuffer({ size: Math.max(16, data.byteLength), usage: STORAGE | COPY_DST });
      device.queue.writeBuffer(this.sky, 0, data);
      this.skySource = sky;
      this.skySize = sky ? [sky.width, sky.height] : [0, 0];
    }
    return packedLights;
  }

  /**
   * Reflections the screen can't show (F3f, Epic): encode, into `encoder`, a
   * ray a half-resolution pixel of the frame — from its depth (`depth`, the
   * Hi-Z chain's first level) and G-buffer, reflected about a microfacet
   * normal for its roughness — through the still scene, each hit lit as the
   * live volume lights its own (by `lights`, and by `volume`'s irradiance when
   * there is one), a miss by the sky; into `out` (rgba16float storage, half the
   * frame's size). `lit` says whether update() already prepared this frame's
   * lights and sky.
   */
  traceReflections(
    encoder: any,
    frame: { readonly depth: any; readonly gbuffer: any; readonly out: any; readonly invViewProj: ArrayLike<number>; readonly eye: readonly number[]; readonly width: number; readonly height: number; readonly maxRoughness: number },
    lights: readonly SceneLight[],
    sky: LinearPanorama | null,
    volume: { readonly buffer: any; readonly layout: Pick<ProbeVolume, "min" | "max" | "counts"> } | null,
    lit: boolean,
    timing: { readonly timestampWrites?: object } = {},
  ): void {
    const device = this.device;
    const packedLights = lit ? null : this.prepare(lights, sky);
    if (packedLights) device.queue.writeBuffer(this.params, 0, lightmapParams(0, 0, 0, 1, 1, 1, sky, packedLights, 0));
    this.reflectUniforms ??= device.createBuffer({ size: this.reflectData.byteLength, usage: UNIFORM | COPY_DST });
    this.reflectGi ??= device.createBuffer({ size: GI_UNIFORM_FLOATS * 4, usage: UNIFORM | COPY_DST });
    this.blankProbes ??= device.createBuffer({ size: 16, usage: STORAGE });
    this.reflectData.set(frame.invViewProj, 0);
    this.reflectData.set([frame.eye[0]!, frame.eye[1]!, frame.eye[2]!, this.frames % 16777216], 16);
    this.reflectData.set([frame.width, frame.height, volume ? 1 : 0, frame.maxRoughness], 20);
    device.queue.writeBuffer(this.reflectUniforms, 0, this.reflectData);
    if (volume) device.queue.writeBuffer(this.reflectGi, 0, packGiUniforms(volume.layout, { rays: 1, hysteresis: 0, spacing: 1 }, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 0, true));
    if (!lit) this.frames += 1;
    this.reflectPipeline ??= device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: GI_WGSL }), entryPoint: "giReflect" } });
    const pass = encoder.beginComputePass(timing);
    pass.setPipeline(this.reflectPipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.reflectPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.scene[0] } },
          { binding: 1, resource: { buffer: this.scene[1] } },
          { binding: 2, resource: { buffer: this.scene[2] } },
          { binding: 5, resource: { buffer: this.sky } },
          { binding: 6, resource: { buffer: this.params } },
          { binding: 7, resource: { buffer: this.lights } },
          { binding: 8, resource: { buffer: volume ? volume.buffer : this.blankProbes } },
          { binding: 9, resource: { buffer: this.reflectGi } },
          { binding: 11, resource: { buffer: this.reflectUniforms } },
          { binding: 12, resource: frame.depth },
          { binding: 13, resource: frame.gbuffer },
          { binding: 14, resource: frame.out },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(Math.ceil(frame.width / 2) / 8), Math.ceil(Math.ceil(frame.height / 2) / 8));
    pass.end();
  }

  dispose(): void {
    for (const b of [...this.scene, this.uniforms, this.params, this.rays, this.lights, this.sky, this.reflectUniforms, this.reflectGi, this.blankProbes]) b?.destroy?.();
  }
}
