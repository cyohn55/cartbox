/**
 * Volumetric effects on the linear-light renderer (AAA_FIDELITY_ROADMAP.md
 * F8b; volumetricEffects.ts in @cartbox/editor): each live volume's fluid
 * solved in compute, then every volume raymarched over the scene.
 *
 * - **The solver** runs on storage buffers, cell for cell as the CPU's: forces
 *   (the sources, buoyancy), semi-Lagrangian advection (trilinear by hand, so
 *   the two agree), the divergence, Jacobi iterations for the pressure, and
 *   the gradient taken away with dissipation. A baked volume uploads its
 *   frame instead. Either way the density and temperature land in a 3D
 *   texture the march filters.
 * - **The march** (a full-screen pass after the opaque scene): each pixel's
 *   ray clipped to each volume's box and to the scene's depth, 48 steps
 *   through it. A step's smoke scatters the sun (its light through the smoke
 *   toward the sun, six steps) and the ambient; its fire emits a blackbody's
 *   light by its temperature. The colour becomes colour × T + L.
 * - **The fog** takes their light: a burning volume adds a point light to the
 *   frame's lights (`volumeLight`), which the scene and the froxel fog (F5b)
 *   both shade by.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { PRESSURE_ITERATIONS, bakeVolume, burn, effectSources, type BakedVolume, type FluidSource, type VolumeEffect } from "@cartbox/editor";

/** The most volumes alive at once. */
export const MAX_LIVE_VOLUMES = 4;
const MARCH_STEPS = 48;

/** The solver's uniform: n and the sources' count; dt, buoyancy, what density and heat keep a step; then up to four sources (centre + radius; density, heat, rise). */
export function packSolver(n: number, effect: Pick<VolumeEffect, "buoyancy" | "dissipation" | "cooling">, sources: readonly FluidSource[], dt: number): ArrayBuffer {
  const buffer = new ArrayBuffer(16 * 10);
  const u = new Uint32Array(buffer);
  const f = new Float32Array(buffer);
  u[0] = n;
  u[1] = Math.min(4, sources.length);
  f.set([dt, effect.buoyancy, Math.exp(-effect.dissipation * dt), Math.exp(-effect.cooling * dt)], 4);
  sources.slice(0, 4).forEach((s, k) => {
    f.set([s.center[0], s.center[1], s.center[2], s.radius], 8 + k * 8);
    f.set([s.density, s.temperature, s.velocity[1], 0], 12 + k * 8);
  });
  return buffer;
}

const SOLVER_COMMON = /* wgsl */ `
struct Solver {
  info: vec4<u32>,  // n, sources
  terms: vec4<f32>, // dt, buoyancy, what density and heat keep a step
  sources: array<vec4<f32>, 8>, // centre + radius; density, heat, rise
};
@group(0) @binding(0) var<uniform> s: Solver;
fn idx(x: i32, y: i32, z: i32) -> u32 {
  let n = i32(s.info.x);
  return u32((clamp(z, 0, n - 1) * n + clamp(y, 0, n - 1)) * n + clamp(x, 0, n - 1));
}
fn cellOf(i: u32) -> vec3<i32> {
  let n = s.info.x;
  return vec3<i32>(i32(i % n), i32((i / n) % n), i32(i / (n * n)));
}
`;

/** Forces: 1 velocity (vec4 a cell: xyz), 2 density and heat (vec2 a cell). In place. */
export const SOLVER_FORCES_WGSL = /* wgsl */ `${SOLVER_COMMON}
@group(0) @binding(1) var<storage, read_write> vel: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> dt2: array<vec2<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = s.info.x;
  let i = id.x;
  if (i >= n * n * n) { return; }
  let c = vec3<f32>(cellOf(i)) + vec3<f32>(0.5);
  var v = vel[i].xyz;
  var q = dt2[i];
  let dt = s.terms.x;
  for (var k = 0u; k < s.info.y; k = k + 1u) {
    let a = s.sources[k * 2u];
    let b = s.sources[k * 2u + 1u];
    let d = length(c - a.xyz);
    if (d >= a.w) { continue; }
    let w = 1.0 - d / a.w;
    q = q + vec2<f32>(b.x, b.y) * w * dt;
    v.y = v.y + b.z * w * dt;
  }
  v.y = v.y + s.terms.y * q.y * dt;
  vel[i] = vec4<f32>(v, 0.0);
  dt2[i] = q;
}
`;

