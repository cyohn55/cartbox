/**
 * The physically based sky on the GPU (AAA_FIDELITY_ROADMAP.md F5a): Hillaire's
 * three LUTs in compute, mirroring the CPU reference in @cartbox/editor
 * (atmosphere.ts) step for step, so each can be held to the other.
 *
 * - **Transmittance** (256 × 64): to the top of the atmosphere, over a point's
 *   radius and the ray's zenith cosine (Bruneton's mapping), 128 steps a ray.
 *   Built once per medium.
 * - **Multiple scattering** (32 × 32): Hillaire's Ψ_ms over the sun's zenith
 *   cosine and the height, 64 directions of 20 steps a texel. Built once per
 *   medium.
 * - **Sky view** (192 × 108): the sky's radiance from the scene, over the
 *   azimuth from the sun (finer toward it) and the zenith angle (finer toward
 *   the horizon, which sits at v = ½), 32 steps a ray spaced quadratically.
 *   Rebuilt when the sun moves, so a time of day is a few hundred microseconds
 *   of compute.
 *
 * The presenter (gpuPresent.ts) draws the AAA tier's backdrop from the sky
 * view per pixel, and the sun's disc over it, in the renderer's units of
 * linear light, which the frame then tone-maps with the scene.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  MULTISCATTER_DIRECTIONS,
  MULTISCATTER_SIZE,
  MULTISCATTER_STEPS,
  SKY_STEPS,
  TRANSMITTANCE_HEIGHT,
  TRANSMITTANCE_STEPS,
  TRANSMITTANCE_WIDTH,
  atmosphereKey,
  type Atmosphere,
} from "@cartbox/editor";

type V3 = [number, number, number];

/** The sky-view LUT's size. */
export const SKY_VIEW_WIDTH = 192;
export const SKY_VIEW_HEIGHT = 108;

/** A physical sky as a frame draws it: the medium, the sun toward it and its radiance above the air (linear units). */
export interface AtmosphereSky {
  readonly atmosphere: Atmosphere;
  readonly sun: readonly [number, number, number];
  readonly sunRadiance: readonly [number, number, number];
}

/** The angle from the zenith down to the horizon a viewer at radius r sees, and the angle below it to the nadir. */
function horizonAngles(a: Atmosphere, r: number): { horizon: number; beta: number } {
  const beta = Math.acos(Math.min(1, Math.sqrt(Math.max(0, r * r - a.bottom * a.bottom)) / r));
  return { horizon: Math.PI - beta, beta };
}

/** A sky-view texel's (u, v) into the view direction it stands for, with the sun at azimuth 0 (x): Hillaire's mapping. */
export function skyViewDirection(a: Atmosphere, u: number, v: number): V3 {
  const r = a.bottom + a.viewHeight;
  const { horizon, beta } = horizonAngles(a, r);
  let zenith: number;
  if (v < 0.5) {
    const c = 1 - (1 - 2 * v) ** 2;
    zenith = horizon * c;
  } else {
    const c = (2 * v - 1) ** 2;
    zenith = horizon + beta * c;
  }
  const cosAz = 1 - 2 * u * u;
  const sinAz = Math.sqrt(Math.max(0, 1 - cosAz * cosAz));
  return [Math.sin(zenith) * cosAz, Math.cos(zenith), Math.sin(zenith) * sinAz];
}

/** A world view direction's (u, v) in the sky view for a sun toward `sun` (the inverse of {@link skyViewDirection}). */
export function skyViewUv(a: Atmosphere, d: readonly number[], sun: readonly number[]): [number, number] {
  const r = a.bottom + a.viewHeight;
  const { horizon, beta } = horizonAngles(a, r);
  const zenith = Math.acos(Math.min(1, Math.max(-1, d[1]!)));
  const v = zenith < horizon ? (1 - Math.sqrt(Math.max(0, 1 - zenith / horizon))) / 2 : (Math.sqrt(Math.min(1, (zenith - horizon) / beta)) + 1) / 2;
  const dh = Math.hypot(d[0]!, d[2]!);
  const sh = Math.hypot(sun[0]!, sun[2]!);
  const cosAz = dh > 1e-6 && sh > 1e-6 ? (d[0]! * sun[0]! + d[2]! * sun[2]!) / (dh * sh) : 1;
  return [Math.sqrt(Math.max(0, (1 - Math.min(1, Math.max(-1, cosAz))) / 2)), v];
}

/** Floats in the LUT passes' uniform block. */
export const ATMOSPHERE_UNIFORM_FLOATS = 28;

