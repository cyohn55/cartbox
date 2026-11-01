/**
 * Image-based lighting on the GPU (AAA_FIDELITY_ROADMAP.md F3a): the AAA tier's
 * environment as a cubemap whose mips are the GGX-prefiltered reflection at
 * rising roughness, and its diffuse light as L2 spherical harmonics. Together
 * with the split-sum DFG (brdf.ts) they are Karis's split-sum IBL.
 *
 * They replace what the Modern tier keeps for its parity with the software
 * rasteriser: the 192×96 panorama read nearest, a reflection "blurred" by
 * lerping toward the environment's average, and a diffuse light that was the
 * radiance straight along the normal rather than the irradiance over its
 * hemisphere.
 *
 * - **The source** is the environment in linear light ({@link environmentPanorama}):
 *   an imported HDR sky's own radiance, else its panorama, or its
 *   sky/horizon/ground gradient, decoded and scaled by its intensity as the
 *   shader's `envColorDir` does.
 * - **The cube** is drawn from it in compute, each mip level the GGX lobe of
 *   its roughness (level / (levels − 1)) importance-sampled around the
 *   direction, with mip-filtered samples (Křivánek and Colbert) from the
 *   source's own mips, so a few hundred samples don't alias.
 * - **The irradiance** is projected on the CPU into nine coefficients
 *   (Ramamoorthi and Hanrahan), already convolved with the clamped cosine and
 *   divided by π, so a constant environment of radiance L lights white at L.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { EnvironmentLight } from "@cartbox/editor";

import { MipmapGenerator, mipLevelCount } from "./mipmaps.js";

/** The cube's face size, and its levels: 128 down to 4, roughness 0 to 1. */
export const IBL_FACE = 128;
export const IBL_LEVELS = 6;
/** GGX samples per texel of a prefiltered level. */
const IBL_SAMPLES = 128;
/** The gradient's panorama, when the environment has no map of its own. */
const GRADIENT_WIDTH = 128;
const GRADIENT_HEIGHT = 64;

/** An environment in linear light: RGBA floats, equirectangular (u = longitude, v = 0 at the zenith). */
export interface LinearPanorama {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** What an environment's IBL depends on: its gradient and intensity, or the identity of its map. */
export function environmentKey(env: EnvironmentLight): unknown[] {
  if (env.hdr) return [env.hdr, env.intensity];
  return env.map ? [env.map, env.intensity] : [...env.sky, ...env.horizon, ...env.ground, env.intensity];
}

/**
 * The environment as the linear shader sees it: its HDR light when it has one
 * (an imported `.hdr` sky, F3a), else its panorama, or its gradient by a
 * direction's height (envGradient), each decoded from authored colour; all
 * scaled by the intensity.
 */
export function environmentPanorama(env: EnvironmentLight): LinearPanorama {
  const intensity = env.intensity;
  if (env.hdr) {
    const { width, height, data } = env.hdr;
    const out = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) out.set([data[i * 3]! * intensity, data[i * 3 + 1]! * intensity, data[i * 3 + 2]! * intensity, 1], i * 4);
    return { width, height, data: out };
  }
  if (env.map) {
    const { width, height, data } = env.map;
    const out = new Float32Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      for (let k = 0; k < 3; k += 1) out[i * 4 + k] = srgbToLinear(data[i * 4 + k]! / 255) * intensity;
      out[i * 4 + 3] = 1;
    }
    return { width, height, data: out };
  }
  const out = new Float32Array(GRADIENT_WIDTH * GRADIENT_HEIGHT * 4);
  for (let y = 0; y < GRADIENT_HEIGHT; y += 1) {
    const t = Math.cos((Math.PI * (y + 0.5)) / GRADIENT_HEIGHT);
    const to = t >= 0 ? env.sky : env.ground;
    const k = Math.abs(t);
    const c = [0, 1, 2].map((i) => srgbToLinear(env.horizon[i]! + (to[i]! - env.horizon[i]!) * k) * intensity);
    for (let x = 0; x < GRADIENT_WIDTH; x += 1) out.set([c[0]!, c[1]!, c[2]!, 1], (y * GRADIENT_WIDTH + x) * 4);
  }
  return { width: GRADIENT_WIDTH, height: GRADIENT_HEIGHT, data: out };
}

