/**
 * Volumetric clouds on the AAA tier (AAA_FIDELITY_ROADMAP.md F5c): the cloud
 * layer of a physical sky, raymarched on the GPU, mirroring the CPU reference
 * in @cartbox/editor (clouds.ts) step for step.
 *
 * - **Half resolution, amortised.** A compute pass marches a ray a texel of a
 *   half-size target, its first step jittered per pixel and per frame, and
 *   blends it into the last frame's result reprojected by direction (the
 *   clouds are kilometres off, so the camera's turn is all that moves them on
 *   screen). The history converges on the jittered march's mean, so 48 steps
 *   read as many more.
 * - **What it holds**: the light the layer sends toward the eye, already
 *   through the air between them (the transmittance LUT's ratio from the eye
 *   and from the cloud), in rgb, and the share of the sky behind that gets
 *   through, in a.
 * - **The presenter** lays it over the physical sky (`rgb × a + cloud`), the
 *   sun's disc, the moon and the stars included, so the sun goes behind a
 *   cloud.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  CLOUD_RANGE,
  DETAIL_SIZE,
  DETAIL_TILES,
  DIFFUSION_G,
  LIGHT_STEPS,
  SCATTER_OCTAVES,
  SHAPE_SIZE,
  VIEW_STEPS,
  WEATHER_SIZE,
  WEATHER_TILES,
  cloudNoise,
  type Clouds,
  type Mat4,
} from "@cartbox/editor";

import { ATMOSPHERE_COMMON_WGSL, packAtmosphereUniforms, ATMOSPHERE_UNIFORM_FLOATS, type AtmosphereSky } from "./atmosphere.js";

/** The march's workgroup edge. */
const TILE = 8;
/** The share of a new frame the history takes in (the rest is the reprojected past). */
export const CLOUD_BLEND = 0.15;

/** A frame's clouds: the layer, the upper sky's mean radiance it takes light from, and the seconds the wind has blown. */
export interface CloudFrame {
  readonly clouds: Clouds;
  readonly ambient: readonly [number, number, number];
  readonly time: number;
}

/** Floats in the cloud pass's uniform block. */
export const CLOUD_UNIFORM_FLOATS = 52;

/**
 * The cloud pass's uniforms: the camera's rows and reciprocal focal lengths
 * (as the sky pass's), the last frame's for reprojection, the layer, the
 * ambient, the frame's jitter and whether to blend, and the target's size.
 */
export function packCloudUniforms(
  frame: CloudFrame,
  view: Mat4,
  projection: Mat4,
  previous: { readonly view: Mat4; readonly projection: Mat4 } | null,
  index: number,
  width: number,
  height: number,
  out = new Float32Array(CLOUD_UNIFORM_FLOATS),
): Float32Array {
  const rows = (v: Mat4, p: Mat4, at: number) => {
    out.set([v[0]!, v[4]!, v[8]!, 1 / p[0]!], at);
    out.set([v[1]!, v[5]!, v[9]!, 1 / p[5]!], at + 4);
    out.set([v[2]!, v[6]!, v[10]!, 0], at + 8);
  };
  rows(view, projection, 0);
  rows(previous?.view ?? view, previous?.projection ?? projection, 12);
  const c = frame.clouds;
  out.set([c.base, c.thickness, c.density, c.type], 24);
  out.set([c.scale, c.coverage, c.wind[0], c.wind[1]], 28);
  out.set([...frame.ambient, frame.time], 32);
  // The jitter's frame (an index into the noise), whether the history is good, and a fixed jitter (≥ 0) for tests.
  out.set([index % 64, previous ? 1 : 0, -1, 0], 36);
  out.set([width, height, 0, 0], 40);
  out.set([0, 0, 0, 0], 44);
  out.set([0, 0, 0, 0], 48);
  return out;
}