/** Advect: 1 velocity in, 2 density/heat in, 3 velocity out, 4 density/heat out. */
export const SOLVER_ADVECT_WGSL = /* wgsl */ `${SOLVER_COMMON}
@group(0) @binding(1) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> dt2: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> velOut: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> dt2Out: array<vec2<f32>>;
fn tri(p: vec3<f32>) -> mat2x4<f32> {
  let n = f32(s.info.x);
  let cp = clamp(p - vec3<f32>(0.5), vec3<f32>(0.0), vec3<f32>(n - 1.0));
  let b = vec3<i32>(min(floor(cp), vec3<f32>(n - 2.0)));
  let f = cp - vec3<f32>(b);
  var v = vec4<f32>(0.0);
  var q = vec4<f32>(0.0);
  for (var k = 0; k < 8; k = k + 1) {
    let o = vec3<i32>(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    let w = select(1.0 - f.x, f.x, o.x == 1) * select(1.0 - f.y, f.y, o.y == 1) * select(1.0 - f.z, f.z, o.z == 1);
    let j = idx(b.x + o.x, b.y + o.y, b.z + o.z);
    v = v + vel[j] * w;
    q = q + vec4<f32>(dt2[j], 0.0, 0.0) * w;
  }
  return mat2x4<f32>(v, q);
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = s.info.x;
  let i = id.x;
  if (i >= n * n * n) { return; }
  let c = vec3<f32>(cellOf(i)) + vec3<f32>(0.5);
  let p = c - vel[i].xyz * s.terms.x;
  let m = tri(p);
  velOut[i] = vec4<f32>(m[0].xyz, 0.0);
  dt2Out[i] = m[1].xy;
}
`;

/** Divergence: 1 velocity, 2 the divergence out (solid walls: a neighbour beyond one mirrors the normal component). */
export const SOLVER_DIVERGENCE_WGSL = /* wgsl */ `${SOLVER_COMMON}
@group(0) @binding(1) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> div: array<f32>;
fn comp(x: i32, y: i32, z: i32, c: i32) -> f32 {
  let n = i32(s.info.x);
  var sign = 1.0;
  if ((x < 0 || x >= n) && c == 0) { sign = -1.0; }
  if ((y < 0 || y >= n) && c == 1) { sign = -1.0; }
  if ((z < 0 || z >= n) && c == 2) { sign = -1.0; }
  return sign * vel[idx(x, y, z)][c];
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = s.info.x;
  let i = id.x;
  if (i >= n * n * n) { return; }
  let c = cellOf(i);
  div[i] = 0.5 * (comp(c.x + 1, c.y, c.z, 0) - comp(c.x - 1, c.y, c.z, 0) + comp(c.x, c.y + 1, c.z, 1) - comp(c.x, c.y - 1, c.z, 1) + comp(c.x, c.y, c.z + 1, 2) - comp(c.x, c.y, c.z - 1, 2));
}
`;

/** A Jacobi iteration: 1 pressure in, 2 out, 3 the divergence. */
export const SOLVER_JACOBI_WGSL = /* wgsl */ `${SOLVER_COMMON}
@group(0) @binding(1) var<storage, read> pIn: array<f32>;
@group(0) @binding(2) var<storage, read_write> pOut: array<f32>;
@group(0) @binding(3) var<storage, read> div: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = s.info.x;
  let i = id.x;
  if (i >= n * n * n) { return; }
  let c = cellOf(i);
  let sum = pIn[idx(c.x - 1, c.y, c.z)] + pIn[idx(c.x + 1, c.y, c.z)] + pIn[idx(c.x, c.y - 1, c.z)] + pIn[idx(c.x, c.y + 1, c.z)] + pIn[idx(c.x, c.y, c.z - 1)] + pIn[idx(c.x, c.y, c.z + 1)];
  pOut[i] = (sum - div[i]) / 6.0;
}
`;