/**
 * The LUT passes' uniforms: the radii and scale heights; Rayleigh's
 * scattering; ozone's absorption, its centre and width; Mie's scattering,
 * extinction, anisotropy and the ground's albedo; the view's height; the sun
 * toward it, and its illuminance (π × its radiance above the air).
 */
export function packAtmosphereUniforms(sky: AtmosphereSky, out = new Float32Array(ATMOSPHERE_UNIFORM_FLOATS)): Float32Array {
  const a = sky.atmosphere;
  out.set([a.bottom, a.top, a.rayleighScale, a.mieScale], 0);
  out.set([...a.rayleighScattering, 0], 4);
  out.set([...a.ozoneAbsorption, a.ozoneCenter], 8);
  out.set([a.mieScattering, a.mieExtinction, a.mieG, a.groundAlbedo], 12);
  out.set([a.viewHeight, a.ozoneWidth, 0, 0], 16);
  const l = Math.hypot(sky.sun[0], sky.sun[1], sky.sun[2]) || 1;
  out.set([sky.sun[0] / l, sky.sun[1] / l, sky.sun[2] / l, 0], 20);
  out.set([Math.PI * sky.sunRadiance[0], Math.PI * sky.sunRadiance[1], Math.PI * sky.sunRadiance[2], 0], 24);
  return out;
}

/** The WGSL of the atmosphere's medium and LUT lookups, shared by the passes (atmosphere.ts in @cartbox/editor, line for line). */
export const ATMOSPHERE_COMMON_WGSL = /* wgsl */ `
struct Atm {
  radii: vec4f,    // bottom, top, Rayleigh and Mie scale heights (km)
  rayleigh: vec4f, // scattering per km
  ozone: vec4f,    // absorption per km, centre (km)
  mie: vec4f,      // scattering, extinction, g, ground albedo
  view: vec4f,     // height above the ground (km), ozone half width
  sun: vec4f,      // toward the sun
  sunE: vec4f,     // its illuminance, π × its radiance above the air
};
const PI = 3.14159265;

struct Medium { rayleigh: vec3f, mie: f32, extinction: vec3f };

fn mediumAt(h: f32) -> Medium {
  let dr = exp(-max(0.0, h) / atm.radii.z);
  let dm = exp(-max(0.0, h) / atm.radii.w);
  let dozone = max(0.0, 1.0 - abs(h - atm.ozone.w) / atm.view.y);
  let rayleigh = atm.rayleigh.rgb * dr;
  return Medium(rayleigh, atm.mie.x * dm, rayleigh + vec3f(atm.mie.y * dm) + atm.ozone.rgb * dozone);
}

fn raySphere(r: f32, mu: f32, radius: f32) -> f32 {
  let b = r * mu;
  let disc = b * b - (r * r - radius * radius);
  if (disc < 0.0) { return -1.0; }
  let s = sqrt(disc);
  if (-b - s > 0.0) { return -b - s; }
  if (-b + s > 0.0) { return -b + s; }
  return -1.0;
}

fn hitsGround(r: f32, mu: f32) -> bool {
  return mu < 0.0 && r * r * (mu * mu - 1.0) + atm.radii.x * atm.radii.x >= 0.0;
}

fn transmittanceUv(r: f32, mu: f32) -> vec2f {
  let bottom = atm.radii.x;
  let top = atm.radii.y;
  let H = sqrt(top * top - bottom * bottom);
  let rho = sqrt(max(0.0, r * r - bottom * bottom));
  let d = max(0.0, -r * mu + sqrt(max(0.0, r * r * (mu * mu - 1.0) + top * top)));
  let dMin = top - r;
  let dMax = rho + H;
  return vec2f(select(0.0, (d - dMin) / (dMax - dMin), dMax > dMin), rho / H);
}

fn rayleighPhase(c: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
fn miePhase(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1e-6, 1.0 + g2 - 2.0 * g * c), 1.5));
}
`;

