/**
 * HDR reflection probes on the AAA tier (AAA_FIDELITY_ROADMAP.md F3b): each
 * probe captured on the GPU as a cube of the scene in linear light, and
 * prefiltered into the GGX lobes of rising roughness, as the sky's own cube is
 * (F3a, ibl.ts).
 *
 * - **Capture.** A second linear-light renderer, {@link PROBE_FACE}² and
 *   without probes of its own (its reflections are of the sky), draws the six
 *   faces from the probe's capture point (`PANORAMA_FACES`, the CPU bake's).
 *   Its output, linear and unclamped, is copied into a six-layer array and
 *   given its mips.
 * - **Prefilter.** A compute pass writes each level of the probe's cube, in
 *   WebGPU's cube layout, from the faces read by direction (with the sky
 *   composited where nothing drew). It importance-samples the GGX lobe of the
 *   level's roughness with mip-filtered samples, as the sky's cube is.
 * - **One cube array** holds every probe, {@link MAX_REFLECTION_PROBES} × 6
 *   layers, and the scene shader samples it trilinearly by roughness.
 * - **Re-capture.** Re-capturing happens when the caller's key changes: the
 *   probes, the still scene, or the light (the sun moving with the time of
 *   day). It goes a probe a frame, highest priority first, and the probes
 *   already captured stay bound meanwhile, so nothing pops back to the sky.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { MAX_REFLECTION_PROBES, PANORAMA_FACES, probeOrder, projectionMatrix, viewMatrix, type MeshSceneInstance, type ReflectionProbe } from "@cartbox/editor";

import { IBL_LEVELS } from "./ibl.js";
import { MipmapGenerator, mipLevelCount } from "./mipmaps.js";

/** A probe face's size: the sky cube's, so a roughness reads the same level in both. */
export const PROBE_FACE = 128;
/** GGX samples per texel of a prefiltered level. */
const PROBE_SAMPLES = 96;
/** How near a capture draws: a probe set against a wall still sees past it. */
const PROBE_NEAR = 0.05;

/** What a frame asks to be captured: the probes, the still scene they see, and what identifies both and the light. */
export interface ReflectionCapture {
  readonly probes: readonly ReflectionProbe[];
  readonly instances: readonly MeshSceneInstance[];
  readonly key: string;
}


/**
 * The probes' boxes as the shader reads them (PROBE_FLOATS each: min, max,
 * capture point, and a fourth whose w is 1 once captured). A sphere probe's
 * box is its sphere's bounds, and pos.w its radius (0 for a box).
 */
export function packCapturedProbes(current: readonly { readonly probe: ReflectionProbe; readonly ready: boolean }[]): Float32Array {
  const out = new Float32Array(Math.max(1, current.length) * 16);
  current.forEach(({ probe, ready }, i) => {
    const o = i * 16;
    out.set(probe.min, o);
    out.set(probe.max, o + 4);
    out.set(probe.position, o + 8);
    out[o + 11] = probe.shape === "sphere" ? (probe.radius ?? 0) : 0;
    out[o + 15] = ready ? 1 : 0;
  });
  return out;
}

/** A face's camera at a capture point: `PANORAMA_FACES`' forward and up, a 90° square view. */
export function probeFaceCamera(position: readonly [number, number, number], face: number, far: number): { view: Float64Array | number[]; projection: Float64Array | number[] } {
  const { forward, up } = PANORAMA_FACES[face]!;
  return {
    view: viewMatrix(position, [position[0] + forward[0], position[1] + forward[1], position[2] + forward[2]], up) as any,
    projection: projectionMatrix(Math.PI / 2, 1, PROBE_NEAR, far) as any,
  };
}

