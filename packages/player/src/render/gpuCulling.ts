/**
 * GPU-driven culling (AAA_FIDELITY_ROADMAP.md F0e): the AAA tier's frame
 * decides on the GPU which copies it draws, with indirect draws, so the CPU
 * neither tests them nor rasterises a depth pre-pass of its own to hide them.
 *
 * - **Bounds.** Each draw batch gives the sphere around its primitive (in the
 *   mesh's own space, widened by the wind's furthest bend). A copy's world
 *   sphere comes from its model matrix, read from the instance buffer the
 *   frame already wrote, so nothing is done per copy on the CPU.
 * - **Two rounds.** Before the depth prepass, the frustum: what survives is
 *   compacted into a region of the instance buffer, and the batch's indirect
 *   arguments count it; the prepass draws that (from instance 0, the draw's
 *   uniform adding where its copies start). Then a Hi-Z pyramid of the
 *   prepass's depths (each texel the farthest of the four below it), and the
 *   frustum's survivors tested against it: a sphere whose nearest depth lies
 *   behind the farthest depth over its screen rectangle is hidden. What
 *   remains is compacted again, over the first round's, and the shading
 *   passes draw that.
 * - **Conservative.** The pyramid is this frame's real geometry, so only what
 *   is truly behind something is dropped; a sphere crossing the near plane is
 *   kept. Copies keep their order (a workgroup's prefix sum per batch), so the
 *   frame draws them as it would have, less the hidden ones.
 * - **What it leaves alone.** Batches whose vertices move on the GPU or in a
 *   graph (live skinning, cloth, a world-position offset), and see-through
 *   batches (drawn in order, farthest first), are copied whole.
 */

import type { MeshPrimitive } from "@cartbox/editor";

import { INSTANCE_FLOATS } from "./scenePacking.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- WebGPU handles aren't typed in this build */

/** Bytes of one batch's entry: first, count, eligible, index count, then the local sphere. */
const ENTRY_BYTES = 32;
/** One batch's `drawIndexedIndirect` arguments, in u32s. */
export const INDIRECT_WORDS = 5;
const UNIFORM_BYTES = 6 * 16 + 64 + 32;
/** The rounds' uniforms sit a dynamic-offset alignment apart. */
const UNIFORM_STRIDE = 256;
const WORKGROUP = 64;

const STORAGE = 0x80;
const COPY_DST = 0x08;
const INDIRECT = 0x100;
const COPY_SRC = 0x04;
const UNIFORM = 0x40;
const TEXTURE_BINDING = 0x04;
const STORAGE_BINDING = 0x08;
const COMPUTE = 0x4;