const LUT_BINDINGS_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> atm: Atm;
@group(0) @binding(1) var lutSampler: sampler;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var multiScatterLut: texture_2d<f32>;
`;

const LOOKUPS_WGSL = /* wgsl */ `
fn transmittanceTo(r: f32, mu: f32) -> vec3f {
  if (hitsGround(r, mu)) { return vec3f(0.0); }
  return textureSampleLevel(transmittanceLut, lutSampler, transmittanceUv(r, mu), 0.0).rgb;
}
fn multiScatteringAt(h: f32, muS: f32) -> vec3f {
  return textureSampleLevel(multiScatterLut, lutSampler, vec2f(muS * 0.5 + 0.5, max(0.0, h) / (atm.radii.y - atm.radii.x)), 0.0).rgb;
}
`;

/** The transmittance LUT's pass. */
export const TRANSMITTANCE_WGSL = /* wgsl */ `
${ATMOSPHERE_COMMON_WGSL}
@group(0) @binding(0) var<uniform> atm: Atm;
@group(0) @binding(1) var outLut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${TRANSMITTANCE_WIDTH}u || id.y >= ${TRANSMITTANCE_HEIGHT}u) { return; }
  let u = (f32(id.x) + 0.5) / ${TRANSMITTANCE_WIDTH}.0;
  let v = (f32(id.y) + 0.5) / ${TRANSMITTANCE_HEIGHT}.0;
  let bottom = atm.radii.x;
  let top = atm.radii.y;
  let H = sqrt(top * top - bottom * bottom);
  let rho = H * v;
  let r = sqrt(rho * rho + bottom * bottom);
  let dMin = top - r;
  let dMax = rho + H;
  let dd = dMin + u * (dMax - dMin);
  var mu = 1.0;
  if (dd != 0.0) { mu = clamp((H * H - rho * rho - dd * dd) / (2.0 * r * dd), -1.0, 1.0); }
  let t = max(0.0, raySphere(r, mu, top));
  let dt = t / ${TRANSMITTANCE_STEPS}.0;
  var depth = vec3f(0.0);
  for (var i = 0; i < ${TRANSMITTANCE_STEPS}; i = i + 1) {
    let s = (f32(i) + 0.5) * dt;
    let h = sqrt(r * r + s * s + 2.0 * r * mu * s) - bottom;
    depth = depth + mediumAt(h).extinction * dt;
  }
  textureStore(outLut, vec2i(id.xy), vec4f(exp(-depth), 1.0));
}
`;

/** The multiple-scattering LUT's pass. */
export const MULTISCATTER_WGSL = /* wgsl */ `
${ATMOSPHERE_COMMON_WGSL}
@group(0) @binding(0) var<uniform> atm: Atm;
@group(0) @binding(1) var lutSampler: sampler;
@group(0) @binding(2) var transmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var outLut: texture_storage_2d<rgba16float, write>;