/** The prefilter's WGSL: the faces (as the capture cameras saw them) to one level of a probe's cube. */
const PREFILTER_WGSL = /* wgsl */ `
@group(0) @binding(0) var faces: texture_2d_array<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
// x = perceptual roughness, y = this level's face size, z = a source texel's solid angle, w = the source's last level.
@group(0) @binding(3) var<uniform> params: vec4<f32>;
// Each capture face's forward, right and up (the cameras' frames), xyz in three vec4s apiece.
@group(0) @binding(4) var<uniform> frames: array<vec4<f32>, 18>;
@group(0) @binding(5) var sky: texture_cube<f32>;

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
// What the capture saw along a direction: the face it falls in, read at a level; the sky where nothing drew.
fn captured(d: vec3<f32>, lod: f32) -> vec3<f32> {
  var best = 0u;
  var most = -2.0;
  for (var f = 0u; f < 6u; f = f + 1u) {
    let along = dot(d, frames[f * 3u].xyz);
    if (along > most) { most = along; best = f; }
  }
  let fw = frames[best * 3u].xyz;
  let rt = frames[best * 3u + 1u].xyz;
  let up = frames[best * 3u + 2u].xyz;
  let q = d / dot(d, fw);
  let uv = vec2<f32>(dot(q, rt) * 0.5 + 0.5, 0.5 - dot(q, up) * 0.5);
  let c = textureSampleLevel(faces, samp, uv, best, lod);
  return c.rgb + (1.0 - c.a) * textureSampleLevel(sky, samp, d, 0.0).rgb;
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
    colour = captured(N, 0.0);
  } else {
    let alpha = max(rough * rough, 1e-4);
    let a2 = alpha * alpha;
    let upv = select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), abs(N.z) < 0.999);
    let tx = normalize(cross(upv, N));
    let ty = cross(N, tx);
    var weight = 0.0;
    for (var i = 0u; i < ${PROBE_SAMPLES}u; i = i + 1u) {
      let xi = hammersley(i, ${PROBE_SAMPLES}u);
      let phi = 2.0 * PI * xi.x;
      let cosT = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y));
      let sinT = sqrt(1.0 - cosT * cosT);
      let H = normalize(tx * (sinT * cos(phi)) + ty * (sinT * sin(phi)) + N * cosT);
      let L = 2.0 * dot(N, H) * H - N;
      let ndl = dot(N, L);
      if (ndl > 0.0) {
        let d = cosT * cosT * (a2 - 1.0) + 1.0;
        let pdf = a2 / (PI * d * d) / 4.0;
        let omega = 1.0 / (f32(${PROBE_SAMPLES}u) * pdf + 1e-6);
        let lod = clamp(0.5 * log2(omega / params.z) + 1.0, 0.0, params.w);
        colour = colour + captured(L, lod) * ndl;
        weight = weight + ndl;
      }
    }
    colour = colour / max(weight, 1e-6);
  }
  textureStore(dst, vec2<u32>(id.xy), id.z, vec4<f32>(colour, 1.0));
}
`;

/** The capture renderer's interface: what the probes need of a linear-light WebgpuSceneRenderer. */
export interface CaptureRenderer {
  renderToTexture(instances: readonly MeshSceneInstance[], draw: any): any | null;
  dispose(): void;
}

/** Holds the probes' cube array and captures into it. */
export class ProbeCapture {
  /** The probes' prefiltered cubes: rgba16float, {@link PROBE_FACE}², 6 × {@link MAX_REFLECTION_PROBES} layers. */
  readonly cubes: any;
  /** Per slot, whether it holds its probe's capture as the current probes stand. */
  private readonly ready: boolean[] = new Array(MAX_REFLECTION_PROBES).fill(false);
  private probes: ReflectionProbe[] = [];
  private key: string | null = null;
  /** Slots still to capture for the current key, in order. */
  private queue: number[] = [];
  private renderer: CaptureRenderer | null = null;
  private pending: Promise<void> | null = null;
  private faces: any = null;
  private pipeline: any = null;
  private sampler: any = null;
  private framesBuffer: any = null;
  private readonly mips: MipmapGenerator;

  constructor(
    private readonly device: any,
    /** Makes the capture renderer ({@link PROBE_FACE}², linear light), once. */
    private readonly create: () => Promise<CaptureRenderer | null>,
  ) {
    this.mips = new MipmapGenerator(device);
    this.cubes = device.createTexture({
      size: { width: PROBE_FACE, height: PROBE_FACE, depthOrArrayLayers: 6 * MAX_REFLECTION_PROBES },
      format: "rgba16float",
      mipLevelCount: IBL_LEVELS,
      usage: 0x04 | 0x08 | 0x01, // TEXTURE_BINDING | STORAGE_BINDING | COPY_SRC (read back by its tests)
    });
  }

  /** The probes as the shader takes them, in their order, each with whether its cube is captured. */
  get current(): readonly { readonly probe: ReflectionProbe; readonly ready: boolean }[] {
    return this.probes.map((probe, i) => ({ probe, ready: this.ready[i]! }));
  }