export const CULL_WGSL = /* wgsl */ `
struct Entry { first: u32, count: u32, eligible: u32, indexCount: u32, sphere: vec4<f32> };
struct Cull {
  planes: array<vec4<f32>, 6>,
  viewProj: mat4x4<f32>,
  size: vec4<f32>,     // x, y = the depth's size; z = the pyramid's levels; w = 1 to test against it
  counts: vec4<u32>,   // x = batches, y = copies, z = where the round's region starts, w = which round (0, 1)
};
@group(0) @binding(0) var<uniform> cull: Cull;
@group(0) @binding(1) var<storage, read> entries: array<Entry>;
@group(0) @binding(2) var<storage, read_write> xf: array<f32>;
@group(0) @binding(3) var<storage, read_write> flags: array<u32>;
@group(0) @binding(4) var<storage, read_write> args: array<u32>;
@group(0) @binding(5) var hiz: texture_2d<f32>;

const RECORD = ${INSTANCE_FLOATS}u;

/** The batch a copy belongs to (batches are in order of their first copy). */
fn owner(i: u32) -> u32 {
  var lo = 0u;
  var hi = cull.counts.x;
  loop {
    if (hi - lo <= 1u) { break; }
    let mid = (lo + hi) / 2u;
    if (entries[mid].first <= i) { lo = mid; } else { hi = mid; }
  }
  return lo;
}

fn hidden(c: vec3<f32>, r: f32) -> bool {
  var lo = vec2<f32>(1e9);
  var hi = vec2<f32>(-1e9);
  var nearest = 1.0;
  for (var k = 0u; k < 8u; k = k + 1u) {
    let corner = c + r * vec3<f32>(select(-1.0, 1.0, (k & 1u) != 0u), select(-1.0, 1.0, (k & 2u) != 0u), select(-1.0, 1.0, (k & 4u) != 0u));
    let clip = cull.viewProj * vec4<f32>(corner, 1.0);
    // Reaching the eye's plane: no rectangle to test, so seen.
    if (clip.w <= 1e-4) { return false; }
    let ndc = clip.xyz / clip.w;
    let px = vec2<f32>((ndc.x * 0.5 + 0.5) * cull.size.x, (0.5 - ndc.y * 0.5) * cull.size.y);
    lo = min(lo, px);
    hi = max(hi, px);
    nearest = min(nearest, ndc.z);
  }
  if (nearest <= 0.0) { return false; }
  lo = clamp(lo, vec2<f32>(0.0), cull.size.xy - 1.0);
  hi = clamp(hi, vec2<f32>(0.0), cull.size.xy - 1.0);
  // The level where the rectangle spans at most two texels each way.
  let extent = max(hi.x - lo.x, hi.y - lo.y);
  let level = min(u32(ceil(log2(max(extent, 1.0)))), u32(cull.size.z) - 1u);
  // The level's size from the first's (asking for the level's own reads 1 on Dawn).
  let dims = max(vec2<i32>(textureDimensions(hiz)) >> vec2<u32>(level), vec2<i32>(1));
  let a = min(vec2<i32>(lo) >> vec2<u32>(level), dims - 1);
  let b = min(vec2<i32>(hi) >> vec2<u32>(level), dims - 1);
  var farthest = 0.0;
  for (var y = a.y; y <= b.y; y = y + 1) {
    for (var x = a.x; x <= b.x; x = x + 1) {
      farthest = max(farthest, textureLoad(hiz, vec2<i32>(x, y), level).r);
    }
  }
  return nearest > farthest;
}

@compute @workgroup_size(${WORKGROUP})
fn test(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= cull.counts.y) { return; }
  let e = entries[owner(i)];
  var seen = 1u;
  if (e.eligible != 0u) {
    let b = i * RECORD + 32u;
    let model = mat4x4<f32>(
      vec4<f32>(xf[b], xf[b + 1u], xf[b + 2u], xf[b + 3u]),
      vec4<f32>(xf[b + 4u], xf[b + 5u], xf[b + 6u], xf[b + 7u]),
      vec4<f32>(xf[b + 8u], xf[b + 9u], xf[b + 10u], xf[b + 11u]),
      vec4<f32>(xf[b + 12u], xf[b + 13u], xf[b + 14u], xf[b + 15u]),
    );
    let c = (model * vec4<f32>(e.sphere.xyz, 1.0)).xyz;
    let r = e.sphere.w * max(length(model[0].xyz), max(length(model[1].xyz), length(model[2].xyz)));
    for (var p = 0u; p < 6u; p = p + 1u) {
      let plane = cull.planes[p];
      if (dot(plane.xyz, c) + plane.w < -r) { seen = 0u; }
    }
    if (seen == 1u && cull.size.w > 0.5 && hidden(c, r)) { seen = 0u; }
  }
  flags[i] = seen;
}

var<workgroup> scan: array<u32, ${WORKGROUP}>;

/** One batch a workgroup: its seen copies' records (and their motion records) packed into the round's region, in order. */
@compute @workgroup_size(${WORKGROUP})
fn compact(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let index = group.x + group.y * 65535u;
  if (index >= cull.counts.x) { return; }
  let e = entries[index];
  let n = cull.counts.y;
  let region = cull.counts.z;
  var kept = 0u;
  for (var start = 0u; start < e.count; start = start + ${WORKGROUP}u) {
    let j = start + local.x;
    let seen = select(0u, flags[e.first + j], j < e.count);
    scan[local.x] = seen;
    workgroupBarrier();
    for (var step = 1u; step < ${WORKGROUP}u; step = step * 2u) {
      let add = select(0u, scan[local.x - step], local.x >= step);
      workgroupBarrier();
      scan[local.x] = scan[local.x] + add;
      workgroupBarrier();
    }
    if (seen == 1u) {
      let to = region + e.first + kept + scan[local.x] - 1u;
      let src = e.first + j;
      for (var f = 0u; f < RECORD; f = f + 1u) {
        xf[to * RECORD + f] = xf[src * RECORD + f];
        xf[(to + n) * RECORD + f] = xf[(src + n) * RECORD + f];
      }
    }
    kept = kept + workgroupUniformLoad(&scan[${WORKGROUP - 1}u]);
  }
  if (local.x == 0u) {
    let a = (cull.counts.w * cull.counts.x + index) * ${INDIRECT_WORDS}u;
    args[a] = e.indexCount;
    args[a + 1u] = kept;
    args[a + 2u] = 0u;
    args[a + 3u] = 0u;
    // Indirect draws start at instance 0 (a later one needs an optional feature): the draw's uniform adds where its copies start.
    args[a + 4u] = 0u;
  }
}
`;