/** Project and fade: 1 pressure, 2 advected velocity, 3 advected density/heat, 4 velocity out, 5 density/heat out, 6 the 3D texture. */
export const SOLVER_PROJECT_WGSL = /* wgsl */ `${SOLVER_COMMON}
@group(0) @binding(1) var<storage, read> p: array<f32>;
@group(0) @binding(2) var<storage, read> vel: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> dt2: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> velOut: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> dt2Out: array<vec2<f32>>;
@group(0) @binding(6) var volume: texture_storage_3d<rgba16float, write>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = s.info.x;
  let i = id.x;
  if (i >= n * n * n) { return; }
  let c = cellOf(i);
  let grad = 0.5 * vec3<f32>(p[idx(c.x + 1, c.y, c.z)] - p[idx(c.x - 1, c.y, c.z)], p[idx(c.x, c.y + 1, c.z)] - p[idx(c.x, c.y - 1, c.z)], p[idx(c.x, c.y, c.z + 1)] - p[idx(c.x, c.y, c.z - 1)]);
  velOut[i] = vec4<f32>(vel[i].xyz - grad, 0.0);
  let q = dt2[i] * vec2<f32>(s.terms.z, s.terms.w);
  dt2Out[i] = q;
  textureStore(volume, c, vec4<f32>(q, 0.0, 1.0));
}
`;

/** The march's uniform (vec4s): the inverse view-projection, the eye, the sun, the ambient, then per volume four vec4s. */
export function packMarch(frame: { invViewProj: ArrayLike<number>; eye: readonly number[]; sun: readonly number[]; sunColor: readonly number[]; ambient: number; depthTerms: readonly [number, number]; width: number; height: number }, volumes: readonly { at: readonly number[]; effect: VolumeEffect; burn: number; tempScale: number }[]): Float32Array {
  const out = new Float32Array(16 + 4 * 4 + MAX_LIVE_VOLUMES * 16);
  for (let i = 0; i < 16; i += 1) out[i] = frame.invViewProj[i]!;
  out.set([frame.eye[0]!, frame.eye[1]!, frame.eye[2]!, volumes.length], 16);
  out.set([frame.sun[0]!, frame.sun[1]!, frame.sun[2]!, frame.ambient], 20);
  out.set([frame.sunColor[0]!, frame.sunColor[1]!, frame.sunColor[2]!, 0], 24);
  out.set([frame.depthTerms[0], frame.depthTerms[1], frame.width, frame.height], 28);
  volumes.slice(0, MAX_LIVE_VOLUMES).forEach((v, k) => {
    const o = 32 + k * 16;
    const h = v.effect.size / 2;
    // The box's corner (its base centred on the point) and size; the smoke's colour and extinction a unit of density a
    // metre; the fire's peak temperature, its glow, how brightly it burns now, and the heat that reaches the peak.
    out.set([v.at[0]! - h, v.at[1]!, v.at[2]! - h, v.effect.size], o);
    out.set([...v.effect.color, v.effect.absorption], o + 4);
    out.set([v.effect.temperature, v.effect.emission, v.burn, v.tempScale], o + 8);
  });
  return out;
}

