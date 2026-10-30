/**
 * Cluster rendering (AAA_FIDELITY_ROADMAP.md F6a): a dense mesh's cluster
 * hierarchy (clusterLod.ts in @cartbox/editor) cut and culled on the GPU each
 * frame, so the CPU never chooses its detail or its visible parts.
 *
 * Each clustered copy is a job. A compute pass, a workgroup per cluster:
 *
 * - **The cut.** The cluster's error and its parent's, seen from the eye
 *   through the copy's model (errors and spheres scaled by its largest
 *   scale), against a pixel's worth: drawn when its own can't be seen and its
 *   parent's can (`clusterVisible`).
 * - **The frustum and the cone.** Its sphere against the six planes, and its
 *   normals' cone: a cluster whose every triangle faces away is dropped, on a
 *   closed mesh only (the renderer draws both faces, and an open mesh's back
 *   faces can show).
 * - **Occlusion** in the second round, against the Hi-Z pyramid of the
 *   prepass (gpuCulling.ts): the shading draws only what the depths leave.
 * - **Drawn** by appending its triangles' indices to the job's region of an
 *   index buffer (a slot taken by adding to the draw's index count), which
 *   one indexed indirect draw then draws.
 *
 * The levels share the mesh's vertices, so the draw binds the primitive's
 * own vertex buffer. Each round's arguments are their own; the second round
 * writes over the first's indices once the prepass has drawn them.
 */

import { LOD_CLUSTER_FLOATS, packClusterLod, type ClusterLod } from "@cartbox/editor";

import { INSTANCE_FLOATS } from "./scenePacking.js";
import { INDIRECT_WORDS, frustumPlanesOf } from "./gpuCulling.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- WebGPU handles aren't typed in this build */

const STORAGE = 0x80;
const COPY_DST = 0x08;
const COPY_SRC = 0x04;
const INDEX = 0x10;
const INDIRECT = 0x100;
const UNIFORM = 0x40;
const COMPUTE = 0x4;
/** Threads a workgroup: one a triangle of a cluster. */
const THREADS = 128;
/** A job's uniforms, and each job and round's arguments, sit a storage-binding alignment apart. */
const JOB_STRIDE = 256;
const FRAME_BYTES = 6 * 16 + 64 + 16 * 3;

/** How far off a cluster's error may be seen, in pixels, before its finer one is drawn. */
export const CLUSTER_ERROR_PIXELS = 1;