/** The Hi-Z pyramid: the first level copied from the depths, each next the farthest of the four (or, at an odd edge, nine) below. */
export const HIZ_MAX_WGSL = /* wgsl */ `
@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var level0: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn first(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(depth);
  if (id.x >= size.x || id.y >= size.y) { return; }
  textureStore(level0, vec2<i32>(id.xy), vec4<f32>(textureLoad(depth, vec2<i32>(id.xy), 0), 0.0, 0.0, 1.0));
}
`;

export const HIZ_DOWN_WGSL = /* wgsl */ `
@group(0) @binding(0) var above: texture_2d<f32>;
@group(0) @binding(1) var below: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn down(@builtin(global_invocation_id) id: vec3<u32>) {
  let out = textureDimensions(below);
  if (id.x >= out.x || id.y >= out.y) { return; }
  let size = vec2<i32>(textureDimensions(above));
  let p = vec2<i32>(id.xy) * 2;
  // An odd row or column at the edge folds into the last texel, so nothing falls between the cells.
  let ex = select(1, 2, i32(id.x) == i32(out.x) - 1 && p.x + 3 == size.x);
  let ey = select(1, 2, i32(id.y) == i32(out.y) - 1 && p.y + 3 == size.y);
  var z = 0.0;
  for (var y = 0; y <= ey; y += 1) {
    for (var x = 0; x <= ex; x += 1) {
      z = max(z, textureLoad(above, min(p + vec2<i32>(x, y), size - 1), 0).r);
    }
  }
  textureStore(below, vec2<i32>(id.xy), vec4<f32>(z, 0.0, 0.0, 1.0));
}
`;

/** The six planes (normalised, inward) of a view-projection's frustum, for WebGPU's 0..1 depth. */
export function frustumPlanesOf(m: ArrayLike<number>): Float32Array {
  const row = (r: number) => [m[r]!, m[4 + r]!, m[8 + r]!, m[12 + r]!];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const planes = [r3.map((v, i) => v + r0[i]!), r3.map((v, i) => v - r0[i]!), r3.map((v, i) => v + r1[i]!), r3.map((v, i) => v - r1[i]!), r2, r3.map((v, i) => v - r2[i]!)];
  const out = new Float32Array(24);
  planes.forEach((p, k) => {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!) || 1;
    out.set(p.map((v) => v / l), k * 4);
  });
  return out;
}

const spheres = new WeakMap<MeshPrimitive, [number, number, number, number, number]>();

/** A primitive's bounding sphere in its mesh's space (the box's centre and half-diagonal), and its furthest sway. */
export function primitiveSphere(primitive: MeshPrimitive): readonly [number, number, number, number, number] {
  let s = spheres.get(primitive);
  if (s) return s;
  const p = primitive.positions;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < p.length; i += 3)
    for (let a = 0; a < 3; a += 1) {
      lo[a] = Math.min(lo[a]!, p[i + a]!);
      hi[a] = Math.max(hi[a]!, p[i + a]!);
    }
  if (!(lo[0]! <= hi[0]!)) s = [0, 0, 0, 0, 0];
  else {
    let sway = 0;
    if (primitive.sway) for (const v of primitive.sway) sway = Math.max(sway, v);
    s = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2, Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2, sway];
  }
  spheres.set(primitive, s);
  return s;
}

/** One batch, as the cull sees it. */
export interface CullBatch {
  readonly first: number;
  readonly count: number;
  readonly indexCount: number;
  /** Null: drawn whole (its vertices move, or it's see-through). */
  readonly sphere: readonly [number, number, number, number] | null;
}

/** The culling's buffers and pipelines on one device; {@link plan} each frame, then the rounds. */
export class GpuCulling {
  private readonly uniforms: any;
  private entries: any = null;
  private entryCapacity = 0;
  private flags: any = null;
  private flagCapacity = 0;
  /** Both rounds' indirect arguments: the frustum's batches, then the occlusion's. */
  args: any = null;
  private argCapacity = 0;
  private readonly testPipeline: any;
  private readonly compactPipeline: any;
  private readonly firstPipeline: any;
  private readonly downPipeline: any;
  private readonly cullLayout: any;
  private readonly firstLayout: any;
  private readonly downLayout: any;
  private hiz: { texture: any; width: number; height: number; levels: number; views: any[] } | null = null;
  private blank: any = null;
  private frame: { batches: number; copies: number; region: number; planes: Float32Array; viewProj: ArrayLike<number> } | null = null;