/** The march: 0 its uniform, 1 the scene's depths, 2 a sampler, 3–6 the volumes' textures. */
export const VOLUME_MARCH_WGSL = /* wgsl */ `
struct March {
  invViewProj: mat4x4<f32>,
  eye: vec4<f32>,      // eye, volume count
  sun: vec4<f32>,      // toward the sun, ambient
  sunColor: vec4<f32>,
  screen: vec4<f32>,   // depth terms, width, height
  volumes: array<vec4<f32>, ${MAX_LIVE_VOLUMES * 4}>,
};
@group(0) @binding(0) var<uniform> m: March;
@group(0) @binding(1) var sceneDepth: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var vol0: texture_3d<f32>;
@group(0) @binding(4) var vol1: texture_3d<f32>;
@group(0) @binding(5) var vol2: texture_3d<f32>;
@group(0) @binding(6) var vol3: texture_3d<f32>;

fn density(k: u32, uvw: vec3<f32>) -> vec2<f32> {
  switch (k) {
    case 0u: { return textureSampleLevel(vol0, samp, uvw, 0.0).xy; }
    case 1u: { return textureSampleLevel(vol1, samp, uvw, 0.0).xy; }
    case 2u: { return textureSampleLevel(vol2, samp, uvw, 0.0).xy; }
    default: { return textureSampleLevel(vol3, samp, uvw, 0.0).xy; }
  }
}
// The blackbody fit (blackbody in the editor), linear, brightening as T⁴ about 1500 K.
fn blackbody(kelvin: f32) -> vec3<f32> {
  if (kelvin < 500.0) { return vec3<f32>(0.0); }
  let t = kelvin / 100.0;
  var r = 255.0;
  var g = 99.4708025861 * log(t) - 161.1195681661;
  var b = 255.0;
  if (t > 66.0) { r = 329.698727446 * pow(t - 60.0, -0.1332047592); g = 288.1221695283 * pow(t - 60.0, -0.0755148492); }
  if (t < 66.0) { b = select(138.5177312231 * log(t - 10.0) - 305.0447927307, 0.0, t <= 19.0); }
  let c = clamp(vec3<f32>(r, g, b), vec3<f32>(0.0), vec3<f32>(255.0)) / 255.0;
  let lin = select(pow((c + vec3<f32>(0.055)) / 1.055, vec3<f32>(2.4)), c / 12.92, c <= vec3<f32>(0.04045));
  return lin * pow(kelvin / 1500.0, 4.0);
}

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) ndc: vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - vec2<f32>(1.0);
  return VsOut(vec4<f32>(p, 0.0, 1.0), p);
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let far = m.invViewProj * vec4<f32>(in.ndc, 1.0, 1.0);
  let dir = normalize(far.xyz / far.w - m.eye.xyz);
  // The scene's surface along the ray: the march stops there.
  let surface = textureLoad(sceneDepth, vec2<i32>(in.pos.xy), 0);
  var limit = 1e9;
  if (surface < 1.0) {
    let wp = m.invViewProj * vec4<f32>(in.ndc, surface, 1.0);
    limit = length(wp.xyz / wp.w - m.eye.xyz);
  }
  var T = 1.0;
  var L = vec3<f32>(0.0);
  let count = u32(m.eye.w + 0.5);
  for (var k = 0u; k < count; k = k + 1u) {
    let box = m.volumes[k * 4u];
    let look = m.volumes[k * 4u + 1u];
    let fire = m.volumes[k * 4u + 2u];
    let lo = box.xyz;
    let hi = box.xyz + vec3<f32>(box.w);
    let inv = 1.0 / dir;
    let t0 = (lo - m.eye.xyz) * inv;
    let t1 = (hi - m.eye.xyz) * inv;
    let tn = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), max(min(t0.z, t1.z), 0.0));
    let tf = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), min(max(t0.z, t1.z), limit));
    if (tf <= tn) { continue; }
    let step = (tf - tn) / ${MARCH_STEPS}.0;
    for (var s = 0; s < ${MARCH_STEPS}; s = s + 1) {
      let p = m.eye.xyz + dir * (tn + (f32(s) + 0.5) * step);
      let uvw = (p - lo) / box.w;
      let q = density(k, uvw);
      let sigma = q.x * look.w;
      if (sigma <= 1e-5 && q.y <= 1e-4) { continue; }
      // Toward the sun through the smoke: six steps to the box's edge.
      var shadow = 1.0;
      if (sigma > 1e-5) {
        var od = 0.0;
        for (var j = 1; j <= 6; j = j + 1) {
          let sp = (p + m.sun.xyz * (f32(j) * box.w / 12.0) - lo) / box.w;
          if (any(sp < vec3<f32>(0.0)) || any(sp > vec3<f32>(1.0))) { break; }
          od = od + density(k, sp).x * look.w * box.w / 12.0;
        }
        shadow = exp(-od);
      }
      let scatter = look.rgb * (m.sunColor.rgb * shadow * 0.25 + vec3<f32>(m.sun.w));
      let kelvin = fire.x * clamp(q.y / max(fire.w, 1e-4), 0.0, 1.0);
      let glow = blackbody(kelvin) * fire.y * fire.z;
      let a = exp(-sigma * step);
      L = L + T * (scatter * (1.0 - a) + glow * step);
      T = T * a;
    }
  }
  return vec4<f32>(L, T);
}
`;

/** A live volume: where, since when, and its solver's buffers (or baked frames). */
interface LiveVolume {
  readonly effect: VolumeEffect;
  readonly at: readonly number[];
  age: number;
  readonly n: number;
  readonly texture: any;
  readonly buffers: any[] | null;
  readonly baked: BakedVolume | null;
  heat: number;
}

