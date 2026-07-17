"use client";

/**
 * WebGPU renderer for the backdrop's 3D props: the optional accelerated path.
 * Each prop's surface voxels are uploaded once as GPU cube instances; per frame
 * the same rotation, placement, bob and lighting the CPU compositor computes are
 * done in the vertex shader (flat per-voxel shading, so the two paths match),
 * with a depth buffer for correct occlusion. Props are drawn in order, each in
 * its own pass with a cleared depth buffer, so nearer props paint over farther
 * ones exactly like the CPU `drawImage` order.
 *
 * `create` returns null on any failure or when WebGPU is unavailable, so the
 * caller falls back to the CPU compositor — this is never a blank overlay. The
 * public shape (`render(seconds)` / `destroy()`) matches CpuVoxelCompositor.
 *
 * WebGPU isn't in the TS DOM lib here and we avoid the @webgpu/types dependency,
 * so the GPU handles are loosely typed; the maths mirrors the tested CPU path.
 */

import { propMotion } from "@/lib/bobSpin";
import { CUBE_FACES } from "@cartbox/editor";

import { BACKDROP_LIGHT, type VoxelProp } from "@/lib/retroVoxels";

const SHADER = /* wgsl */ `
struct Uniforms {
  rot: vec4<f32>,      // yaw, pitch, cell, depthRange
  anchor: vec4<f32>,   // anchorX(px), anchorY(px), dimW, dimH
  light: vec4<f32>,    // lx, ly, lz, ambient
  lightCol: vec4<f32>, // r, g, b, intensity
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec3<f32>,
};

@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @location(0) corner: vec3<f32>,
  @location(5) normal: vec3<f32>,
  @location(1) center: vec3<f32>,
  @location(2) color: vec3<f32>,
  @location(3) emissive: f32,
  @location(4) faceMask: f32,
) -> VSOut {
  var out: VSOut;

  // Each cube face is 6 vertices; drop the ones whose face is inside the object
  // (not set in the mask) by emitting a clipped, zero-area triangle.
  let faceBit = 1u << (vi / 6u);
  if ((u32(faceMask) & faceBit) == 0u) {
    out.pos = vec4<f32>(-2.0, -2.0, -2.0, 1.0);
    out.color = vec3<f32>(0.0);
    return out;
  }

  let yaw = u.rot.x;
  let pitch = u.rot.y;
  let cell = u.rot.z;
  let depthRange = u.rot.w;
  let cy = cos(yaw); let sy = sin(yaw);
  let cp = cos(pitch); let sp = sin(pitch);

  let v = center + corner;
  let yawX = v.x * cy + v.z * sy;
  let yawZ = -v.x * sy + v.z * cy;
  let camY = v.y * cp - yawZ * sp;
  let camZ = v.y * sp + yawZ * cp;

  let px = u.anchor.x + yawX * cell;
  let py = u.anchor.y - camY * cell;
  let depth = -camZ * cell;

  out.pos = vec4<f32>(
    2.0 * px / u.anchor.z - 1.0,
    1.0 - 2.0 * py / u.anchor.w,
    clamp((depth + depthRange) / (2.0 * depthRange), 0.0, 1.0),
    1.0,
  );

  // Rotate this face's normal the same way and light it against the world light,
  // so every face of the cube shades separately (the solid-block read).
  let nYawX = normal.x * cy + normal.z * sy;
  let nYawZ = -normal.x * sy + normal.z * cy;
  let wnY = normal.y * cp - nYawZ * sp;
  let wnZ = normal.y * sp + nYawZ * cp;
  let wnX = nYawX;
  let diffuse = max(0.0, wnX * u.light.x + wnY * u.light.y + wnZ * u.light.z);
  let shade = u.light.w + (1.0 - u.light.w) * diffuse * u.lightCol.w;
  let lit = color * shade * u.lightCol.rgb;
  out.color = max(lit, color * emissive);
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.color, 1.0);
}
`;

// A unit cube centred on the origin, 12 triangles (36 vertices), positions only.
const CUBE = buildCube();

const DEPTH_RANGE = 256;

// Multisample count for anti-aliasing, matching the CPU path's supersampling:
// without it a spinning prop's voxel edges snap per pixel and read as a swarm of
// loose voxels instead of one rigid solid. 4 is universally supported.
const SAMPLE_COUNT = 4;

