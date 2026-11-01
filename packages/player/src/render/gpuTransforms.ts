/**
 * Each copy's transforms made on the GPU (AAA_FIDELITY_ROADMAP.md F0e): the
 * CPU writes only a copy's model matrix into its instance record (and, in its
 * motion record, last frame's model), and one compute pass fills the rest:
 * the clip transform (`mvp`), the light's (`lightMvp`) and the normal basis;
 * and, in the motion record, the clip transform now and last frame (without
 * the temporal jitter). Before it the CPU multiplied four matrices a copy,
 * every frame.
 *
 * Each invocation writes only its own record, and reads only model slots,
 * which nothing writes, so the records fill in place.
 */

import type { Mat4 } from "@cartbox/editor";

import { INSTANCE_FLOATS } from "./scenePacking.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- WebGPU handles aren't typed in this build */

const COPY_DST = 0x08;
const UNIFORM = 0x40;
const WORKGROUP = 64;
/** Four matrices, then the counts. */
const UNIFORM_BYTES = 4 * 64 + 16;

export const TRANSFORM_WGSL = /* wgsl */ `
struct Frame {
  viewProj: mat4x4<f32>,
  lightViewProj: mat4x4<f32>,
  viewProjNow: mat4x4<f32>,
  viewProjThen: mat4x4<f32>,
  counts: vec4<u32>,   // x = copies, y = 1 with a shadow (else its matrix is zero), z = 1 with motion records (after the copies')
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read_write> xf: array<f32>;

const RECORD = ${INSTANCE_FLOATS}u;

fn modelAt(i: u32) -> mat4x4<f32> {
  let b = i * RECORD + 32u;
  return mat4x4<f32>(
    vec4<f32>(xf[b], xf[b + 1u], xf[b + 2u], xf[b + 3u]),
    vec4<f32>(xf[b + 4u], xf[b + 5u], xf[b + 6u], xf[b + 7u]),
    vec4<f32>(xf[b + 8u], xf[b + 9u], xf[b + 10u], xf[b + 11u]),
    vec4<f32>(xf[b + 12u], xf[b + 13u], xf[b + 14u], xf[b + 15u]),
  );
}

fn put(i: u32, at: u32, m: mat4x4<f32>) {
  let b = i * RECORD + at;
  for (var c = 0u; c < 4u; c = c + 1u) {
    for (var r = 0u; r < 4u; r = r + 1u) { xf[b + c * 4u + r] = m[c][r]; }
  }
}

@compute @workgroup_size(${WORKGROUP})
fn fill(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  let n = frame.counts.x;
  if (i < n) {
    let model = modelAt(i);
    put(i, 0u, frame.viewProj * model);
    // With no shadow the light's matrix is zero, and so is the product.
    put(i, 16u, frame.lightViewProj * model);
    // The normal basis: the model's own 3×3, a column a vec4.
    let b = i * RECORD + 48u;
    for (var c = 0u; c < 3u; c = c + 1u) {
      for (var r = 0u; r < 3u; r = r + 1u) { xf[b + c * 4u + r] = model[c][r]; }
      xf[b + c * 4u + 3u] = 0.0;
    }
  } else if (frame.counts.z != 0u && i < 2u * n) {
    // A motion record: its model slot holds last frame's model; the copy's own is its record's.
    put(i, 0u, frame.viewProjNow * modelAt(i - n));
    put(i, 16u, frame.viewProjThen * modelAt(i));
  }
}
`;

/** The frame's matrices: the jittered clip transform, the light's (null: no shadow), and the unjittered ones now and last frame (null: no motion records). */
export interface TransformFrame {
  readonly viewProj: Mat4;
  readonly lightViewProj: Mat4 | null;
  readonly motion: { readonly now: Mat4; readonly then: Mat4 } | null;
}

/**
 * Write a copy's model matrix into its record (see {@link INSTANCE_FLOATS});
 * {@link GpuTransforms.encode} fills the rest.
 */
export function writeInstanceModel(target: Float32Array, index: number, model: Mat4): void {
  const base = index * INSTANCE_FLOATS + 32;
  for (let i = 0; i < 16; i += 1) target[base + i] = model[i]!;
}

/** The pass's pipeline and uniforms on one device. */
export class GpuTransforms {
  private readonly uniforms: any;
  private readonly pipeline: any;
  private readonly layout: any;
  private readonly data = new ArrayBuffer(UNIFORM_BYTES);
  private copies = 0;
  private motion = false;

  constructor(private readonly device: any) {
    this.uniforms = device.createBuffer({ size: UNIFORM_BYTES, usage: UNIFORM | COPY_DST });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x4, buffer: { type: "uniform" } },
        { binding: 1, visibility: 0x4, buffer: { type: "storage" } },
      ],
    });
    this.pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ code: TRANSFORM_WGSL }), entryPoint: "fill" },
    });
  }

  /** The frame's `copies` and matrices; their records (and motion records, `copies` on) start at 0. */
  prepare(copies: number, frame: TransformFrame): void {
    const f = new Float32Array(this.data);
    const mat = (m: Mat4 | null, at: number) => {
      for (let i = 0; i < 16; i += 1) f[at + i] = m ? m[i]! : 0;
    };
    mat(frame.viewProj, 0);
    mat(frame.lightViewProj, 16);
    mat(frame.motion?.now ?? null, 32);
    mat(frame.motion?.then ?? null, 48);
    new Uint32Array(this.data).set([copies, frame.lightViewProj ? 1 : 0, frame.motion ? 1 : 0, 0], 64);
    this.device.queue.writeBuffer(this.uniforms, 0, this.data);
    this.copies = copies;
    this.motion = frame.motion !== null;
  }

  encode(encoder: any, instances: any): void {
    const records = this.copies * (this.motion ? 2 : 1);
    if (records === 0) return;
    const group = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: { buffer: instances } },
      ],
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(records / WORKGROUP));
    pass.end();
  }

  destroy(): void {
    this.uniforms.destroy();
  }
}