/** The volumes: triggered, simulated each frame, marched over the scene. */
export class GpuVolumes {
  private readonly live: LiveVolume[] = [];
  private pipes: { forces: any; advect: any; divergence: any; jacobi: any; project: any; march: any } | null = null;
  private readonly baked = new Map<VolumeEffect, BakedVolume>();
  private dummy: any = null;
  private sampler: any = null;
  private readonly uniform: any;
  private readonly marchUniform: any;

  constructor(private readonly device: any, private readonly colourFormat: string, readonly effects: readonly VolumeEffect[]) {
    this.uniform = device.createBuffer({ size: 160, usage: 0x40 | 0x08 });
    this.marchUniform = device.createBuffer({ size: (16 + 16 + MAX_LIVE_VOLUMES * 16) * 4, usage: 0x40 | 0x08 });
  }

  get active(): boolean {
    return this.live.length > 0;
  }

  /** The volumes alive, for the lights they cast and the tests. */
  get volumes(): readonly { readonly effect: VolumeEffect; readonly at: readonly number[]; readonly age: number; readonly texture: any }[] {
    return this.live;
  }

  /** Start effect `index` at `at` (its base's centre); the oldest goes when four are alive. */
  trigger(index: number, at: readonly number[]): void {
    const effect = this.effects[index];
    if (!effect) return;
    if (this.live.length >= MAX_LIVE_VOLUMES) this.dispose1(this.live.shift()!);
    const baked = effect.source === "baked" ? (this.baked.get(effect) ?? this.bake(effect)) : null;
    const n = baked ? baked.n : effect.resolution;
    const texture = this.device.createTexture({ size: { width: n, height: n, depthOrArrayLayers: n }, dimension: "3d", format: "rgba16float", usage: 0x04 | 0x08 | 0x02 }); // TEXTURE_BINDING | STORAGE | COPY_DST
    const cells = n * n * n;
    const buffer = (bytes: number) => this.device.createBuffer({ size: bytes, usage: 0x80 | 0x08 | 0x04 });
    const buffers = baked ? null : [buffer(cells * 16), buffer(cells * 8), buffer(cells * 16), buffer(cells * 8), buffer(cells * 4), buffer(cells * 4), buffer(cells * 4)];
    this.live.push({ effect, at, age: 0, n, texture, buffers, baked, heat: 1 });
  }

  private bake(effect: VolumeEffect): BakedVolume {
    const baked = bakeVolume(effect);
    this.baked.set(effect, baked);
    return baked;
  }