/** A panorama texel's direction: u around from −x (atan2(z, x) = −π), v down from the zenith. */
function texelDirection(pano: LinearPanorama, x: number, y: number): [number, number, number] {
  const phi = (2 * Math.PI * (x + 0.5)) / pano.width - Math.PI;
  const theta = (Math.PI * (y + 0.5)) / pano.height;
  return [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
}

/** The nine real SH basis functions at a unit direction. */
function shBasis(x: number, y: number, z: number): number[] {
  return [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z, 0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
}

/** The clamped cosine's SH bands (Â₀ = π, Â₁ = 2π/3, Â₂ = π/4), over π. */
const COSINE_BANDS = [1, 2 / 3, 2 / 3, 2 / 3, 1 / 4, 1 / 4, 1 / 4, 1 / 4, 1 / 4];

/**
 * The panorama's irradiance as L2 spherical harmonics: nine RGB coefficients
 * (as vec4s, 36 floats), convolved with the clamped cosine and over π, so
 * {@link shIrradiance} gives the radiance a white Lambertian surface reflects.
 */
export function environmentSh(pano: LinearPanorama): Float32Array {
  const sums = new Float64Array(27);
  for (let y = 0; y < pano.height; y += 1) {
    // Each texel's solid angle: sin θ dθ dφ.
    const theta = (Math.PI * (y + 0.5)) / pano.height;
    const weight = Math.sin(theta) * (Math.PI / pano.height) * ((2 * Math.PI) / pano.width);
    for (let x = 0; x < pano.width; x += 1) {
      const [dx, dy, dz] = texelDirection(pano, x, y);
      const basis = shBasis(dx, dy, dz);
      const i = (y * pano.width + x) * 4;
      for (let k = 0; k < 9; k += 1) {
        for (let c = 0; c < 3; c += 1) sums[k * 3 + c] = sums[k * 3 + c]! + pano.data[i + c]! * basis[k]! * weight;
      }
    }
  }
  const out = new Float32Array(36);
  for (let k = 0; k < 9; k += 1) for (let c = 0; c < 3; c += 1) out[k * 4 + c] = sums[k * 3 + c]! * COSINE_BANDS[k]!;
  return out;
}

/** The SH irradiance (over π) at a unit normal, as the shader evaluates it. */
export function shIrradiance(sh: Float32Array, n: readonly [number, number, number]): [number, number, number] {
  const basis = shBasis(n[0], n[1], n[2]);
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 9; k += 1) for (let c = 0; c < 3; c += 1) out[c] = out[c]! + sh[k * 4 + c]! * basis[k]!;
  return [Math.max(0, out[0]), Math.max(0, out[1]), Math.max(0, out[2])];
}

/** The WGSL that evaluates {@link shIrradiance} from nine vec4s. */
export const SH_IRRADIANCE_WGSL = /* wgsl */ `
// The environment's diffuse light (F3a, ibl.ts): L2 SH irradiance over π at a unit normal.
fn shIrradiance(n: vec3<f32>) -> vec3<f32> {
  let s = frame.envSh;
  let e = s[0].xyz * 0.282095
    + (s[1].xyz * n.y + s[2].xyz * n.z + s[3].xyz * n.x) * 0.488603
    + (s[4].xyz * (n.x * n.y) + s[5].xyz * (n.y * n.z) + s[7].xyz * (n.x * n.z)) * 1.092548
    + s[6].xyz * (0.315392 * (3.0 * n.z * n.z - 1.0))
    + s[8].xyz * (0.546274 * (n.x * n.x - n.y * n.y));
  return max(e, vec3<f32>(0.0));
}
`;

/**
 * A cube face's texel direction (WebGPU's, as D3D's): face +x, −x, +y, −y,
 * +z, −z, with s across and t down the face.
 */
export function cubeDirection(face: number, s: number, t: number): [number, number, number] {
  const d: [number, number, number][] = [
    [1, -t, -s],
    [-1, -t, s],
    [s, 1, t],
    [s, -1, -t],
    [s, -t, 1],
    [-s, -t, -1],
  ];
  const [x, y, z] = d[face]!;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

const PREFILTER_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
// x = perceptual roughness, y = this level's face size, z = the source's level-0 texel solid angle, w = the coarsest source level to read.
@group(0) @binding(3) var<uniform> params: vec4<f32>;

const PI = 3.14159265;

fn faceDirection(face: u32, s: f32, t: f32) -> vec3<f32> {
  switch (face) {
    case 0u: { return vec3<f32>(1.0, -t, -s); }
    case 1u: { return vec3<f32>(-1.0, -t, s); }
    case 2u: { return vec3<f32>(s, 1.0, t); }
    case 3u: { return vec3<f32>(s, -1.0, -t); }
    case 4u: { return vec3<f32>(s, -t, 1.0); }
    default: { return vec3<f32>(-s, -t, -1.0); }
  }
}
// The panorama along a direction (envColorDir's mapping), at a mip level.
fn panorama(d: vec3<f32>, lod: f32) -> vec3<f32> {
  let u = atan2(d.z, d.x) / (2.0 * PI) + 0.5;
  let v = acos(clamp(d.y, -1.0, 1.0)) / PI;
  return textureSampleLevel(src, srcSamp, vec2<f32>(u, v), lod).rgb;
}
fn hammersley(i: u32, n: u32) -> vec2<f32> {
  return vec2<f32>(f32(i) / f32(n), f32(reverseBits(i)) * 2.3283064365386963e-10);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = u32(params.y);
  if (id.x >= size || id.y >= size) { return; }
  let s = (f32(id.x) + 0.5) / params.y * 2.0 - 1.0;
  let t = (f32(id.y) + 0.5) / params.y * 2.0 - 1.0;
  let N = normalize(faceDirection(id.z, s, t));
  let rough = params.x;
  var colour = vec3<f32>(0.0);
  if (rough <= 0.0) {
    colour = panorama(N, 0.0);
  } else {
    // GGX importance sampling about N, with V = N (the split-sum's isotropic lobe).
    let alpha = max(rough * rough, 1e-4);
    let a2 = alpha * alpha;
    let up = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(N.z) < 0.999);
    let tx = normalize(cross(up, N));
    let ty = cross(N, tx);
    var weight = 0.0;
    for (var i = 0u; i < ${IBL_SAMPLES}u; i = i + 1u) {
      let xi = hammersley(i, ${IBL_SAMPLES}u);
      let phi = 2.0 * PI * xi.x;
      let cosT = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
      let sinT = sqrt(1.0 - cosT * cosT);
      let H = normalize(tx * (sinT * cos(phi)) + ty * (sinT * sin(phi)) + N * cosT);
      let L = 2.0 * dot(N, H) * H - N;
      let ndl = dot(N, L);
      if (ndl > 0.0) {
        // The sample's solid angle against a source texel's: the mip to read so samples tile the lobe.
        let d = cosT * cosT * (a2 - 1.0) + 1.0;
        let pdf = a2 / (PI * d * d) / 4.0;
        let omega = 1.0 / (f32(${IBL_SAMPLES}u) * pdf + 1e-6);
        let lod = clamp(0.5 * log2(omega / params.z) + 1.0, 0.0, params.w);
        colour = colour + panorama(L, lod) * ndl;
        weight = weight + ndl;
      }
    }
    colour = colour / max(weight, 1e-6);
  }
  textureStore(dst, vec2<u32>(id.xy), id.z, vec4<f32>(colour, 1.0));
}
`;

/** A float as an IEEE half's bits. */
export function toHalf(value: number): number {
  const f = new Float32Array([value]);
  const bits = new Uint32Array(f.buffer)[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7bff; // clamp to the largest finite half
  return sign | (exponent << 10) | (mantissa >>> 13);
}

/** Builds an environment's prefiltered cube on a device. */
export class IblBuilder {
  private pipeline: any = null;
  private readonly mips: MipmapGenerator;

  constructor(private readonly device: any) {
    this.mips = new MipmapGenerator(device);
  }

  /** The prefiltered cube of a panorama: rgba16float, {@link IBL_FACE}², {@link IBL_LEVELS} levels. */
  build(pano: LinearPanorama): any {
    const device = this.device;
    const levels = mipLevelCount(pano.width, pano.height);
    const source = device.createTexture({
      size: { width: pano.width, height: pano.height },
      format: "rgba16float",
      mipLevelCount: levels,
      usage: 0x04 | 0x02 | 0x10, // TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT (its mips)
    });
    const halves = new Uint16Array(pano.data.length);
    for (let i = 0; i < halves.length; i += 1) halves[i] = toHalf(pano.data[i]!);
    device.queue.writeTexture({ texture: source }, halves, { bytesPerRow: pano.width * 8, rowsPerImage: pano.height }, { width: pano.width, height: pano.height });
    this.mips.generate(source, levels, "rgba16float");

    const cube = device.createTexture({
      size: { width: IBL_FACE, height: IBL_FACE, depthOrArrayLayers: 6 },
      format: "rgba16float",
      mipLevelCount: IBL_LEVELS,
      usage: 0x04 | 0x08 | 0x01, // TEXTURE_BINDING | STORAGE_BINDING | COPY_SRC (read back by its tests)
    });
    this.pipeline ??= device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: PREFILTER_WGSL }), entryPoint: "main" } });
    const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "clamp-to-edge" });
    const texelSolidAngle = (4 * Math.PI) / (pano.width * pano.height);
    const encoder = device.createCommandEncoder();
    const uniforms: any[] = [];
    for (let level = 0; level < IBL_LEVELS; level += 1) {
      const size = Math.max(1, IBL_FACE >> level);
      const params = device.createBuffer({ size: 16, usage: 0x40 | 0x08 }); // UNIFORM | COPY_DST
      // The coarsest source level read keeps eight rows: an equirect's mips weight a polar texel as an equatorial one,
      // so the last few would pull the poles' light into the lobe out of proportion.
      device.queue.writeBuffer(params, 0, new Float32Array([level / (IBL_LEVELS - 1), size, texelSolidAngle, Math.max(0, Math.min(levels - 1, Math.log2(pano.height / 8)))]));
      uniforms.push(params);
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: source.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: cube.createView({ dimension: "2d-array", baseMipLevel: level, mipLevelCount: 1 }) },
            { binding: 3, resource: { buffer: params } },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 6);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
    // Released once the queue has run the passes (destroy waits for submitted work).
    source.destroy();
    for (const u of uniforms) u.destroy();
    return cube;
  }
}