  constructor(private readonly device: any) {
    this.uniforms = device.createBuffer({ size: UNIFORM_STRIDE * 2, usage: UNIFORM | COPY_DST });
    const storage = (binding: number, type: string) => ({ binding, visibility: COMPUTE, buffer: { type } });
    this.cullLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: COMPUTE, buffer: { type: "uniform" } },
        storage(1, "read-only-storage"),
        storage(2, "storage"),
        storage(3, "storage"),
        storage(4, "storage"),
        { binding: 5, visibility: COMPUTE, texture: { sampleType: "unfilterable-float" } },
      ],
    });
    this.firstLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: COMPUTE, texture: { sampleType: "depth" } },
        { binding: 1, visibility: COMPUTE, storageTexture: { access: "write-only", format: "r32float" } },
      ],
    });
    this.downLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: COMPUTE, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: COMPUTE, storageTexture: { access: "write-only", format: "r32float" } },
      ],
    });
    const cull = device.createShaderModule({ code: CULL_WGSL });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.cullLayout] });
    this.testPipeline = device.createComputePipeline({ layout, compute: { module: cull, entryPoint: "test" } });
    this.compactPipeline = device.createComputePipeline({ layout, compute: { module: cull, entryPoint: "compact" } });
    this.firstPipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [this.firstLayout] }), compute: { module: device.createShaderModule({ code: HIZ_MAX_WGSL }), entryPoint: "first" } });
    this.downPipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [this.downLayout] }), compute: { module: device.createShaderModule({ code: HIZ_DOWN_WGSL }), entryPoint: "down" } });
  }

  /**
   * The frame's batches and camera. The instance buffer holds `copies`
   * records from 0 and their motion records from `copies`; both rounds pack
   * theirs from `region` (each batch at its own first copy), the motion
   * records `copies` on, so the instance buffer needs `region + 2 × copies`.
   * The second round packs over the first's once the prepass has drawn it.
   */
  plan(batches: readonly CullBatch[], copies: number, region: number, viewProj: ArrayLike<number>): void {
    if (batches.length > this.entryCapacity) {
      this.entries?.destroy();
      this.entryCapacity = Math.max(batches.length, this.entryCapacity * 2, 16);
      this.entries = this.device.createBuffer({ size: this.entryCapacity * ENTRY_BYTES, usage: STORAGE | COPY_DST });
    }
    if (copies > this.flagCapacity) {
      this.flags?.destroy();
      this.flagCapacity = Math.max(copies, this.flagCapacity * 2, 64);
      this.flags = this.device.createBuffer({ size: this.flagCapacity * 4, usage: STORAGE | COPY_SRC });
    }
    if (batches.length * 2 > this.argCapacity) {
      this.args?.destroy();
      this.argCapacity = Math.max(batches.length * 2, this.argCapacity * 2, 32);
      this.args = this.device.createBuffer({ size: this.argCapacity * INDIRECT_WORDS * 4, usage: STORAGE | INDIRECT | COPY_DST | COPY_SRC });
    }
    const data = new ArrayBuffer(Math.max(1, batches.length) * ENTRY_BYTES);
    const u = new Uint32Array(data);
    const f = new Float32Array(data);
    batches.forEach((b, k) => {
      u.set([b.first, b.count, b.sphere ? 1 : 0, b.indexCount], k * 8);
      if (b.sphere) f.set(b.sphere, k * 8 + 4);
    });
    this.device.queue.writeBuffer(this.entries, 0, data);
    this.frame = { batches: batches.length, copies, region, planes: frustumPlanesOf(viewProj), viewProj };
  }

  /** Where a batch's arguments sit for a round (0: the frustum's, 1: the occlusion's), in bytes. */
  argsOffset(round: 0 | 1, batch: number): number {
    return (round * (this.frame?.batches ?? 0) + batch) * INDIRECT_WORDS * 4;
  }

  private writeUniforms(round: 0 | 1, size: [number, number], levels: number, occlusion: boolean): void {
    const f = this.frame!;
    const data = new ArrayBuffer(UNIFORM_BYTES);
    const floats = new Float32Array(data);
    floats.set(f.planes, 0);
    floats.set(Array.from({ length: 16 }, (_, i) => f.viewProj[i]!), 24);
    floats.set([size[0], size[1], levels, occlusion ? 1 : 0], 40);
    new Uint32Array(data).set([f.batches, f.copies, f.region, round], 44);
    this.device.queue.writeBuffer(this.uniforms, round * UNIFORM_STRIDE, data);
  }

  private blankHiz(): any {
    this.blank ??= this.device.createTexture({ size: { width: 1, height: 1 }, format: "r32float", usage: TEXTURE_BINDING });
    return this.blank;
  }

  /** The pyramid for a depth of `width × height`. */
  private ensureHiz(width: number, height: number) {
    if (this.hiz && this.hiz.width === width && this.hiz.height === height) return this.hiz;
    this.hiz?.texture.destroy();
    const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
    const texture = this.device.createTexture({ size: { width, height }, format: "r32float", mipLevelCount: levels, usage: TEXTURE_BINDING | STORAGE_BINDING | 0x01 /* COPY_SRC, for reading it back */ });
    const views = Array.from({ length: levels }, (_, level) => texture.createView({ baseMipLevel: level, mipLevelCount: 1 }));
    this.hiz = { texture, width, height, levels, views };
    return this.hiz;
  }

  private round(encoder: any, round: 0 | 1, instances: any, hiz: any, timing: Record<string, unknown> = {}): void {
    const f = this.frame!;
    if (f.batches === 0) return;
    const group = this.device.createBindGroup({
      layout: this.cullLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms, offset: round * UNIFORM_STRIDE, size: UNIFORM_BYTES } },
        { binding: 1, resource: { buffer: this.entries } },
        { binding: 2, resource: { buffer: instances } },
        { binding: 3, resource: { buffer: this.flags } },
        { binding: 4, resource: { buffer: this.args } },
        { binding: 5, resource: hiz },
      ],
    });
    const pass = encoder.beginComputePass(timing);
    pass.setBindGroup(0, group);
    if (f.copies > 0) {
      pass.setPipeline(this.testPipeline);
      pass.dispatchWorkgroups(Math.ceil(f.copies / WORKGROUP));
    }
    pass.setPipeline(this.compactPipeline);
    pass.dispatchWorkgroups(Math.min(f.batches, 65535), Math.ceil(f.batches / 65535));
    pass.end();
  }

  /** The first round: the frustum, into the region and the first arguments. */
  encodeFrustum(encoder: any, instances: any, timing?: Record<string, unknown>): void {
    this.writeUniforms(0, [1, 1], 1, false);
    this.round(encoder, 0, instances, this.blankHiz().createView(), timing);
  }

  /**
   * The second round: the pyramid of `depth` (single-sampled; null tests the
   * frustum alone), then the frustum's survivors against it, into the region
   * (over the first round's) and the second arguments.
   */
  encodeOcclusion(encoder: any, instances: any, depth: any | null, size: [number, number], timing?: Record<string, unknown>): void {
    let view = this.blankHiz().createView();
    let levels = 1;
    if (depth) {
      const hiz = this.ensureHiz(size[0], size[1]);
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.firstPipeline);
      pass.setBindGroup(0, this.device.createBindGroup({ layout: this.firstLayout, entries: [{ binding: 0, resource: depth.createView() }, { binding: 1, resource: hiz.views[0] }] }));
      pass.dispatchWorkgroups(Math.ceil(size[0] / 8), Math.ceil(size[1] / 8));
      pass.setPipeline(this.downPipeline);
      for (let level = 1; level < hiz.levels; level += 1) {
        const w = Math.max(1, size[0] >> level);
        const h = Math.max(1, size[1] >> level);
        pass.setBindGroup(0, this.device.createBindGroup({ layout: this.downLayout, entries: [{ binding: 0, resource: hiz.views[level - 1] }, { binding: 1, resource: hiz.views[level] }] }));
        pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      }
      pass.end();
      view = hiz.texture.createView();
      levels = hiz.levels;
    }
    this.writeUniforms(1, size, levels, depth !== null);
    this.round(encoder, 1, instances, view, timing);
  }

  destroy(): void {
    for (const b of [this.uniforms, this.entries, this.flags, this.args]) b?.destroy();
    this.hiz?.texture.destroy();
    this.blank?.destroy();
  }
}