interface PropGpu {
  readonly prop: VoxelProp;
  readonly instances: unknown; // GPU buffer
  readonly instanceCount: number;
  readonly uniform: unknown; // GPU buffer
  readonly bindGroup: unknown;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class WebGpuVoxelRenderer {
  private constructor(
    private readonly device: any,
    private readonly context: any,
    private readonly pipeline: any,
    private readonly cubeBuffer: any,
    private readonly depthView: any,
    private readonly msaaView: any,
    private readonly props: PropGpu[],
    private readonly bufferWidth: number,
    private readonly bufferHeight: number,
    private readonly pitch: number,
  ) {}

  static async create(
    canvas: HTMLCanvasElement,
    props: readonly VoxelProp[],
    options: { bufferWidth: number; bufferHeight: number; pitch: number },
  ): Promise<WebGpuVoxelRenderer | null> {
    try {
      const gpu = (navigator as unknown as { gpu?: any }).gpu;
      if (!gpu) return null;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const context = canvas.getContext("webgpu") as any;
      if (!context) return null;

      canvas.width = options.bufferWidth;
      canvas.height = options.bufferHeight;
      const format = gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "premultiplied" });

      const module = device.createShaderModule({ code: SHADER });
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module,
          entryPoint: "vs",
          buffers: [
            {
              arrayStride: 24,
              stepMode: "vertex",
              attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x3" }, // cube corner
                { shaderLocation: 5, offset: 12, format: "float32x3" }, // face normal
              ],
            },
            {
              arrayStride: 32,
              stepMode: "instance",
              attributes: [
                { shaderLocation: 1, offset: 0, format: "float32x3" }, // center
                { shaderLocation: 2, offset: 12, format: "float32x3" }, // color
                { shaderLocation: 3, offset: 24, format: "float32" }, // emissive
                { shaderLocation: 4, offset: 28, format: "float32" }, // exposed-face mask
              ],
            },
          ],
        },
        fragment: { module, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
        multisample: { count: SAMPLE_COUNT },
      });

      const cubeBuffer = device.createBuffer({ size: CUBE.byteLength, usage: 0x20 /* VERTEX */ | 0x8 /* COPY_DST */ });
      device.queue.writeBuffer(cubeBuffer, 0, CUBE);

      const depthTexture = device.createTexture({
        size: [options.bufferWidth, options.bufferHeight],
        format: "depth24plus",
        sampleCount: SAMPLE_COUNT,
        usage: 0x10 /* RENDER_ATTACHMENT */,
      });
      const depthView = depthTexture.createView();

      // Multisampled colour target; each pass resolves it into the swap-chain
      // texture, so the composited props are anti-aliased.
      const msaaTexture = device.createTexture({
        size: [options.bufferWidth, options.bufferHeight],
        format,
        sampleCount: SAMPLE_COUNT,
        usage: 0x10 /* RENDER_ATTACHMENT */,
      });
      const msaaView = msaaTexture.createView();

      const propGpus: PropGpu[] = props.map((prop) => {
        const instances = buildInstances(prop);
        const instanceBuffer = device.createBuffer({ size: instances.byteLength, usage: 0x20 | 0x8 });
        device.queue.writeBuffer(instanceBuffer, 0, instances);
        const uniform = device.createBuffer({ size: 64, usage: 0x40 /* UNIFORM */ | 0x8 });
        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer: uniform } }],
        });
        return { prop, instances: instanceBuffer, instanceCount: instances.length / INSTANCE_FLOATS, uniform, bindGroup };
      });

      return new WebGpuVoxelRenderer(
        device,
        context,
        pipeline,
        cubeBuffer,
        depthView,
        msaaView,
        propGpus,
        options.bufferWidth,
        options.bufferHeight,
        options.pitch,
      );
    } catch {
      return null;
    }
  }

  render(seconds: number): void {
    const [lx, ly, lz] = BACKDROP_LIGHT.direction;
    const [lr, lg, lb] = BACKDROP_LIGHT.color;
    const encoder = this.device.createCommandEncoder();
    const target = this.context.getCurrentTexture().createView();

    this.props.forEach((gpu, index) => {
      const { yaw, bobY } = propMotion(seconds, gpu.prop.motion);
      const anchorX = gpu.prop.fx * this.bufferWidth;
      const anchorY = gpu.prop.fy * this.bufferHeight + bobY;
      this.device.queue.writeBuffer(
        gpu.uniform,
        0,
        new Float32Array([
          yaw, this.pitch, gpu.prop.cell, DEPTH_RANGE,
          anchorX, anchorY, this.bufferWidth, this.bufferHeight,
          lx, ly, lz, BACKDROP_LIGHT.ambient,
          lr, lg, lb, BACKDROP_LIGHT.intensity,
        ]),
      );

      // First prop clears the overlay; each prop gets a fresh depth buffer so
      // draw order (nearer prop over farther) matches the CPU compositor.
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.msaaView,
            resolveTarget: target,
            loadOp: index === 0 ? "clear" : "load",
            storeOp: "store",
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
        depthStencilAttachment: {
          view: this.depthView,
          depthLoadOp: "clear",
          depthClearValue: 1,
          depthStoreOp: "store",
        },
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, gpu.bindGroup);
      pass.setVertexBuffer(0, this.cubeBuffer);
      pass.setVertexBuffer(1, gpu.instances);
      pass.draw(36, gpu.instanceCount);
      pass.end();
    });

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

/** Floats per instance: center(3) + color(3) + emissive(1) + exposed-face mask(1). */
const INSTANCE_FLOATS = 8;

/** Per-voxel instance data: center(3) + color(3) + emissive(1) + face mask(1). */
function buildInstances(prop: VoxelProp): Float32Array {
  const { model } = prop;
  const data = new Float32Array(model.count * INSTANCE_FLOATS);
  for (let v = 0; v < model.count; v += 1) {
    const o = v * INSTANCE_FLOATS;
    data[o] = model.x[v]!;
    data[o + 1] = model.y[v]!;
    data[o + 2] = model.z[v]!;
    data[o + 3] = model.r[v]! / 255;
    data[o + 4] = model.g[v]! / 255;
    data[o + 5] = model.b[v]! / 255;
    data[o + 6] = model.emissive[v]!;
    data[o + 7] = model.faces[v]!;
  }
  return data;
}

/**
 * The unit cube as 36 vertices (6 faces × 2 triangles), each carrying its face's
 * outward normal, generated from the shared {@link CUBE_FACES} in that exact
 * order so the shader can map a vertex to its face bit as `1 << (index / 6)`.
 * Layout per vertex: position(3) + normal(3).
 */
function buildCube(): Float32Array {
  const data: number[] = [];
  for (const face of CUBE_FACES) {
    const [a, b, c, d] = face.corners;
    for (const corner of [a!, b!, c!, a!, c!, d!]) {
      data.push(corner[0]!, corner[1]!, corner[2]!, face.normal[0], face.normal[1], face.normal[2]);
    }
  }
  return Float32Array.from(data);
}