fn transmittanceTo(r: f32, mu: f32) -> vec3f {
  if (hitsGround(r, mu)) { return vec3f(0.0); }
  return textureSampleLevel(transmittanceLut, lutSampler, transmittanceUv(r, mu), 0.0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${MULTISCATTER_SIZE}u || id.y >= ${MULTISCATTER_SIZE}u) { return; }
  let muS = (f32(id.x) + 0.5) / ${MULTISCATTER_SIZE}.0 * 2.0 - 1.0;
  let h = (f32(id.y) + 0.5) / ${MULTISCATTER_SIZE}.0 * (atm.radii.y - atm.radii.x);
  let r = atm.radii.x + max(1e-3, h);
  let sun = vec3f(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  let iso = 1.0 / (4.0 * PI);
  var L = vec3f(0.0);
  var f = vec3f(0.0);
  for (var k = 0; k < ${MULTISCATTER_DIRECTIONS}; k = k + 1) {
    let y = 1.0 - (2.0 * f32(k) + 1.0) / ${MULTISCATTER_DIRECTIONS}.0;
    let rr = sqrt(max(0.0, 1.0 - y * y));
    let phi = f32(k) * 2.399963229728653;
    let d = vec3f(rr * cos(phi), y, rr * sin(phi));
    let mu = d.y;
    var ground = -1.0;
    if (hitsGround(r, mu)) { ground = raySphere(r, mu, atm.radii.x); }
    let tMax = select(max(0.0, raySphere(r, mu, atm.radii.y)), ground, ground > 0.0);
    let dt = tMax / ${MULTISCATTER_STEPS}.0;
    var throughput = vec3f(1.0);
    for (var i = 0; i < ${MULTISCATTER_STEPS}; i = i + 1) {
      let t = (f32(i) + 0.3) * dt;
      let p = vec3f(d.x * t, r + d.y * t, d.z * t);
      let pr = length(p);
      let m = mediumAt(pr - atm.radii.x);
      let ts = transmittanceTo(pr, dot(p, sun) / pr);
      let scattering = m.rayleigh + vec3f(m.mie);
      let ext = max(vec3f(1e-9), m.extinction);
      let stepT = exp(-ext * dt);
      let S = scattering * ts * iso;
      L = L + throughput * ((S - S * stepT) / ext);
      f = f + throughput * ((scattering - scattering * stepT) / ext);
      throughput = throughput * stepT;
    }
    if (ground > 0.0) {
      let p = vec3f(d.x * ground, r + d.y * ground, d.z * ground);
      let pr = length(p);
      let muSun = dot(p, sun) / pr;
      L = L + throughput * transmittanceTo(pr, muSun) * max(0.0, muSun) * (atm.mie.w / PI);
    }
  }
  let fms = min(vec3f(0.999), f * iso * 4.0 * PI / ${MULTISCATTER_DIRECTIONS}.0);
  textureStore(outLut, vec2i(id.xy), vec4f(L / ${MULTISCATTER_DIRECTIONS}.0 / (vec3f(1.0) - fms), 1.0));
}
`;

/** The sky's radiance along a view ray (skyRadiance in @cartbox/editor), in WGSL over the two LUTs. */
export const SKY_RADIANCE_WGSL = /* wgsl */ `
fn skyRadiance(d: vec3f, sun: vec3f) -> vec3f {
  let r = atm.radii.x + atm.view.x;
  let mu = d.y;
  var ground = -1.0;
  if (hitsGround(r, mu)) { ground = raySphere(r, mu, atm.radii.x); }
  let tMax = select(max(0.0, raySphere(r, mu, atm.radii.y)), ground, ground > 0.0);
  let c = dot(d, sun);
  let pr = rayleighPhase(c);
  let pm = miePhase(c, atm.mie.z);
  let E = atm.sunE.rgb;
  var L = vec3f(0.0);
  var throughput = vec3f(1.0);
  for (var i = 0; i < ${SKY_STEPS}; i = i + 1) {
    let a0 = f32(i) / ${SKY_STEPS}.0;
    let a1 = f32(i + 1) / ${SKY_STEPS}.0;
    let t0 = tMax * a0 * a0;
    let t1 = tMax * a1 * a1;
    let t = t0 + 0.3 * (t1 - t0);
    let dt = t1 - t0;
    let p = vec3f(d.x * t, r + d.y * t, d.z * t);
    let pR = length(p);
    let m = mediumAt(pR - atm.radii.x);
    let muSun = dot(p, sun) / pR;
    let ts = transmittanceTo(pR, muSun);
    let ms = multiScatteringAt(pR - atm.radii.x, muSun);
    let ext = max(vec3f(1e-9), m.extinction);
    let stepT = exp(-ext * dt);
    let S = E * ((m.rayleigh * pr + vec3f(m.mie * pm)) * ts + ms * (m.rayleigh + vec3f(m.mie)));
    L = L + throughput * ((S - S * stepT) / ext);
    throughput = throughput * stepT;
  }
  if (ground > 0.0) {
    let p = vec3f(d.x * ground, r + d.y * ground, d.z * ground);
    let pR = length(p);
    let muSun = dot(p, sun) / pR;
    L = L + throughput * transmittanceTo(pR, muSun) * max(0.0, muSun) * (atm.mie.w / PI) * E;
  }
  return L;
}
`;

/** The sky-view LUT's pass. */
export const SKY_VIEW_WGSL = /* wgsl */ `
${ATMOSPHERE_COMMON_WGSL}
${LUT_BINDINGS_WGSL}
@group(0) @binding(4) var outLut: texture_storage_2d<rgba16float, write>;
${LOOKUPS_WGSL}
${SKY_RADIANCE_WGSL}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${SKY_VIEW_WIDTH}u || id.y >= ${SKY_VIEW_HEIGHT}u) { return; }
  let u = (f32(id.x) + 0.5) / ${SKY_VIEW_WIDTH}.0;
  let v = (f32(id.y) + 0.5) / ${SKY_VIEW_HEIGHT}.0;
  let r = atm.radii.x + atm.view.x;
  let beta = acos(min(1.0, sqrt(max(0.0, r * r - atm.radii.x * atm.radii.x)) / r));
  let horizon = PI - beta;
  var zenith: f32;
  if (v < 0.5) {
    let k = 1.0 - 2.0 * v;
    zenith = horizon * (1.0 - k * k);
  } else {
    let k = 2.0 * v - 1.0;
    zenith = horizon + beta * k * k;
  }
  let cosAz = 1.0 - 2.0 * u * u;
  let sinAz = sqrt(max(0.0, 1.0 - cosAz * cosAz));
  let d = vec3f(sin(zenith) * cosAz, cos(zenith), sin(zenith) * sinAz);
  let muS = atm.sun.y;
  let sun = vec3f(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  textureStore(outLut, vec2i(id.xy), vec4f(skyRadiance(d, sun), 1.0));
}
`;

/** The WGSL that reads the sky view along a world direction (skyViewUv), for the presenter's backdrop. */
export const SKY_VIEW_UV_WGSL = /* wgsl */ `
// The sky view's (u, v) for a world view direction d under a sun toward s, a viewer at radius r over a ground of radius bottom.
fn skyViewUv(d: vec3f, s: vec3f, r: f32, bottom: f32) -> vec2f {
  let beta = acos(min(1.0, sqrt(max(0.0, r * r - bottom * bottom)) / r));
  let horizon = 3.14159265 - beta;
  let zenith = acos(clamp(d.y, -1.0, 1.0));
  var v: f32;
  if (zenith < horizon) { v = (1.0 - sqrt(max(0.0, 1.0 - zenith / horizon))) * 0.5; }
  else { v = (sqrt(min(1.0, (zenith - horizon) / beta)) + 1.0) * 0.5; }
  let dh = length(d.xz);
  let sh = length(s.xz);
  var cosAz = 1.0;
  if (dh > 1e-6 && sh > 1e-6) { cosAz = dot(d.xz, s.xz) / (dh * sh); }
  return vec2f(sqrt(max(0.0, (1.0 - clamp(cosAz, -1.0, 1.0)) * 0.5)), v);
}
`;

const USAGE = { textureBinding: 0x04, storage: 0x08, copySrc: 0x01, uniform: 0x40, copyDst: 0x08 } as const;

/**
 * The atmosphere's LUTs on a device: the transmittance and multiple
 * scattering built once per medium, the sky view whenever the sun or the
 * view's height changes.
 */
export class GpuAtmosphere {
  readonly transmittance: any;
  readonly multiScattering: any;
  readonly skyView: any;
  private readonly sampler: any;
  private readonly uniforms: any;
  private readonly data = new Float32Array(ATMOSPHERE_UNIFORM_FLOATS);
  private readonly pipelines: { transmittance: any; multiScattering: any; skyView: any };
  private mediumKey = "";
  private viewKey = "";

  constructor(private readonly device: any) {
    const texture = (width: number, height: number) => device.createTexture({ size: { width, height }, format: "rgba16float", usage: USAGE.textureBinding | USAGE.storage | USAGE.copySrc });
    this.transmittance = texture(TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT);
    this.multiScattering = texture(MULTISCATTER_SIZE, MULTISCATTER_SIZE);
    this.skyView = texture(SKY_VIEW_WIDTH, SKY_VIEW_HEIGHT);
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    this.uniforms = device.createBuffer({ size: ATMOSPHERE_UNIFORM_FLOATS * 4, usage: USAGE.uniform | USAGE.copyDst });
    const pipeline = (code: string) => device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
    this.pipelines = { transmittance: pipeline(TRANSMITTANCE_WGSL), multiScattering: pipeline(MULTISCATTER_WGSL), skyView: pipeline(SKY_VIEW_WGSL) };
  }

  /** Bring the LUTs up to `sky` (a submit of its own when anything changed); true when the sky view was rebuilt. */
  update(sky: AtmosphereSky): boolean {
    const medium = atmosphereKey(sky.atmosphere);
    const view = [medium, sky.atmosphere.viewHeight, ...sky.sun.map((v) => v.toFixed(5)), ...sky.sunRadiance.map((v) => v.toPrecision(5))].join("|");
    if (view === this.viewKey) return false;
    this.device.queue.writeBuffer(this.uniforms, 0, packAtmosphereUniforms(sky, this.data));
    const encoder = this.device.createCommandEncoder();
    const run = (pipeline: any, entries: { binding: number; resource: any }[], width: number, height: number) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
      pass.end();
    };
    const uniform = { binding: 0, resource: { buffer: this.uniforms } };
    if (medium !== this.mediumKey) {
      run(this.pipelines.transmittance, [uniform, { binding: 1, resource: this.transmittance.createView() }], TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT);
      run(
        this.pipelines.multiScattering,
        [uniform, { binding: 1, resource: this.sampler }, { binding: 2, resource: this.transmittance.createView() }, { binding: 3, resource: this.multiScattering.createView() }],
        MULTISCATTER_SIZE,
        MULTISCATTER_SIZE,
      );
      this.mediumKey = medium;
    }
    run(
      this.pipelines.skyView,
      [
        uniform,
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.transmittance.createView() },
        { binding: 3, resource: this.multiScattering.createView() },
        { binding: 4, resource: this.skyView.createView() },
      ],
      SKY_VIEW_WIDTH,
      SKY_VIEW_HEIGHT,
    );
    this.device.queue.submit([encoder.finish()]);
    this.viewKey = view;
    return true;
  }

  dispose(): void {
    for (const t of [this.transmittance, this.multiScattering, this.skyView]) t.destroy?.();
    this.uniforms.destroy?.();
  }
}
