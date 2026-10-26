/**
 * Volumetric fog on the AAA tier (AAA_FIDELITY_ROADMAP.md F5b): the rig's fog
 * as a medium in a froxel grid over the camera, lit by the sun through its
 * GPU cascades (F2a) and by the sky, then integrated front to back, mirroring
 * the CPU reference in @cartbox/editor (volumetricFog.ts) step for step.
 *
 * - **Inject** (a thread a froxel): the medium's extinction at the froxel,
 *   and the light it scatters toward the eye — the sun's through
 *   Henyey–Greenstein's phase and one comparison tap of its cascades, and the
 *   sky's mean radiance. With temporal accumulation on, the sample is jittered
 *   within its froxel each frame and blended into the froxel's history,
 *   reprojected through the last frame's camera, so the shafts converge on
 *   their froxels' means and don't crawl.
 * - **Integrate** (a thread a column): the slices front to back with the
 *   energy-conserving step, into the volume the scene shader samples: at each
 *   slice's centre, the fog's light so far and the transmittance.
 * - **Sample** (the scene shader): each fragment finds its froxel through the
 *   camera's axes, and the colour becomes colour × T + L, filtered by the
 *   hardware in a 3D texture.
 *
 * The grid is a column for every {@link FOG_TILE} pixels (up to 160 × 90) and
 * 64 slices spaced quadratically to the reach.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { FOG_SLICES, aerialCamera, type AerialCamera, type FogLight, type Mat4, type VolumetricFog } from "@cartbox/editor";

import { CASCADE_COUNT, type Cascade } from "./cascades.js";

/** The fog volumes' format: in-scattered RGB and extinction (inject), or transmittance (integrate). */
export const FOG_FORMAT = "rgba16float";

/** How much of a froxel's history a temporal frame keeps. */
export const FOG_HISTORY = 0.9;

/** Floats in the fog passes' uniform block. */
export const FOG_UNIFORM_FLOATS = 100 + CASCADE_COUNT * 16;

/** A camera as the fog reads it: its axes and focal terms, and its eye. */
export interface FogCamera {
  readonly camera: AerialCamera;
  readonly eye: readonly [number, number, number];
}

/** A camera's fog terms from its view matrix (column-major, world → view) and projection. */
export function fogCamera(view: Mat4, projection: Mat4): FogCamera {
  const v = view;
  const eye: [number, number, number] = [-(v[0]! * v[12]! + v[1]! * v[13]! + v[2]! * v[14]!), -(v[4]! * v[12]! + v[5]! * v[13]! + v[6]! * v[14]!), -(v[8]! * v[12]! + v[9]! * v[13]! + v[10]! * v[14]!)];
  return { camera: aerialCamera(view, projection), eye };
}

/** One frame of fog: the medium, its light, the grid, the camera (and last frame's, for the history), and the jitter. */
export interface FogFrame {
  readonly fog: VolumetricFog;
  readonly light: Omit<FogLight, "shadow">;
  readonly grid: readonly [number, number, number];
  readonly camera: FogCamera;
  /** Last frame's camera, when its history may be blended in. */
  readonly previous: FogCamera | null;
  /** Where in its froxel this frame samples, −0.5..0.5 a side (0 at the centre). */
  readonly jitter: readonly [number, number, number];
  /** The sun's cascades to shadow it by, or null for none. */
  readonly cascades: { readonly cascades: readonly Cascade[]; readonly strength: number } | null;
}

/**
 * The passes' uniforms: the grid and reach; the eye (w the history's weight)
 * and the camera's axes with their reciprocal focal terms; the jitter; last
 * frame's eye (w = 1 with a history) and axes with their focal terms; the sun
 * toward it (w its anisotropy) and its π E (w = 1 shadowed); the sky's light;
 * the albedo (w the distance fog's density); the height fog (w the box
 * count) and the boxes; the cascades' strength and texels and matrices.
 */