/** The march: a thread a texel. */
export const CLOUDS_WGSL = /* wgsl */ `
${ATMOSPHERE_COMMON_WGSL}
struct CloudU {
  right: vec4f, up: vec4f, back: vec4f,
  prevRight: vec4f, prevUp: vec4f, prevBack: vec4f,
  layer0: vec4f,  // base, thickness, density, type
  layer1: vec4f,  // scale, coverage, wind x, wind z (km a second)
  ambient: vec4f, // the upper sky's mean radiance, the seconds blown
  frame: vec4f,   // jitter frame, history good, fixed jitter (≥ 0)
  size: vec4f,    // the target's width and height
  pad0: vec4f, pad1: vec4f,
};
@group(0) @binding(0) var<uniform> atm: Atm;
@group(0) @binding(1) var<uniform> cu: CloudU;
@group(0) @binding(2) var shapeTex: texture_3d<f32>;
@group(0) @binding(3) var detailTex: texture_3d<f32>;
@group(0) @binding(4) var weatherTex: texture_2d<f32>;
@group(0) @binding(5) var repeatSampler: sampler;
@group(0) @binding(6) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(7) var clampSampler: sampler;
@group(0) @binding(8) var history: texture_2d<f32>;
@group(0) @binding(9) var outTex: texture_storage_2d<rgba16float, write>;

fn transmittanceTo(r: f32, mu: f32) -> vec3f {
  if (hitsGround(r, mu)) { return vec3f(0.0); }
  return textureSampleLevel(transmittanceLut, clampSampler, transmittanceUv(r, mu), 0.0).rgb;
}
fn remap(v: f32, lo0: f32, hi0: f32, lo1: f32, hi1: f32) -> f32 { return lo1 + (v - lo0) / max(1e-6, hi0 - lo0) * (hi1 - lo1); }
fn heightGradient(h: f32, kind: f32) -> f32 {
  let rise = clamp(remap(h, 0.0, 0.08, 0.0, 1.0), 0.0, 1.0);
  let stratus = clamp(remap(h, 0.18, 0.3, 1.0, 0.0), 0.0, 1.0);
  let cumulus = clamp(remap(h, 0.55, 1.0, 1.0, 0.0), 0.0, 1.0);
  return rise * (stratus + (cumulus - stratus) * kind);
}
// The cloud's extinction per km at p (the planet's frame, the ground under the scene at the origin); mirrors cloudDensity.
fn cloudDensity(p: vec3f, cheap: bool) -> f32 {
  let bottom = atm.radii.x;
  let base = cu.layer0.x;
  let thickness = cu.layer0.y;
  let r = length(vec3f(p.x, p.y + bottom, p.z));
  let h = (r - bottom - base) / thickness;
  if (h <= 0.0 || h >= 1.0) { return 0.0; }
  let time = cu.ambient.w;
  let x = p.x - cu.layer1.z * time * (1.0 + 0.5 * h);
  let z = p.z - cu.layer1.w * time * (1.0 + 0.5 * h);
  let tile = cu.layer1.x;
  let coverage = cu.layer1.y;
  let weather = textureSampleLevel(weatherTex, repeatSampler, vec2f(x, z) / (tile * ${WEATHER_TILES}.0), 0.0).r;
  let local = clamp(coverage + (weather - 0.5) * 0.9 * (1.0 - 0.6 * coverage), 0.0, 1.0) * min(1.0, coverage * 4.0);
  if (local <= 0.0) { return 0.0; }
  let uvw = vec3f(x / tile, h * thickness / tile, z / tile);
  let s = textureSampleLevel(shapeTex, repeatSampler, uvw, 0.0);
  let fbm = 0.625 * s.g + 0.25 * s.b + 0.125 * s.a;
  let shaped = remap(s.r, fbm - 1.0, 1.0, 0.0, 1.0) * heightGradient(h, cu.layer0.w);
  var d = clamp(remap(shaped, 1.0 - local, 1.0, 0.0, 1.0), 0.0, 1.0) * local;
  if (d <= 0.0) { return 0.0; }
  if (!cheap) {
    let e = textureSampleLevel(detailTex, repeatSampler, uvw * ${DETAIL_TILES}.0, 0.0);
    let detail = 0.625 * e.r + 0.25 * e.g + 0.125 * e.b;
    let modifier = detail + (1.0 - 2.0 * detail) * clamp(h * 10.0, 0.0, 1.0);
    d = clamp(remap(d, modifier * 0.35, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  return d * cu.layer0.z;
}
fn hgPhase(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1e-6, 1.0 + g2 - 2.0 * g * c), 1.5));
}
fn cloudPhase(c: f32, octave: f32) -> f32 {
  let k = pow(0.5, octave);
  return 0.75 * hgPhase(c, 0.8 * k) + 0.25 * hgPhase(c, -0.3 * k);
}
// Mirrors sunBeam: Wrenninge's octaves, and the two-stream slab's diffused light.
fn sunBeam(c: f32, od: f32) -> f32 {
  var beam = 0.0;
  for (var o = 0; o < ${SCATTER_OCTAVES}; o = o + 1) {
    let k = pow(0.5, f32(o));
    beam = beam + k * cloudPhase(c, f32(o)) * exp(-od * k);
  }
  let diffused = max(0.0, 1.0 / (1.0 + 0.75 * (1.0 - ${DIFFUSION_G}) * od) - exp(-od));
  return beam + diffused / (4.0 * PI);
}
const LIGHT_STEPS = array<f32, ${LIGHT_STEPS.length}>(${LIGHT_STEPS.map((s) => s.toFixed(4)).join(", ")});

struct CloudSample { light: vec3f, transmittance: f32, distance: f32 };

// Mirrors cloudRadiance.
fn march(d: vec3f, jitter: f32) -> CloudSample {
  let bottom = atm.radii.x;
  let viewHeight = atm.view.x;
  let r = bottom + viewHeight;
  let mu = d.y;
  var none = CloudSample(vec3f(0.0), 1.0, -1.0);
  if (hitsGround(r, mu)) { return none; }
  let lo = bottom + cu.layer0.x;
  let hi = lo + cu.layer0.y;
  var t0 = -1.0;
  var t1 = -1.0;
  if (r < lo) {
    t0 = raySphere(r, mu, lo);
    t1 = raySphere(r, mu, hi);
  } else if (r < hi) {
    t0 = 0.0;
    let down = mu < 0.0 && r * r * (mu * mu - 1.0) + lo * lo >= 0.0;
    t1 = select(raySphere(r, mu, hi), raySphere(r, mu, lo), down);
  } else {
    if (mu >= 0.0) { return none; }
    t0 = raySphere(r, mu, hi);
    t1 = select(t0, raySphere(r, mu, lo), r * r * (mu * mu - 1.0) + lo * lo >= 0.0);
  }
  if (t0 < 0.0 || t1 <= t0) { return none; }
  t1 = min(t1, ${CLOUD_RANGE}.0);
  if (t1 <= t0) { return none; }
  let dt = (t1 - t0) / ${VIEW_STEPS}.0;
  let sun = atm.sun.xyz;
  let c = dot(d, sun);
  let E = atm.sunE.rgb;
  var L = vec3f(0.0);
  var T = 1.0;
  var weighted = 0.0;
  var weight = 0.0;
  for (var i = 0; i < ${VIEW_STEPS}; i = i + 1) {
    let t = t0 + (f32(i) + jitter) * dt;
    let p = vec3f(d.x * t, viewHeight + d.y * t, d.z * t);
    let sigma = cloudDensity(p, false);
    if (sigma <= 0.0) { continue; }
    let pR = length(vec3f(p.x, p.y + bottom, p.z));
    let h = (pR - bottom - cu.layer0.x) / cu.layer0.y;
    var od = 0.0;
    var along = 0.0;
    for (var k = 0; k < ${LIGHT_STEPS.length}; k = k + 1) {
      let step = LIGHT_STEPS[k] * cu.layer0.y;
      let at = along + step * 0.5;
      along = along + step;
      od = od + cloudDensity(p + sun * at, true) * step;
    }
    let muSun = dot(vec3f(p.x, p.y + bottom, p.z), sun) / pR;
    let ts = transmittanceTo(pR, muSun);
    let beam = sunBeam(c, od);
    let powder = 1.0 - 0.6 * exp(-2.0 * sigma * dt);
    let tau = sigma * (1.0 - clamp(h, 0.0, 1.0)) * cu.layer0.y;
    let amb = cu.ambient.rgb * (0.5 / (1.0 + 0.75 * (1.0 - ${DIFFUSION_G}) * tau));
    let stepT = exp(-sigma * dt);
    let S = sigma * (E * ts * beam * powder + amb);
    L = L + T * ((S - S * stepT) / sigma);
    weighted = weighted + t * T * (1.0 - stepT);
    weight = weight + T * (1.0 - stepT);
    T = T * stepT;
    if (T < 0.01) { break; }
  }
  return CloudSample(L, T, select(-1.0, weighted / max(weight, 1e-9), weight > 0.0));
}

// The air between the eye and a point t along d: the ratio of their transmittances to the top (mirrors airTransmittance).
fn airTransmittance(d: vec3f, t: f32) -> vec3f {
  let r = atm.radii.x + atm.view.x;
  let p = vec3f(d.x * t, r + d.y * t, d.z * t);
  let pR = length(p);
  let fromEye = transmittanceTo(r, d.y);
  let toCloud = transmittanceTo(pR, dot(p, d) / pR);
  return clamp(fromEye / max(toCloud, vec3f(1e-6)), vec3f(0.0), vec3f(1.0));
}

fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }

@compute @workgroup_size(${TILE}, ${TILE})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= cu.size.x || f32(id.y) >= cu.size.y) { return; }
  let pixel = vec2f(id.xy) + 0.5;
  let ndc = vec2f(pixel.x / cu.size.x * 2.0 - 1.0, 1.0 - pixel.y / cu.size.y * 2.0);
  let d = normalize(cu.right.xyz * (ndc.x * cu.right.w) + cu.up.xyz * (ndc.y * cu.up.w) - cu.back.xyz);
  let jitter = select(fract(ign(pixel + vec2f(5.588238 * cu.frame.x, 5.588238 * cu.frame.x))), cu.frame.z, cu.frame.z >= 0.0);
  let m = march(d, jitter);
  var now = vec4f(0.0, 0.0, 0.0, 1.0);
  if (m.distance > 0.0) { now = vec4f(m.light * airTransmittance(d, m.distance), m.transmittance); }
  else if (m.transmittance < 1.0) { now = vec4f(m.light, m.transmittance); }
  var out = now;
  // The last frame's result where this direction was on screen then.
  if (cu.frame.y > 0.5) {
    let z = -dot(d, cu.prevBack.xyz);
    if (z > 1e-4) {
      let pn = vec2f(dot(d, cu.prevRight.xyz) / (z * cu.prevRight.w), dot(d, cu.prevUp.xyz) / (z * cu.prevUp.w));
      let uv = vec2f(pn.x * 0.5 + 0.5, 0.5 - pn.y * 0.5);
      if (all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0))) {
        let past = textureSampleLevel(history, clampSampler, uv, 0.0);
        out = mix(past, now, ${CLOUD_BLEND});
      }
    }
  }
  textureStore(outTex, vec2i(id.xy), out);
}
`;

