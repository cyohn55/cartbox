/**
 * WebgpuLightingLayer — the WebGPU implementation of the lighting pipeline, the
 * preferred backend. It runs the same four passes as the WebGL {@link
 * LightingLayer} (lighting → bright → blur → composite) and the same lighting
 * model, in WGSL. `create` is async (WebGPU device acquisition is) and returns
 * null on any failure, so the factory can fall back to WebGL — never a blank
 * screen.
 *
 * WebGPU isn't in the TS DOM lib here and we avoid the @webgpu/types dependency
 * (matching the editor's WebGpuLitRenderer), so GPU handles are loosely typed.
 * WebGPU keeps a consistent top-left texture/framebuffer origin across render
 * targets, so — unlike the WebGL path — no pass needs a Y-flip.
 */

import { NORMAL_VECTORS } from "./lightingModel.js";
import { createFlatMaterial, type LightingBackend, type LightingRenderer } from "./LightingRenderer.js";
import type { LightingScene, MaterialBuffer } from "./types.js";
import type { RenderCanvas } from "./LightingLayer.js";

const MAX_LIGHTS = 6;
const HEIGHT_MAX = 8.0;

// GPU*Usage flag values (numeric because the handles are loosely typed).
const TEXTURE_BINDING = 0x04;
const COPY_DST_TEX = 0x02;
const RENDER_ATTACHMENT = 0x10;
const UNIFORM = 0x40;
const COPY_DST_BUF = 0x08;