  private pipelines(): NonNullable<GpuVolumes["pipes"]> {
    if (this.pipes) return this.pipes;
    const device = this.device;
    const compute = (code: string) => device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
    const module = device.createShaderModule({ code: VOLUME_MARCH_WGSL });
    this.pipes = {
      forces: compute(SOLVER_FORCES_WGSL),
      advect: compute(SOLVER_ADVECT_WGSL),
      divergence: compute(SOLVER_DIVERGENCE_WGSL),
      jacobi: compute(SOLVER_JACOBI_WGSL),
      project: compute(SOLVER_PROJECT_WGSL),
      march: device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        // colour × T + L: the march returns L with T in alpha.
        fragment: { module, entryPoint: "fs", targets: [{ format: this.colourFormat, blend: { color: { srcFactor: "one", dstFactor: "src-alpha", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } } }] },
        primitive: { topology: "triangle-list" },
      }),
    };
    return this.pipes;
  }

  /** Advance every live volume by `dt`: the solver's passes (one volume's uniform at a time, a submit each) or its baked frame. */
  simulate(dt: number): void {
    const device = this.device;
    const pipes = this.pipelines();
    for (const v of [...this.live]) {
      v.age += dt;
      if (v.age > v.effect.duration) {
        this.dispose1(v);
        this.live.splice(this.live.indexOf(v), 1);
        continue;
      }
      const n = v.n;
      if (v.baked) {
        const frame = v.baked.frames[Math.min(v.baked.frames.length - 1, Math.floor(v.age * v.baked.rate))]!;
        const data = new Uint16Array(n * n * n * 4);
        for (let i = 0; i < n * n * n; i += 1) {
          data[i * 4] = toHalf((frame.density[i]! / 255) * 4);
          data[i * 4 + 1] = toHalf((frame.temperature[i]! / 255) * 8);
          data[i * 4 + 3] = toHalf(1);
        }
        device.queue.writeTexture({ texture: v.texture }, data, { bytesPerRow: n * 8, rowsPerImage: n }, { width: n, height: n, depthOrArrayLayers: n });
        continue;
      }
      const [vel, q, velB, qB, div, pA, pB] = v.buffers!;
      device.queue.writeBuffer(this.uniform, 0, packSolver(n, v.effect, effectSources(v.effect, n, v.age - dt), dt));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      const groups = Math.ceil((n * n * n) / 64);
      const run = (pipe: any, buffers: any[]) => {
        pass.setPipeline(pipe);
        pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [this.uniform, ...buffers].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
        pass.dispatchWorkgroups(groups);
      };
      run(pipes.forces, [vel, q]);
      run(pipes.advect, [vel, q, velB, qB]);
      run(pipes.divergence, [velB, div]);
      // The pressure from zero each step, as the CPU's.
      pass.end();
      encoder.clearBuffer(pA);
      const pass2 = encoder.beginComputePass();
      for (let it = 0; it < PRESSURE_ITERATIONS; it += 1) {
        const [from, to] = it % 2 === 0 ? [pA, pB] : [pB, pA];
        pass2.setPipeline(pipes.jacobi);
        pass2.setBindGroup(0, device.createBindGroup({ layout: pipes.jacobi.getBindGroupLayout(0), entries: [this.uniform, from, to, div].map((buffer, binding) => ({ binding, resource: { buffer } })) }));
        pass2.dispatchWorkgroups(groups);
      }
      pass2.setPipeline(pipes.project);
      pass2.setBindGroup(0, device.createBindGroup({
        layout: pipes.project.getBindGroupLayout(0),
        entries: [{ buffer: this.uniform }, { buffer: PRESSURE_ITERATIONS % 2 === 0 ? pA : pB }, { buffer: velB }, { buffer: qB }, { buffer: vel }, { buffer: q }, v.texture.createView()].map((resource, binding) => ({ binding, resource })),
      }));
      pass2.dispatchWorkgroups(groups);
      pass2.end();
      device.queue.submit([encoder.finish()]);
    }
  }

  /** The solver's buffers of a live volume (velocity, density/heat), for the tests. */
  state(k: number): { velocity: any; fields: any; n: number } | null {
    const v = this.live[k];
    return v?.buffers ? { velocity: v.buffers[0], fields: v.buffers[1], n: v.n } : null;
  }

  /** March every volume over the scene: into an open render pass whose colour is the scene and that reads its depths. */
  march(pass: any, frame: Parameters<typeof packMarch>[0], depth: any): void {
    if (this.live.length === 0) return;
    const device = this.device;
    const pipes = this.pipelines();
    this.dummy ??= device.createTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 1 }, dimension: "3d", format: "rgba16float", usage: 0x04 });
    this.sampler ??= device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
    const uniform = packMarch(frame, this.live.map((v) => ({ at: v.at, effect: v.effect, burn: burn(v.effect, v.age), tempScale: 8 })));
    device.queue.writeBuffer(this.marchUniform, 0, uniform);
    const textures = [0, 1, 2, 3].map((k) => (this.live[k]?.texture ?? this.dummy).createView());
    pass.setPipeline(pipes.march);
    pass.setBindGroup(0, device.createBindGroup({ layout: pipes.march.getBindGroupLayout(0), entries: [{ buffer: this.marchUniform }, depth.createView(), this.sampler, ...textures].map((resource, binding) => ({ binding, resource })) }));
    pass.draw(3);
  }

  private dispose1(v: LiveVolume): void {
    v.texture.destroy?.();
    for (const b of v.buffers ?? []) b.destroy?.();
  }

  dispose(): void {
    for (const v of this.live) this.dispose1(v);
    this.live.length = 0;
    this.uniform.destroy?.();
    this.marchUniform.destroy?.();
    this.dummy?.destroy?.();
  }
}

/** A float as IEEE half bits. */
export function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const x = new Uint32Array(f.buffer)[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const mant = x & 0x7fffff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | (mant >>> 13);
}