export const CLUSTER_WGSL = /* wgsl */ `
struct Frame {
  planes: array<vec4<f32>, 6>,
  viewProj: mat4x4<f32>,
  eye: vec4<f32>,      // xyz; w = pixels a radian (the projection's y scale × half the height)
  size: vec4<f32>,     // x, y = the depth's size; z = the pyramid's levels; w = 1 to test against it
  error: vec4<f32>,    // x = the pixels an error may cover unseen
};
struct Job {
  record: u32,         // the copy's instance record
  clusters: u32,
  region: u32,         // where its indices go in the output (in indices)
  args: u32,           // its arguments' first word in the range bound (0: each job and round binds its own)
  twoSided: u32,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<uniform> job: Job;
@group(0) @binding(2) var<storage, read> clusters: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> source: array<u32>;
@group(0) @binding(4) var<storage, read> xf: array<f32>;
@group(0) @binding(5) var<storage, read_write> out: array<u32>;
@group(0) @binding(6) var<storage, read_write> args: array<atomic<u32>>;
@group(0) @binding(7) var hiz: texture_2d<f32>;

const RECORD = ${INSTANCE_FLOATS}u;
const FLOATS = ${LOD_CLUSTER_FLOATS / 4}u; // vec4s a cluster

fn projected(error: f32, centre: vec3<f32>, radius: f32) -> f32 {
  let d = max(length(centre - frame.eye.xyz) - radius, 1e-3);
  return error * frame.eye.w / d;
}

/** As gpuCulling's: the sphere's box on screen behind the pyramid's farthest depths there. */
fn hidden(c: vec3<f32>, r: f32) -> bool {
  var lo = vec2<f32>(1e9);
  var hi = vec2<f32>(-1e9);
  var nearest = 1.0;
  for (var k = 0u; k < 8u; k = k + 1u) {
    let corner = c + r * vec3<f32>(select(-1.0, 1.0, (k & 1u) != 0u), select(-1.0, 1.0, (k & 2u) != 0u), select(-1.0, 1.0, (k & 4u) != 0u));
    let clip = frame.viewProj * vec4<f32>(corner, 1.0);
    if (clip.w <= 1e-4) { return false; }
    let ndc = clip.xyz / clip.w;
    let px = vec2<f32>((ndc.x * 0.5 + 0.5) * frame.size.x, (0.5 - ndc.y * 0.5) * frame.size.y);
    lo = min(lo, px);
    hi = max(hi, px);
    nearest = min(nearest, ndc.z);
  }
  if (nearest <= 0.0) { return false; }
  lo = clamp(lo, vec2<f32>(0.0), frame.size.xy - 1.0);
  hi = clamp(hi, vec2<f32>(0.0), frame.size.xy - 1.0);
  let extent = max(hi.x - lo.x, hi.y - lo.y);
  let level = min(u32(ceil(log2(max(extent, 1.0)))), u32(frame.size.z) - 1u);
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

var<workgroup> base: u32;
var<workgroup> count: u32;
var<workgroup> first: u32;

@compute @workgroup_size(${THREADS})
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let index = group.x + group.y * 65535u;
  if (index >= job.clusters) { return; }
  if (local.x == 0u) {
    let at = index * FLOATS;
    let head = bitcast<vec4<u32>>(clusters[at]);
    let errors = clusters[at];
    let bounds = clusters[at + 1u];
    let cone = clusters[at + 2u];
    let own = clusters[at + 3u];
    let parent = clusters[at + 4u];
    let b = job.record * RECORD + 32u;
    let model = mat4x4<f32>(
      vec4<f32>(xf[b], xf[b + 1u], xf[b + 2u], xf[b + 3u]),
      vec4<f32>(xf[b + 4u], xf[b + 5u], xf[b + 6u], xf[b + 7u]),
      vec4<f32>(xf[b + 8u], xf[b + 9u], xf[b + 10u], xf[b + 11u]),
      vec4<f32>(xf[b + 12u], xf[b + 13u], xf[b + 14u], xf[b + 15u]),
    );
    let scale = max(length(model[0].xyz), max(length(model[1].xyz), length(model[2].xyz)));
    // The cut: its own error unseen, its parent's seen.
    var drawn = projected(errors.z * scale, (model * vec4<f32>(own.xyz, 1.0)).xyz, own.w * scale) <= frame.error.x
      && projected(errors.w * scale, (model * vec4<f32>(parent.xyz, 1.0)).xyz, parent.w * scale) > frame.error.x;
    // The frustum.
    let c = (model * vec4<f32>(bounds.xyz, 1.0)).xyz;
    let r = bounds.w * scale;
    for (var p = 0u; p < 6u; p = p + 1u) {
      let plane = frame.planes[p];
      if (dot(plane.xyz, c) + plane.w < -r) { drawn = false; }
    }
    // The cone: every normal facing away (a rotation and uniform scale keep the cone; a squash is let through).
    if (drawn && job.twoSided == 0u && cone.w > 0.0) {
      let axis = normalize((model * vec4<f32>(cone.xyz, 0.0)).xyz);
      let v = c - frame.eye.xyz;
      let d = length(v);
      if (d > r && dot(v, axis) >= sqrt(1.0 - cone.w * cone.w) * d + r) { drawn = false; }
    }
    if (drawn && frame.size.w > 0.5 && hidden(c, r)) { drawn = false; }
    var taken = 0u;
    if (drawn) { taken = atomicAdd(&args[job.args], head.y * 3u); }
    base = taken;
    count = select(0u, head.y, drawn);
    first = head.x;
  }
  workgroupBarrier();
  let n = workgroupUniformLoad(&count);
  if (local.x < n) {
    let to = job.region + base + local.x * 3u;
    let src = (first + local.x) * 3u;
    out[to] = source[src];
    out[to + 1u] = source[src + 1u];
    out[to + 2u] = source[src + 2u];
  }
}
`;