// Shared fullscreen-triangle vertex stage. uv has v=0 at the top of the image.
const VS = /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let xy = corners[vi];
  var out: VSOut;
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return out;
}`;

const LIGHT_WGSL = VS + /* wgsl */ `
struct LightU {
  dims: vec4<f32>,                              // resX, resY, ambient, unlit
  misc: vec4<f32>,                              // ambientColor.rgb, lightCount
  flags: vec4<f32>,                             // enableShadows, _, _, _
  normals: array<vec4<f32>, 16>,                // xyz = normal
  lightPosRadius: array<vec4<f32>, ${MAX_LIGHTS}>,
  lightColor: array<vec4<f32>, ${MAX_LIGHTS}>,
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var albedoTex: texture_2d<f32>;
@group(0) @binding(2) var matTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: LightU;

const HMAX = ${HEIGHT_MAX.toFixed(1)};
const VIEW = vec3<f32>(0.0, -0.34, 0.94);

fn heightAt(p: vec2<f32>) -> f32 {
  return textureSampleLevel(matTex, samp, p / u.dims.xy, 0.0).g * HMAX;
}

fn shadowFactor(px: vec2<f32>, h0: f32, lp: vec3<f32>) -> f32 {
  let d = lp.xy - px;
  let dist = length(d);
  if (dist < 0.001) { return 1.0; }
  for (var i = 1; i <= 16; i = i + 1) {
    let t = f32(i) / 16.0;
    let rayH = mix(h0, lp.z, t);
    if (heightAt(px + d * t) > rayH + 0.45) { return 0.25; }
  }
  return 1.0;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let alb = textureSampleLevel(albedoTex, samp, in.uv, 0.0);
  if (u.dims.w > 0.5) { return vec4<f32>(alb.rgb, 1.0); } // unlit passthrough
  let m = textureSampleLevel(matTex, samp, in.uv, 0.0);
  let idx = clamp(i32(m.r * 255.0 + 0.5), 0, 15);
  let n = normalize(u.normals[idx].xyz);
  let height = m.g * HMAX;
  let specStr = m.b;
  let rough = m.a;
  let emissive = alb.a;
  let px = in.uv * u.dims.xy;
  let shininess = mix(6.0, 120.0, 1.0 - rough);
  var lightSum = u.dims.z * u.misc.xyz;
  let count = i32(u.misc.w);
  for (var i = 0; i < ${MAX_LIGHTS}; i = i + 1) {
    if (i >= count) { break; }
    let lp = u.lightPosRadius[i];
    let toLight = vec3<f32>(lp.xy - px, lp.z - height);
    let dist = length(toLight.xy);
    var atten = clamp(1.0 - dist / lp.w, 0.0, 1.0);
    atten = atten * atten;
    let L = normalize(toLight);
    var shadow = 1.0;
    if (u.flags.x > 0.5) { shadow = shadowFactor(px, height, lp.xyz); }
    let diffuse = max(0.0, dot(n, L)) * shadow;
    let halfVec = normalize(L + VIEW);
    let spec = pow(max(0.0, dot(n, halfVec)), shininess) * specStr * shadow;
    lightSum = lightSum + u.lightColor[i].xyz * atten * (diffuse + spec);
  }
  let rim = pow(1.0 - max(0.0, dot(n, VIEW)), 3.0);
  lightSum = lightSum + rim * u.misc.xyz * 0.5;
  var lit = alb.rgb * lightSum;
  lit = max(lit, alb.rgb * emissive);
  return vec4<f32>(lit, 1.0);
}`;

const BRIGHT_WGSL = VS + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: vec4<f32>; // threshold, _, _, _
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(sceneTex, samp, in.uv, 0.0).rgb;
  let l = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  return vec4<f32>(c * smoothstep(u.x, u.x + 0.25, l), 1.0);
}`;

const BLUR_WGSL = VS + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: vec4<f32>; // dir.xy, texel.xy
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let o = u.xy * u.zw;
  var sum = textureSampleLevel(srcTex, samp, in.uv, 0.0).rgb * 0.227;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv + o * 1.0, 0.0).rgb * 0.194;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv - o * 1.0, 0.0).rgb * 0.194;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv + o * 2.0, 0.0).rgb * 0.121;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv - o * 2.0, 0.0).rgb * 0.121;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv + o * 3.0, 0.0).rgb * 0.054;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv - o * 3.0, 0.0).rgb * 0.054;
  return vec4<f32>(sum, 1.0);
}`;

const COMPOSITE_WGSL = VS + /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: vec4<f32>; // bloomStrength, useBloom, _, _
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  var c = textureSampleLevel(sceneTex, samp, in.uv, 0.0).rgb;
  if (u.y > 0.5) { c = c + textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb * u.x; }
  return vec4<f32>(c, 1.0);
}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
export class WebgpuLightingLayer implements LightingRenderer {
  readonly backend: LightingBackend = "webgpu";
  private flatMaterial: Uint8Array | null = null;
  private readonly lightData = new Float32Array(124); // matches LightU (496 bytes)
  private readonly compData = new Float32Array(4);

  private constructor(
    private readonly device: any,
    private readonly context: any,
    private readonly width: number,
    private readonly height: number,
    private readonly textures: { albedo: any; mat: any },
    private readonly targets: { scene: any; bright: any; blurA: any; blurB: any },
    private readonly pipelines: { light: any; bright: any; blur: any; composite: any },
    private readonly binds: { light: any; bright: any; blurA: any; blurB: any; composite: any },
    private readonly buffers: { light: any; composite: any },
  ) {
    NORMAL_VECTORS.forEach((v, i) => {
      this.lightData[12 + i * 4] = v[0];
      this.lightData[12 + i * 4 + 1] = v[1];
      this.lightData[12 + i * 4 + 2] = v[2];
    });
  }

  static async create(
    canvas: RenderCanvas,
    width: number,
    height: number,
    device: any,
  ): Promise<WebgpuLightingLayer | null> {
    try {
      const gpu = (globalThis as any).navigator?.gpu;
      if (!gpu || !device) return null;
      const context = canvas.getContext("webgpu") as any;
      if (!context) return null;
      canvas.width = width;
      canvas.height = height;
      const format = gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "opaque" });

      const dataTexture = () =>
        device.createTexture({ size: [width, height], format: "rgba8unorm", usage: TEXTURE_BINDING | COPY_DST_TEX });
      const targetTexture = () =>
        device.createTexture({ size: [width, height], format: "rgba8unorm", usage: TEXTURE_BINDING | RENDER_ATTACHMENT });

      const albedo = dataTexture();
      const mat = dataTexture();
      const scene = targetTexture();
      const bright = targetTexture();
      const blurA = targetTexture();
      const blurB = targetTexture();

      const nearest = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
      const linear = device.createSampler({ magFilter: "linear", minFilter: "linear" });

      const pipe = (code: string, targetFormat: string) => {
        const module = device.createShaderModule({ code });
        return device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs" },
          fragment: { module, entryPoint: "fs", targets: [{ format: targetFormat }] },
          primitive: { topology: "triangle-list" },
        });
      };
      const light = pipe(LIGHT_WGSL, "rgba8unorm");
      const brightPipe = pipe(BRIGHT_WGSL, "rgba8unorm");
      const blurPipe = pipe(BLUR_WGSL, "rgba8unorm");
      const composite = pipe(COMPOSITE_WGSL, format);

      const uniform = (size: number) => device.createBuffer({ size, usage: UNIFORM | COPY_DST_BUF });
      const lightBuffer = uniform(496);
      const brightBuffer = uniform(16);
      const blurBufferH = uniform(16);
      const blurBufferV = uniform(16);
      const compositeBuffer = uniform(16);

      // Static uniforms: bright threshold and the two blur directions/texel size.
      device.queue.writeBuffer(brightBuffer, 0, new Float32Array([0.72, 0, 0, 0]));
      device.queue.writeBuffer(blurBufferH, 0, new Float32Array([1, 0, 1 / width, 1 / height]));
      device.queue.writeBuffer(blurBufferV, 0, new Float32Array([0, 1, 1 / width, 1 / height]));

      const bind = (pipeline: any, entries: any[]) =>
        device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      const tex = (t: any) => t.createView();

      const binds = {
        light: bind(light, [
          { binding: 0, resource: nearest },
          { binding: 1, resource: tex(albedo) },
          { binding: 2, resource: tex(mat) },
          { binding: 3, resource: { buffer: lightBuffer } },
        ]),
        bright: bind(brightPipe, [
          { binding: 0, resource: nearest },
          { binding: 1, resource: tex(scene) },
          { binding: 2, resource: { buffer: brightBuffer } },
        ]),
        blurA: bind(blurPipe, [
          { binding: 0, resource: linear },
          { binding: 1, resource: tex(bright) },
          { binding: 2, resource: { buffer: blurBufferH } },
        ]),
        blurB: bind(blurPipe, [
          { binding: 0, resource: linear },
          { binding: 1, resource: tex(blurA) },
          { binding: 2, resource: { buffer: blurBufferV } },
        ]),
        composite: bind(composite, [
          { binding: 0, resource: nearest },
          { binding: 1, resource: tex(scene) },
          { binding: 2, resource: tex(blurB) },
          { binding: 3, resource: { buffer: compositeBuffer } },
        ]),
      };

      return new WebgpuLightingLayer(
        device, context, width, height,
        { albedo, mat },
        { scene, bright, blurA, blurB },
        { light, bright: brightPipe, blur: blurPipe, composite },
        binds,
        { light: lightBuffer, composite: compositeBuffer },
      );
    } catch {
      return null;
    }
  }

  render(albedo: Uint8Array, material: MaterialBuffer | null, scene: LightingScene): void {
    const q = this.device.queue;
    const mat = material ?? this.flatMaterialBuffer();
    const layout = { bytesPerRow: this.width * 4, rowsPerImage: this.height };
    const size = { width: this.width, height: this.height };
    q.writeTexture({ texture: this.textures.albedo }, albedo, layout, size);
    q.writeTexture({ texture: this.textures.mat }, mat, layout, size);

    const u = this.lightData;
    const count = Math.min(scene.lights.length, MAX_LIGHTS);
    u[0] = this.width; u[1] = this.height; u[2] = scene.ambient; u[3] = scene.unlit ? 1 : 0;
    u[4] = scene.ambientColor[0]; u[5] = scene.ambientColor[1]; u[6] = scene.ambientColor[2]; u[7] = count;
    u[8] = scene.shadows && material ? 1 : 0; u[9] = 0; u[10] = 0; u[11] = 0;
    for (let i = 0; i < count; i += 1) {
      const light = scene.lights[i]!;
      u[76 + i * 4] = light.x; u[76 + i * 4 + 1] = light.y; u[76 + i * 4 + 2] = light.z; u[76 + i * 4 + 3] = light.radius;
      u[100 + i * 4] = light.color[0]; u[100 + i * 4 + 1] = light.color[1]; u[100 + i * 4 + 2] = light.color[2];
    }
    q.writeBuffer(this.buffers.light, 0, u);

    const useBloom = scene.bloom && !scene.unlit;
    this.compData[0] = 1.1; this.compData[1] = useBloom ? 1 : 0;
    q.writeBuffer(this.buffers.composite, 0, this.compData);

    const encoder = this.device.createCommandEncoder();
    this.runPass(encoder, this.targets.scene.createView(), this.pipelines.light, this.binds.light);
    if (useBloom) {
      this.runPass(encoder, this.targets.bright.createView(), this.pipelines.bright, this.binds.bright);
      this.runPass(encoder, this.targets.blurA.createView(), this.pipelines.blur, this.binds.blurA);
      this.runPass(encoder, this.targets.blurB.createView(), this.pipelines.blur, this.binds.blurB);
    }
    this.runPass(encoder, this.context.getCurrentTexture().createView(), this.pipelines.composite, this.binds.composite);
    q.submit([encoder.finish()]);
  }

  dispose(): void {
    for (const t of [this.textures.albedo, this.textures.mat, this.targets.scene, this.targets.bright, this.targets.blurA, this.targets.blurB]) {
      try { t.destroy(); } catch { /* already gone */ }
    }
    // The GPU device is shared (memoised) across surfaces, so it is not destroyed here.
  }

  private runPass(encoder: any, view: any, pipeline: any, bindGroup: any): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  private flatMaterialBuffer(): Uint8Array {
    if (!this.flatMaterial) this.flatMaterial = createFlatMaterial(this.width, this.height);
    return this.flatMaterial;
  }
}