export function packFogUniforms(frame: FogFrame, out = new Float32Array(FOG_UNIFORM_FLOATS)): Float32Array {
  out.fill(0);
  const v = frame.fog;
  const { camera, eye } = frame.camera;
  const history = frame.previous !== null;
  out.set([...frame.grid, v.distance], 0);
  out.set([...eye, history ? FOG_HISTORY : 0], 4);
  out.set([...camera.right, 1 / camera.focalX], 8);
  out.set([...camera.up, 1 / camera.focalY], 12);
  out.set([...camera.back, 0], 16);
  out.set([...frame.jitter, 0], 20);
  if (frame.previous) {
    const p = frame.previous;
    out.set([...p.eye, 1], 24);
    out.set([...p.camera.right, p.camera.focalX], 28);
    out.set([...p.camera.up, p.camera.focalY], 32);
    out.set([...p.camera.back, 0], 36);
  }
  const sun = frame.light.sun;
  if (sun) {
    out.set([...sun.direction, v.anisotropy], 40);
    out.set([...sun.radiance.map((r) => Math.PI * r), frame.cascades ? 1 : 0], 44);
  }
  out.set([...frame.light.sky.map((s) => s * v.ambient), 0], 48);
  out.set([...v.albedo, Math.max(0, v.fog.density)], 52);
  const h = v.fog.height;
  const boxes = (v.fog.volumes ?? []).slice(0, 4);
  out.set([h?.density ?? 0, h?.base ?? 0, h?.falloff ?? 0, boxes.length], 56);
  boxes.forEach((b, i) => {
    out.set([...b.min, b.density], 60 + i * 8);
    out.set([...b.max, b.falloff], 64 + i * 8);
  });
  const c = frame.cascades;
  if (c) {
    out.set([c.strength, 0, 0, 0], 92);
    out.set(c.cascades.slice(0, CASCADE_COUNT).map((k) => k.texel), 96);
    c.cascades.slice(0, CASCADE_COUNT).forEach((k, i) => out.set(k.viewProj, 100 + i * 16));
  }
  return out;
}

const FOG_STRUCT_WGSL = /* wgsl */ `
struct Fog {
  grid: vec4f,      // columns, rows, slices, reach
  eye: vec4f,       // w: the history's weight
  right: vec4f,     // w: 1 / P[0]
  up: vec4f,        // w: 1 / P[5]
  back: vec4f,
  jitter: vec4f,
  prevEye: vec4f,   // w: 1 with a history
  prevRight: vec4f, // w: P[0]
  prevUp: vec4f,    // w: P[5]
  prevBack: vec4f,
  sun: vec4f,       // toward it, w: anisotropy
  sunE: vec4f,      // π × its radiance, w: 1 when shadowed
  sky: vec4f,       // the sky's mean radiance × the ambient setting
  albedo: vec4f,    // w: the distance fog's density
  height: vec4f,    // density, base, falloff, box count
  boxes: array<vec4f, 8>,
  cascade: vec4f,   // x: strength
  cascadeTexel: vec4f,
  cascadeVp: array<mat4x4f, ${CASCADE_COUNT}>,
};
@group(0) @binding(0) var<uniform> fog: Fog;
`;

/** The inject pass: each froxel's extinction and in-scattered light, blended into its reprojected history. */
export const FOG_INJECT_WGSL = /* wgsl */ `
${FOG_STRUCT_WGSL}
@group(0) @binding(1) var history: texture_3d<f32>;
@group(0) @binding(2) var linearSamp: sampler;
@group(0) @binding(3) var cascadeMap: texture_depth_2d_array;
@group(0) @binding(4) var cascadeSamp: sampler_comparison;
@group(0) @binding(5) var outLight: texture_storage_3d<rgba16float, write>;

fn extinction(p: vec3f) -> f32 {
  var sigma = fog.albedo.w;
  if (fog.height.x > 0.0) { sigma = sigma + fog.height.x * exp(-fog.height.z * max(0.0, p.y - fog.height.y)); }
  let n = i32(fog.height.w + 0.5);
  for (var i = 0; i < n; i = i + 1) {
    let a = fog.boxes[i * 2];
    let b = fog.boxes[i * 2 + 1];
    if (a.w > 0.0 && all(p >= a.xyz) && all(p <= b.xyz)) { sigma = sigma + a.w * exp(-b.w * max(0.0, p.y - a.y)); }
  }
  return sigma;
}
fn phase(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(1e-6, 1.0 + g2 - 2.0 * g * c), 1.5));
}
// The sun's shadow at p: one comparison tap of the first cascade that holds it, a texel and a half toward the sun.
fn sunShadow(p: vec3f) -> f32 {
  if (fog.sunE.w < 0.5) { return 1.0; }
  for (var i = 0; i < ${CASCADE_COUNT}; i = i + 1) {
    let q = fog.cascadeVp[i] * vec4f(p + fog.sun.xyz * (1.5 * fog.cascadeTexel[i]), 1.0);
    if (max(abs(q.x), abs(q.y)) < 1.0 && q.z > 0.0 && q.z < 1.0) {
      let lit = textureSampleCompareLevel(cascadeMap, cascadeSamp, vec2f(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5), i, q.z);
      return 1.0 - fog.cascade.x * (1.0 - lit);
    }
  }
  return 1.0;
}
fn froxelRay(u: f32, v: f32) -> vec3f {
  return normalize(fog.right.xyz * ((u * 2.0 - 1.0) * fog.right.w) + fog.up.xyz * ((1.0 - v * 2.0) * fog.up.w) - fog.back.xyz);
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = vec3u(fog.grid.xyz + vec3f(0.5));
  if (any(id >= n)) { return; }
  let size = vec3f(n);
  let reach = fog.grid.w;
  let at = (vec3f(id) + vec3f(0.5) + fog.jitter.xyz) / size;
  let d = froxelRay(at.x, at.y);
  let p = fog.eye.xyz + d * (at.z * at.z * reach);
  let sigma = extinction(p);
  let sun = fog.sunE.rgb * phase(dot(d, fog.sun.xyz), fog.sun.w) * sunShadow(p);
  var current = vec4f(fog.albedo.rgb * (sun + fog.sky.rgb) * sigma, sigma);
  if (fog.prevEye.w > 0.5) {
    // The froxel's centre, as last frame's camera saw it.
    let c = (vec3f(id) + vec3f(0.5)) / size;
    let pc = fog.eye.xyz + froxelRay(c.x, c.y) * (c.z * c.z * reach);
    let r = pc - fog.prevEye.xyz;
    let ahead = -dot(r, fog.prevBack.xyz);
    if (ahead > 1e-4) {
      let was = vec3f((dot(r, fog.prevRight.xyz) / ahead * fog.prevRight.w + 1.0) * 0.5, (1.0 - dot(r, fog.prevUp.xyz) / ahead * fog.prevUp.w) * 0.5, sqrt(length(r) / reach));
      if (all(was >= vec3f(0.0)) && all(was <= vec3f(1.0))) {
        current = mix(current, textureSampleLevel(history, linearSamp, was, 0.0), fog.eye.w);
      }
    }
  }
  textureStore(outLight, vec3i(id), current);
}
`;