/** Texture usages (copy-dst, sampled, storage) and buffer usages (copy-dst, uniform): WebGPU numbers them apart. */
const TEX = { copySrc: 0x01, copyDst: 0x02, textureBinding: 0x04, storage: 0x08 } as const;
const BUF = { copyDst: 0x08, uniform: 0x40 } as const;

/**
 * The cloud pass's resources: the baked noises (uploaded once), the two
 * half-size targets it writes in turn, and the pipeline.
 */
export class GpuClouds {
  private readonly shape: any;
  private readonly detail: any;
  private readonly weather: any;
  private readonly repeat: any;
  private readonly clamp: any;
  private readonly atm: any;
  private readonly uniforms: any;
  private readonly atmData = new Float32Array(ATMOSPHERE_UNIFORM_FLOATS);
  private readonly data = new Float32Array(CLOUD_UNIFORM_FLOATS);
  private readonly pipeline: any;
  private targets: [any, any] | null = null;
  private size = { width: 0, height: 0 };
  private index = 0;
  private previous: { view: Mat4; projection: Mat4 } | null = null;
  /** The target the last {@link march} wrote: what the presenter lays over the sky. */
  current: any = null;

  constructor(private readonly device: any) {
    const noise = cloudNoise();
    const volume = (n: number, data: Uint8Array) => {
      const texture = device.createTexture({ size: { width: n, height: n, depthOrArrayLayers: n }, dimension: "3d", format: "rgba8unorm", usage: TEX.textureBinding | TEX.copyDst });
      device.queue.writeTexture({ texture }, data, { bytesPerRow: n * 4, rowsPerImage: n }, { width: n, height: n, depthOrArrayLayers: n });
      return texture;
    };
    this.shape = volume(SHAPE_SIZE, noise.shape);
    this.detail = volume(DETAIL_SIZE, noise.detail);
    this.weather = device.createTexture({ size: { width: WEATHER_SIZE, height: WEATHER_SIZE }, format: "rgba8unorm", usage: TEX.textureBinding | TEX.copyDst });
    device.queue.writeTexture({ texture: this.weather }, noise.weather, { bytesPerRow: WEATHER_SIZE * 4, rowsPerImage: WEATHER_SIZE }, { width: WEATHER_SIZE, height: WEATHER_SIZE });
    this.repeat = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", addressModeW: "repeat" });
    this.clamp = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    this.atm = device.createBuffer({ size: ATMOSPHERE_UNIFORM_FLOATS * 4, usage: BUF.uniform | BUF.copyDst });
    this.uniforms = device.createBuffer({ size: CLOUD_UNIFORM_FLOATS * 4, usage: BUF.uniform | BUF.copyDst });
    this.pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: CLOUDS_WGSL }), entryPoint: "main" } });
  }

  /** The half-size target's size for a frame of `width × height`. */
  static targetSize(width: number, height: number): { width: number; height: number } {
    return { width: Math.max(1, Math.ceil(width / 2)), height: Math.max(1, Math.ceil(height / 2)) };
  }

  /**
   * March this frame's clouds into the next target, blending the last (`fixedJitter` ≥ 0 marches every texel at
   * that jitter with no history, for tests). Encoded on `encoder`; {@link current} is the result.
   */
  march(encoder: any, sky: AtmosphereSky, frame: CloudFrame, view: Mat4, projection: Mat4, transmittance: any, width: number, height: number, fixedJitter = -1): any {
    const device = this.device;
    const size = GpuClouds.targetSize(width, height);
    if (!this.targets || size.width !== this.size.width || size.height !== this.size.height) {
      for (const t of this.targets ?? []) t.destroy?.();
      const make = () => device.createTexture({ size, format: "rgba16float", usage: TEX.textureBinding | TEX.storage | TEX.copySrc });
      this.targets = [make(), make()];
      this.size = size;
      this.previous = null;
    }
    const write = this.targets[this.index % 2]!;
    const read = this.targets[(this.index + 1) % 2]!;
    device.queue.writeBuffer(this.atm, 0, packAtmosphereUniforms(sky, this.atmData));
    const data = packCloudUniforms(frame, view, projection, fixedJitter >= 0 ? null : this.previous, this.index, size.width, size.height, this.data);
    if (fixedJitter >= 0) data[38] = fixedJitter;
    device.queue.writeBuffer(this.uniforms, 0, data);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.atm } },
          { binding: 1, resource: { buffer: this.uniforms } },
          { binding: 2, resource: this.shape.createView({ dimension: "3d" }) },
          { binding: 3, resource: this.detail.createView({ dimension: "3d" }) },
          { binding: 4, resource: this.weather.createView() },
          { binding: 5, resource: this.repeat },
          { binding: 6, resource: transmittance.createView() },
          { binding: 7, resource: this.clamp },
          { binding: 8, resource: read.createView() },
          { binding: 9, resource: write.createView() },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(size.width / TILE), Math.ceil(size.height / TILE));
    pass.end();
    this.index += 1;
    this.previous = { view: [...view] as unknown as Mat4, projection: [...projection] as unknown as Mat4 };
    this.current = write;
    return write;
  }

  dispose(): void {
    for (const t of [this.shape, this.detail, this.weather, this.atm, this.uniforms, ...(this.targets ?? [])]) t?.destroy?.();
    this.targets = null;
    this.current = null;
  }
}
