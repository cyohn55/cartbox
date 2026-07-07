"use client";

/**
 * WebGPU lit renderer. Uploads the albedo, normal, and material textures and
 * runs the same lighting the CPU `renderLitRgba` path runs, as a fragment
 * shader: Lambert diffuse, Blinn-Phong specular (from the material's specular +
 * roughness), a height self-shadow, a rim term, an emissive lift (from the
 * material's alpha), and — with a fog uniform — volumetric light shafts marched
 * through the height field. `create` returns null on any
 * failure or when WebGPU is unavailable, so the caller falls back to the CPU
 * renderer — this is never a blank screen.
 *
 * WebGPU isn't in the TS DOM lib here and we don't want the @webgpu/types
 * dependency, so the GPU handles are loosely typed. The lighting maths is what
 * matters, and it's identical to the tested CPU path.
 */

import type { Light, FogOptions } from "@cartbox/editor";

const SHADER = /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let xy = corners[vi];
  var out: VSOut;
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return out;
}

struct Uniforms { light: vec4<f32>, dims: vec4<f32>, fog: vec4<f32> }; // fog = rgb, density
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var albedoTex: texture_2d<f32>;
@group(0) @binding(2) var normalTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: Uniforms;
@group(0) @binding(4) var matTex: texture_2d<f32>; // r=height, g=specular, b=roughness, a=emissive
@group(0) @binding(5) var sampLin: sampler; // linear, for smooth height sampling

const HMAX = 2.5;
const VIEW = vec3<f32>(0.0, 0.0, 1.0);
const SHADOW_MAX_RANGE = 16.0;
const SHADOW_STRENGTH = 0.6;
const SHADOW_SOFTNESS = 2.5;

fn heightAt(uv: vec2<f32>) -> f32 {
  return textureSampleLevel(matTex, sampLin, uv, 0.0).r * HMAX;
}

// Soft horizon shadow: march toward the light tracking how far terrain rises
// above the line of sight, with a penumbra — no hard staircase.
fn shadowFactor(px: vec2<f32>, h0: f32, lightXY: vec2<f32>, lz: f32, dims: vec2<f32>) -> f32 {
  let d = lightXY - px;
  let dist = length(d);
  if (dist < 0.001) { return 1.0; }
  let u = d / dist;
  let lightSlope = (lz - h0) / dist;
  let range = min(dist, SHADOW_MAX_RANGE);
  var maxExcess = 0.0;
  for (var s = 1; s <= 16; s = s + 1) {
    let dd = (f32(s) / 16.0) * range;
    let slope = (heightAt((px + u * dd) / dims) - h0) / dd;
    maxExcess = max(maxExcess, slope - lightSlope);
  }
  return 1.0 - min(1.0, maxExcess * SHADOW_SOFTNESS) * SHADOW_STRENGTH;
}