/** The integrate pass: each column front to back, into the volume the scene samples. */
export const FOG_INTEGRATE_WGSL = /* wgsl */ `
${FOG_STRUCT_WGSL}
@group(0) @binding(1) var lightVolume: texture_3d<f32>;
@group(0) @binding(2) var outVolume: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = vec3u(fog.grid.xyz + vec3f(0.5));
  if (id.x >= n.x || id.y >= n.y) { return; }
  let reach = fog.grid.w;
  var L = vec3f(0.0);
  var T = 1.0;
  var t = 0.0;
  for (var z = 0u; z < n.z; z = z + 1u) {
    let w = (f32(z) + 0.5) / f32(n.z);
    let end = w * w * reach;
    let s = textureLoad(lightVolume, vec3i(vec3u(id.xy, z)), 0);
    let dt = end - t;
    let step = exp(-s.a * dt);
    if (s.a > 1e-9) { L = L + T * (s.rgb - s.rgb * step) / s.a; } else { L = L + T * s.rgb * dt; }
    T = T * step;
    t = end;
    textureStore(outVolume, vec3i(vec3u(id.xy, z)), vec4f(L, T));
  }
}
`;

/** Floats in the scene's frame block for the fog: the eye (w = 1 when on), and right, up and back with P[0], P[5] and the reach. */
export const FOG_FRAME_FLOATS = 16;

/** The scene shader's fog terms for this frame's camera, or all zero (off). */
export function packFogFrame(frame: FogFrame | null, out = new Float32Array(FOG_FRAME_FLOATS)): Float32Array {
  out.fill(0);
  if (!frame) return out;
  const { camera, eye } = frame.camera;
  out.set([...eye, 1], 0);
  out.set([...camera.right, camera.focalX], 4);
  out.set([...camera.up, camera.focalY], 8);
  out.set([...camera.back, frame.fog.distance], 12);
  return out;
}

/** The WGSL a scene shader samples the fog with: the volume as `fogVolume` (and `envSamp`), the frame's `fogEye`, `fogRight`, `fogUp`, `fogBack`. */
export const FOG_SAMPLE_WGSL = /* wgsl */ `
fn fogAt(P: vec3<f32>) -> vec4<f32> {
  let ray = P - frame.fogEye.xyz;
  let ahead = -dot(ray, frame.fogBack.xyz);
  if (ahead <= 1e-4) { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
  let reach = frame.fogBack.w;
  let t = length(ray);
  let at = vec3<f32>((dot(ray, frame.fogRight.xyz) / ahead * frame.fogRight.w + 1.0) * 0.5, (1.0 - dot(ray, frame.fogUp.xyz) / ahead * frame.fogUp.w) * 0.5, sqrt(min(1.0, t / reach)));
  let s = textureSampleLevel(fogVolume, envSamp, at, 0.0);
  // Nearer than the first slice's centre, the fog fades toward none.
  let fade = clamp(t / (reach * ${((0.5 / FOG_SLICES) ** 2).toPrecision(6)}), 0.0, 1.0);
  return vec4<f32>(s.rgb * fade, 1.0 - (1.0 - s.a) * fade);
}
`;