/** A clustered copy to draw this frame. */
export interface ClusterJob {
  /** Its instance record (the model the pass reads). */
  readonly record: number;
  readonly lod: ClusterLod;
  /** Both its faces can show (its mesh is open): no cone culling. */
  readonly twoSided: boolean;
}

/** One primitive's hierarchy on the GPU. */
interface Uploaded {
  readonly clusters: any;
  readonly source: any;
  readonly count: number;
  /** The most triangles a cut can hold: the mesh's own (every coarser group has fewer). */
  readonly maxTriangles: number;
}

/** The pass's buffers and pipeline on one device: {@link plan} each frame, then {@link encode} each round (0 for the prepass, 1 for the shading). */
export class ClusterRendering {
  private readonly uploaded = new WeakMap<ClusterLod, Uploaded>();
  private readonly frameUniforms: any;
  private jobUniforms: any = null;
  private jobCapacity = 0;
  /** The cut's indices: each job's region. */
  output: any = null;
  private outputCapacity = 0;
  /** Each job's arguments, round by round. */
  args: any = null;
  private argCapacity = 0;
  private readonly layout: any;
  private readonly pipeline: any;
  private blank: any = null;
  private jobs: { job: ClusterJob; gpu: Uploaded; region: number }[] = [];

  constructor(private readonly device: any) {
    this.frameUniforms = device.createBuffer({ size: JOB_STRIDE * 2, usage: UNIFORM | COPY_DST });
    const storage = (binding: number, type: string) => ({ binding, visibility: COMPUTE, buffer: { type } });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: COMPUTE, buffer: { type: "uniform" } },
        storage(2, "read-only-storage"),
        storage(3, "read-only-storage"),
        storage(4, "read-only-storage"),
        storage(5, "storage"),
        storage(6, "storage"),
        { binding: 7, visibility: COMPUTE, texture: { sampleType: "unfilterable-float" } },
      ],
    });
    this.pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ code: CLUSTER_WGSL }), entryPoint: "main" },
    });
  }

  private upload(lod: ClusterLod): Uploaded {
    let gpu = this.uploaded.get(lod);
    if (!gpu) {
      const packed = packClusterLod(lod);
      const clusters = this.device.createBuffer({ size: Math.max(16, packed.byteLength), usage: STORAGE | COPY_DST });
      this.device.queue.writeBuffer(clusters, 0, packed);
      const source = this.device.createBuffer({ size: Math.max(16, lod.indices.byteLength), usage: STORAGE | COPY_DST });
      this.device.queue.writeBuffer(source, 0, lod.indices);
      // The mesh's own triangles: level 0, the clusters with no error.
      const maxTriangles = lod.clusters.filter((c) => c.error === 0).reduce((n, c) => n + c.triangles, 0);
      gpu = { clusters, source, count: lod.clusters.length, maxTriangles };
      this.uploaded.set(lod, gpu);
    }
    return gpu;
  }

  /** The frame's jobs: each gets a region of the output (as many indices as its mesh's own triangles) and its rounds' arguments, reset. */
  plan(jobs: readonly ClusterJob[]): void {
    let at = 0;
    this.jobs = jobs.map((job) => {
      const gpu = this.upload(job.lod);
      const region = at;
      at += gpu.maxTriangles * 3;
      return { job, gpu, region };
    });
    if (at > this.outputCapacity || !this.output) {
      this.output?.destroy();
      this.outputCapacity = Math.max(at, this.outputCapacity * 2, 3 * 1024);
      this.output = this.device.createBuffer({ size: this.outputCapacity * 4, usage: INDEX | STORAGE });
    }
    if (jobs.length * 2 > this.argCapacity || !this.args) {
      this.args?.destroy();
      this.argCapacity = Math.max(jobs.length * 2, this.argCapacity * 2, 8);
      this.args = this.device.createBuffer({ size: this.argCapacity * JOB_STRIDE, usage: STORAGE | INDIRECT | COPY_DST | COPY_SRC });
    }
    if (jobs.length > this.jobCapacity || !this.jobUniforms) {
      this.jobUniforms?.destroy();
      this.jobCapacity = Math.max(jobs.length, this.jobCapacity * 2, 8);
      this.jobUniforms = this.device.createBuffer({ size: this.jobCapacity * JOB_STRIDE, usage: UNIFORM | COPY_DST });
    }
    if (jobs.length === 0) return;
    // Each round's arguments start empty: no indices yet, one instance.
    const args = new Uint32Array((jobs.length * 2 * JOB_STRIDE) / 4);
    for (let k = 0; k < jobs.length * 2; k += 1) args[(k * JOB_STRIDE) / 4 + 1] = 1;
    this.device.queue.writeBuffer(this.args, 0, args);
    const uniforms = new Uint32Array((jobs.length * JOB_STRIDE) / 4);
    this.jobs.forEach(({ job, gpu, region }, k) => uniforms.set([job.record, gpu.count, region, 0, job.twoSided ? 1 : 0], (k * JOB_STRIDE) / 4));
    this.device.queue.writeBuffer(this.jobUniforms, 0, uniforms);
  }

  /** Where a job's region starts in the output, in bytes. */
  regionOffset(job: number): number {
    return this.jobs[job]!.region * 4;
  }

  /** How many bytes a job's region holds. */
  regionBytes(job: number): number {
    return this.jobs[job]!.gpu.maxTriangles * 3 * 4;
  }

  /** Where a job's arguments sit for a round, in bytes. */
  argsOffset(job: number, round: 0 | 1): number {
    return (job * 2 + round) * JOB_STRIDE;
  }

  /**
   * Encode a round: the cut and culls for every job, round 0 (before the
   * prepass) against the frustum and cone, round 1 also against `hiz` (the
   * prepass's pyramid, `levels` deep; null tests no occlusion).
   */
  encode(encoder: any, round: 0 | 1, instances: any, view: { viewProj: ArrayLike<number>; eye: readonly number[]; pixelsPerRadian: number; size: [number, number] }, hiz: { view: any; levels: number } | null, timing: Record<string, unknown> = {}): void {
    if (this.jobs.length === 0) return;
    const data = new ArrayBuffer(FRAME_BYTES);
    const f = new Float32Array(data);
    f.set(frustumPlanesOf(view.viewProj), 0);
    f.set(Array.from({ length: 16 }, (_, i) => view.viewProj[i]!), 24);
    f.set([view.eye[0]!, view.eye[1]!, view.eye[2]!, view.pixelsPerRadian], 40);
    f.set([view.size[0], view.size[1], hiz ? hiz.levels : 1, hiz ? 1 : 0], 44);
    f.set([CLUSTER_ERROR_PIXELS, 0, 0, 0], 48);
    this.device.queue.writeBuffer(this.frameUniforms, round * JOB_STRIDE, data);
    this.blank ??= this.device.createTexture({ size: { width: 1, height: 1 }, format: "r32float", usage: 0x04 });
    const pyramid = hiz ? hiz.view : this.blank.createView();
    const pass = encoder.beginComputePass(timing);
    pass.setPipeline(this.pipeline);
    this.jobs.forEach(({ gpu }, k) => {
      // The arguments as this job's round: a binding offset per job keeps one shader for all.
      pass.setBindGroup(0, this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.frameUniforms, offset: round * JOB_STRIDE, size: FRAME_BYTES } },
          { binding: 1, resource: { buffer: this.jobUniforms, offset: k * JOB_STRIDE, size: 32 } },
          { binding: 2, resource: { buffer: gpu.clusters } },
          { binding: 3, resource: { buffer: gpu.source } },
          { binding: 4, resource: { buffer: instances } },
          { binding: 5, resource: { buffer: this.output } },
          { binding: 6, resource: { buffer: this.args, offset: this.argsOffset(k, round), size: INDIRECT_WORDS * 4 } },
          { binding: 7, resource: pyramid },
        ],
      }));
      pass.dispatchWorkgroups(Math.min(gpu.count, 65535), Math.ceil(gpu.count / 65535));
    });
    pass.end();
  }

  destroy(): void {
    for (const b of [this.frameUniforms, this.jobUniforms, this.output, this.args, this.blank]) b?.destroy();
  }
}