// Volumetric light shaft: march the same ray the shadow uses and return the
// fraction of it that stays in open air before the terrain first rises above the
// light's line of sight — 1 for an unobstructed path (a bright god ray), low
// where the path is cut short behind a silhouette (a dark shaft).
fn lightShaftVisibility(px: vec2<f32>, h0: f32, lightXY: vec2<f32>, lz: f32, dims: vec2<f32>) -> f32 {
  let d = lightXY - px;
  let dist = length(d);
  if (dist < 0.001) { return 1.0; }
  let u = d / dist;
  let lightSlope = (lz - h0) / dist;
  let range = min(dist, SHADOW_MAX_RANGE);
  var maxSlope = -1.0e9;
  var litSteps = 0.0;
  for (var s = 1; s <= 16; s = s + 1) {
    let dd = (f32(s) / 16.0) * range;
    let slope = (heightAt((px + u * dd) / dims) - h0) / dd;
    maxSlope = max(maxSlope, slope);
    if (maxSlope <= lightSlope) { litSteps = litSteps + 1.0; }
  }
  return litSteps / 16.0;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let albedo = textureSample(albedoTex, samp, in.uv);
  let n = normalize(textureSample(normalTex, samp, in.uv).xyz * 2.0 - 1.0);
  let m = textureSampleLevel(matTex, samp, in.uv, 0.0);
  let px = in.uv * u.dims.xy;
  let toLight = normalize(vec3<f32>(u.light.x - px.x, u.light.y - px.y, u.light.z));
  let h0 = m.r * HMAX;
  let specStr = m.g;
  let rough = m.b;
  let emissive = m.a;
  let shadow = shadowFactor(px, h0, u.light.xy, u.light.z, u.dims.xy);
  let diffuse = max(0.0, dot(n, toLight)) * shadow;
  let intensity = u.light.w + (1.0 - u.light.w) * diffuse;
  let shininess = mix(6.0, 120.0, 1.0 - rough);
  let halfVec = normalize(toLight + VIEW);
  let spec = pow(max(0.0, dot(n, halfVec)), shininess) * specStr * shadow;
  let rim = pow(1.0 - max(0.0, dot(n, VIEW)), 3.0) * 0.15;
  let lit = albedo.rgb * (intensity + rim) + vec3<f32>(spec);
  let surface = max(lit, albedo.rgb * emissive);
  let visibility = lightShaftVisibility(px, h0, u.light.xy, u.light.z, u.dims.xy);
  let shaft = u.fog.rgb * (u.fog.a * visibility);
  return vec4<f32>(surface + shaft, albedo.a);
}
`;

/* eslint-disable @typescript-eslint/no-explicit-any */
export class WebGpuLitRenderer {
  private constructor(
    private readonly device: any,
    private readonly context: any,
    private readonly pipeline: any,
    private readonly bindGroup: any,
    private readonly albedoTex: any,
    private readonly normalTex: any,
    private readonly matTex: any,
    private readonly uniform: any,
    private readonly width: number,
    private readonly height: number,
  ) {}

  static async create(canvas: HTMLCanvasElement, width: number, height: number): Promise<WebGpuLitRenderer | null> {
    try {
      const gpu = (navigator as unknown as { gpu?: any }).gpu;
      if (!gpu) return null;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const context = canvas.getContext("webgpu") as any;
      if (!context) return null;

      const format = gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "premultiplied" });

      const module = device.createShaderModule({ code: SHADER });
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });

      const texture = () =>
        device.createTexture({
          size: [width, height],
          format: "rgba8unorm",
          usage: 0x4 /* TEXTURE_BINDING */ | 0x2 /* COPY_DST */ | 0x10 /* RENDER_ATTACHMENT */,
        });
      const albedoTex = texture();
      const normalTex = texture();
      const matTex = texture();
      const uniform = device.createBuffer({ size: 48, usage: 0x40 /* UNIFORM */ | 0x8 /* COPY_DST */ });
      const sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
      const linearSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: sampler },
          { binding: 1, resource: albedoTex.createView() },
          { binding: 2, resource: normalTex.createView() },
          { binding: 3, resource: { buffer: uniform } },
          { binding: 4, resource: matTex.createView() },
          { binding: 5, resource: linearSampler },
        ],
      });

      return new WebGpuLitRenderer(device, context, pipeline, bindGroup, albedoTex, normalTex, matTex, uniform, width, height);
    } catch {
      return null;
    }
  }

  render(
    albedo: Uint8ClampedArray,
    normal: Uint8ClampedArray,
    material: Uint8ClampedArray,
    light: Light,
    fog?: FogOptions,
  ): void {
    const layout = { bytesPerRow: this.width * 4, rowsPerImage: this.height };
    const size = { width: this.width, height: this.height };
    this.device.queue.writeTexture({ texture: this.albedoTex }, albedo, layout, size);
    this.device.queue.writeTexture({ texture: this.normalTex }, normal, layout, size);
    this.device.queue.writeTexture({ texture: this.matTex }, material, layout, size);
    const density = fog && fog.density > 0 ? fog.density : 0;
    const [fogR, fogG, fogB] = fog ? fog.color : [0, 0, 0];
    this.device.queue.writeBuffer(
      this.uniform,
      0,
      // Uniforms: light(col,row,height,ambient), dims(w,h,_,_), fog(r,g,b,density).
      new Float32Array([light.col, light.row, light.height, light.ambient, this.width, this.height, 0, 0, fogR, fogG, fogB, density]),
    );

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    try {
      this.device.destroy();
    } catch {
      // already gone
    }
  }
}