/** Halton's low-discrepancy sequence in base b, its i-th point (i ≥ 1). */
function halton(i: number, b: number): number {
  let f = 1;
  let r = 0;
  for (let k = i; k > 0; k = Math.floor(k / b)) {
    f /= b;
    r += f * (k % b);
  }
  return r;
}

/** The jitter of a temporal frame's n-th sample: Halton (2, 3, 5), centred on the froxel. */
export function fogJitter(n: number): [number, number, number] {
  const i = (n % 64) + 1;
  return [halton(i, 2) - 0.5, halton(i, 3) - 0.5, halton(i, 5) - 0.5];
}

/** Texture usages, and a buffer's (whose bits differ). */
const USAGE = { copySrc: 0x01, textureBinding: 0x04, storage: 0x08 } as const;
const BUFFER = { uniform: 0x40, copyDst: 0x08 } as const;

/**
 * The fog's volumes on a device: two of injected light (this frame's and the
 * history it blends) and the integrated one the scene samples, remade when the
 * grid changes.
 */
export class GpuVolumetricFog {
  /** What the scene samples; a 1³ stand-in until the first frame. */
  volume: any;
  private light: [any, any] | null = null;
  private index = 0;
  private grid = "";
  private readonly uniforms: any;
  private readonly data = new Float32Array(FOG_UNIFORM_FLOATS);
  private readonly sampler: any;
  private pipelines: { inject: any; integrate: any } | null = null;
  /** Last frame's camera, while its history is valid. */
  private previous: FogCamera | null = null;
  private frames = 0;

  constructor(private readonly device: any) {
    this.volume = this.texture([1, 1, 1]);
    this.uniforms = device.createBuffer({ size: FOG_UNIFORM_FLOATS * 4, usage: BUFFER.uniform | BUFFER.copyDst });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
  }

  /**
   * Bring the volumes up to the grid, and write the frame's uniforms: with
   * `temporal`, a jittered sample blended into the last frame's history;
   * without, the froxels' centres alone. Returns the frame as packed, and
   * whether the volume was remade (the scene's groups must point at it).
   */
  prepare(frame: Omit<FogFrame, "previous" | "jitter">, temporal: boolean): { frame: FogFrame; remade: boolean } {
    const key = frame.grid.join("x");
    let remade = false;
    if (key !== this.grid) {
      for (const t of [this.volume, ...(this.light ?? [])]) t.destroy?.();
      this.light = [this.texture(frame.grid), this.texture(frame.grid)];
      this.volume = this.texture(frame.grid);
      this.grid = key;
      this.previous = null;
      remade = true;
    }
    const full: FogFrame = { ...frame, previous: temporal ? this.previous : null, jitter: temporal ? fogJitter(this.frames) : [0, 0, 0] };
    this.device.queue.writeBuffer(this.uniforms, 0, packFogUniforms(full, this.data));
    this.previous = temporal ? frame.camera : null;
    this.frames += 1;
    return { frame: full, remade };
  }

  /** Encode the inject and integrate passes (after {@link prepare}), shadowed by `cascades` (the map) and its comparison sampler. */
  encode(encoder: any, cascades: any, cascadeSampler: any, timing: { readonly timestampWrites?: object } = {}): void {
    const device = this.device;
    const [nx, ny, nz] = this.grid.split("x").map(Number) as [number, number, number];
    const pipeline = (code: string) => device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
    this.pipelines ??= { inject: pipeline(FOG_INJECT_WGSL), integrate: pipeline(FOG_INTEGRATE_WGSL) };
    const history = this.light![this.index]!;
    const current = this.light![1 - this.index]!;
    const pass = encoder.beginComputePass(timing);
    pass.setPipeline(this.pipelines.inject);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.pipelines.inject.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniforms } },
          { binding: 1, resource: history.createView() },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: cascades.createView({ dimension: "2d-array" }) },
          { binding: 4, resource: cascadeSampler },
          { binding: 5, resource: current.createView() },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(nx / 4), Math.ceil(ny / 4), Math.ceil(nz / 4));
    pass.setPipeline(this.pipelines.integrate);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: this.pipelines.integrate.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniforms } },
          { binding: 1, resource: current.createView() },
          { binding: 2, resource: this.volume.createView() },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil(nx / 8), Math.ceil(ny / 8));
    pass.end();
    this.index = 1 - this.index;
  }

  /** Forget the history (a cut, or a frame without fog). */
  reset(): void {
    this.previous = null;
  }

  dispose(): void {
    for (const t of [this.volume, ...(this.light ?? [])]) t.destroy?.();
    this.uniforms.destroy?.();
  }

  private texture(size: readonly number[]): any {
    return this.device.createTexture({
      size: { width: size[0], height: size[1], depthOrArrayLayers: size[2] },
      dimension: "3d",
      format: FOG_FORMAT,
      usage: USAGE.textureBinding | USAGE.storage | USAGE.copySrc,
    });
  }
}