  /** Whether every probe is captured as the current key has it. */
  get settled(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Bring the probes up to `capture` (null: none), capturing at most one probe
   * this call. `draw` is the frame's, whose light and sky the capture takes;
   * `sky` the sky's prefiltered cube.
   */
  update(capture: ReflectionCapture | null, draw: any, sky: any): void {
    if (!capture || capture.probes.length === 0) {
      this.probes = [];
      this.key = null;
      this.queue = [];
      return;
    }
    if (capture.key !== this.key) {
      const ordered = probeOrder(capture.probes).slice(0, MAX_REFLECTION_PROBES);
      // A probe that moved, or is new, isn't ready until captured again; the rest keep what they hold meanwhile.
      const same = (a: ReflectionProbe | undefined, b: ReflectionProbe) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
      ordered.forEach((p, i) => {
        if (!same(this.probes[i], p)) this.ready[i] = false;
      });
      for (let i = ordered.length; i < MAX_REFLECTION_PROBES; i += 1) this.ready[i] = false;
      this.probes = ordered;
      this.key = capture.key;
      this.queue = ordered.map((_, i) => i);
    }
    if (this.queue.length === 0) return;
    if (!this.renderer) {
      this.pending ??= this.create().then((r) => {
        this.renderer = r;
      });
      return;
    }
    const slot = this.queue.shift()!;
    this.capture(slot, capture.instances, draw, sky);
    this.ready[slot] = true;
  }

  /** Capture probe `slot`: its six faces, their mips, then each prefiltered level into its cube. */
  private capture(slot: number, instances: readonly MeshSceneInstance[], draw: any, sky: any): void {
    const device = this.device;
    const probe = this.probes[slot]!;
    const levels = mipLevelCount(PROBE_FACE, PROBE_FACE);
    this.faces ??= device.createTexture({
      size: { width: PROBE_FACE, height: PROBE_FACE, depthOrArrayLayers: 6 },
      format: "rgba16float",
      mipLevelCount: levels,
      usage: 0x04 | 0x02 | 0x10, // TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT (its mips)
    });
    const span = Math.max(1, ...probe.max.map((v, a) => Math.abs(v - probe.position[a]!)), ...probe.min.map((v, a) => Math.abs(v - probe.position[a]!)));
    const far = Math.max(200, span * 8);
    for (let face = 0; face < 6; face += 1) {
      const camera = probeFaceCamera(probe.position, face, far);
      const texture = this.renderer!.renderToTexture(instances, {
        ...draw,
        width: PROBE_FACE,
        height: PROBE_FACE,
        view: camera.view,
        projection: camera.projection,
        antialias: false,
        temporal: false,
        reflections: false,
        prepass: false,
        tonemap: null,
        reflectionCapture: null,
        // The live GI's volume is the main renderer's; a capture takes the probes' light as they were given.
        dynamicGi: null,
        environment: draw.environment ? { ...draw.environment, probes: null } : null,
        ...(draw.sunShadow ? { sunShadow: { ...draw.sunShadow, casters: instances } } : {}),
        ...(draw.localShadowCasters ? { localShadowCasters: instances, localShadowKey: `probe:${this.key}`, localShadowMoved: [] } : {}),
      });
      if (!texture) return;
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToTexture({ texture }, { texture: this.faces, origin: { x: 0, y: 0, z: face } }, { width: PROBE_FACE, height: PROBE_FACE, depthOrArrayLayers: 1 });
      device.queue.submit([encoder.finish()]);
    }
    this.mips.generate(this.faces, levels, "rgba16float", 6);
    this.prefilter(slot, levels, sky);
  }

  private prefilter(slot: number, levels: number, sky: any): void {
    const device = this.device;
    this.pipeline ??= device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: PREFILTER_WGSL }), entryPoint: "main" } });
    this.sampler ??= device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    if (!this.framesBuffer) {
      // Each face camera's forward, right (forward × up) and up.
      const frames = new Float32Array(18 * 4);
      PANORAMA_FACES.forEach(({ forward, up }, f) => {
        const right = [forward[1] * up[2] - forward[2] * up[1], forward[2] * up[0] - forward[0] * up[2], forward[0] * up[1] - forward[1] * up[0]];
        frames.set(forward, f * 12);
        frames.set(right, f * 12 + 4);
        frames.set(up, f * 12 + 8);
      });
      this.framesBuffer = device.createBuffer({ size: frames.byteLength, usage: 0x40 | 0x08 }); // UNIFORM | COPY_DST
      device.queue.writeBuffer(this.framesBuffer, 0, frames);
    }
    const texelSolidAngle = (4 * Math.PI) / (6 * PROBE_FACE * PROBE_FACE);
    const encoder = device.createCommandEncoder();
    const uniforms: any[] = [];
    for (let level = 0; level < IBL_LEVELS; level += 1) {
      const size = Math.max(1, PROBE_FACE >> level);
      const params = device.createBuffer({ size: 16, usage: 0x40 | 0x08 });
      device.queue.writeBuffer(params, 0, new Float32Array([level / (IBL_LEVELS - 1), size, texelSolidAngle, levels - 1]));
      uniforms.push(params);
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.faces.createView({ dimension: "2d-array" }) },
            { binding: 1, resource: this.sampler },
            { binding: 2, resource: this.cubes.createView({ dimension: "2d-array", baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: slot * 6, arrayLayerCount: 6 }) },
            { binding: 3, resource: { buffer: params } },
            { binding: 4, resource: { buffer: this.framesBuffer } },
            { binding: 5, resource: sky.createView({ dimension: "cube" }) },
          ],
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8), 6);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
    for (const u of uniforms) u.destroy();
  }

  dispose(): void {
    this.cubes.destroy();
    this.faces?.destroy();
    this.framesBuffer?.destroy();
    this.renderer?.dispose();
  }
}
