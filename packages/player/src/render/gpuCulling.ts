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
 * - **Levels of detail.** A batch whose copies share a LOD chain is drawn
 *   once per level, every level sharing the copies' instance records; each
 *   keeps the copies its distance picks (as lod.ts does, measured to the
 *   copy's origin in the mesh's units), so the CPU doesn't choose levels.
 * - **What it leaves alone.** Batches whose vertices move on the GPU or in a
 *   graph (live skinning, cloth, a world-position offset), and see-through
 *   batches (drawn in order, farthest first), are copied whole.
 */

import type { MeshPrimitive } from "@cartbox/editor";

import { INSTANCE_FLOATS } from "./scenePacking.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- WebGPU handles aren't typed in this build */

/** Bytes of one source (first, count, eligible, then its local sphere) and of one draw's entry (see the WGSL's). */
const SOURCE_BYTES = 32;
const ENTRY_BYTES = 64;
/** How far either side of a LOD switch, as a share of its distance, a copy crossfades between the levels (F6b). */
export const CROSSFADE = 0.1;
/** The most cascades the caster cull handles (the sun's, CASCADE_COUNT in cascades.ts). */
export const MAX_CASTER_CASCADES = 4;
/** One batch's `drawIndexedIndirect` arguments, in u32s. */
export const INDIRECT_WORDS = 5;
const UNIFORM_BYTES = 6 * 16 + 64 + 64;
/** The rounds: the prepass's, the two-phase cull's second prepass, the shading's. */
const ROUNDS = 3;
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
/** A run of copies with their instance records (a batch, and every LOD sibling sharing it). */
struct Source { first: u32, count: u32, eligible: u32, pad: u32, sphere: vec4<f32> };
/** A draw: its copies (a source's), where it packs the ones it keeps, and, with a LOD chain, the level it draws and the switch distances. */
struct Entry { src: u32, count: u32, dst: u32, indexCount: u32, level: i32, levels: u32, switches: u32, pad: u32, d0: vec4<f32>, d1: vec4<f32> };
struct Cull {
  planes: array<vec4<f32>, 6>,
  viewProj: mat4x4<f32>,
  size: vec4<f32>,     // x, y = the depth's size; z = the pyramid's levels; w = 1 to test against it
  counts: vec4<u32>,   // x = draws, y = copies, z = where the region starts, w = which round (0, 1)
  more: vec4<u32>,     // x = sources, y = the region's copies (its motion records follow them), z = 1 for the two-phase cull
  eye: vec4<f32>,
};
@group(0) @binding(0) var<uniform> cull: Cull;
@group(0) @binding(1) var<storage, read> sources: array<Source>;
@group(0) @binding(2) var<storage, read_write> xf: array<f32>;
@group(0) @binding(3) var<storage, read_write> flags: array<u32>;
@group(0) @binding(4) var<storage, read_write> args: array<u32>;
@group(0) @binding(5) var hiz: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> entries: array<Entry>;
// Which copies the last frame's shading drew (the two-phase cull's first guess).
@group(0) @binding(7) var<storage, read_write> last: array<u32>;

const RECORD = ${INSTANCE_FLOATS}u;

/** The source a copy belongs to (sources are in order of their first copy). */
fn owner(i: u32) -> u32 {
  var lo = 0u;
  var hi = cull.more.x;
  loop {
    if (hi - lo <= 1u) { break; }
    let mid = (lo + hi) / 2u;
    if (sources[mid].first <= i) { lo = mid; } else { hi = mid; }
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

fn modelOf(i: u32) -> mat4x4<f32> {
  let b = i * RECORD + 32u;
  return mat4x4<f32>(
    vec4<f32>(xf[b], xf[b + 1u], xf[b + 2u], xf[b + 3u]),
    vec4<f32>(xf[b + 4u], xf[b + 5u], xf[b + 6u], xf[b + 7u]),
    vec4<f32>(xf[b + 8u], xf[b + 9u], xf[b + 10u], xf[b + 11u]),
    vec4<f32>(xf[b + 12u], xf[b + 13u], xf[b + 14u], xf[b + 15u]),
  );
}

fn scaleOf(m: mat4x4<f32>) -> f32 {
  return max(length(m[0].xyz), max(length(m[1].xyz), length(m[2].xyz)));
}

@compute @workgroup_size(${WORKGROUP})
fn test(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= cull.counts.y) { return; }
  let s = sources[owner(i)];
  var seen = 1u;
  if (s.eligible != 0u) {
    let model = modelOf(i);
    let c = (model * vec4<f32>(s.sphere.xyz, 1.0)).xyz;
    let r = s.sphere.w * scaleOf(model);
    for (var p = 0u; p < 6u; p = p + 1u) {
      let plane = cull.planes[p];
      if (dot(plane.xyz, c) + plane.w < -r) { seen = 0u; }
    }
    if (seen == 1u && cull.size.w > 0.5 && hidden(c, r)) { seen = 0u; }
  }
  // The two-phase cull: the prepass first draws what the last frame showed (round 0), then what a pyramid of that
  // can't rule out among the rest (round 1); the shading's round (2) tests the whole prepass, and is next frame's guess.
  // A batch drawn whole is drawn by the first round alone.
  if (cull.more.z != 0u) {
    let round = cull.counts.w;
    if (round == 0u) {
      if (s.eligible != 0u && last[i] == 0u) { seen = 0u; }
    } else if (round == 1u) {
      if (s.eligible == 0u || last[i] != 0u) { seen = 0u; }
    } else {
      last[i] = seen;
    }
  }
  flags[i] = seen;
}

/**
 * Whether a copy draws in this draw's level (x, 1 or 0) and its crossfade there
 * (y; F6b): the level its distance picks (as lod.ts's selectLodIndex, clamped
 * to the chain, its distance in the mesh's units), except within
 * ${CROSSFADE * 100}% of a switch, where both levels draw it, dithered: the
 * coarser coming in (y > 0) as the finer goes out (y < 0), each pixel once.
 */
fn levelKeep(e: Entry, i: u32) -> vec2<f32> {
  let m = modelOf(i);
  let d = length(m[3].xyz - cull.eye.xyz) / max(scaleOf(m), 1e-12);
  var k = 0u;
  for (var j = 0u; j < e.switches; j = j + 1u) {
    let at = select(e.d1[max(j, 4u) - 4u], e.d0[min(j, 3u)], j < 4u);
    let lo = at * ${1 - CROSSFADE};
    let hi = at * ${1 + CROSSFADE};
    if (d > lo && d < hi && j + 1u < e.levels) {
      let t = clamp((d - lo) / (hi - lo), 1e-4, 1.0 - 1e-4);
      if (e.level == i32(j)) { return vec2<f32>(1.0, -t); }
      if (e.level == i32(j + 1u)) { return vec2<f32>(1.0, t); }
      return vec2<f32>(0.0);
    }
    if (d >= at) { k = j + 1u; }
  }
  return vec2<f32>(select(0.0, 1.0, i32(min(k, e.levels - 1u)) == e.level), 0.0);
}

var<workgroup> scan: array<u32, ${WORKGROUP}>;

/** One draw a workgroup: its kept copies' records (and their motion records) packed at its place in the region, in order. */
@compute @workgroup_size(${WORKGROUP})
fn compact(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let index = group.x + group.y * 65535u;
  if (index >= cull.counts.x) { return; }
  let e = entries[index];
  let n = cull.counts.y;
  let total = cull.more.y;
  let region = cull.counts.z;
  var kept = 0u;
  for (var start = 0u; start < e.count; start = start + ${WORKGROUP}u) {
    let j = start + local.x;
    var seen = 0u;
    var fade = 0.0;
    if (j < e.count) {
      seen = flags[e.src + j];
      if (seen == 1u && e.level >= 0) {
        let keep = levelKeep(e, e.src + j);
        if (keep.x == 0.0) { seen = 0u; }
        fade = keep.y;
      }
    }
    scan[local.x] = seen;
    workgroupBarrier();
    for (var step = 1u; step < ${WORKGROUP}u; step = step * 2u) {
      let add = select(0u, scan[local.x - step], local.x >= step);
      workgroupBarrier();
      scan[local.x] = scan[local.x] + add;
      workgroupBarrier();
    }
    if (seen == 1u) {
      let to = region + e.dst + kept + scan[local.x] - 1u;
      let src = e.src + j;
      for (var f = 0u; f < RECORD; f = f + 1u) {
        xf[to * RECORD + f] = xf[src * RECORD + f];
        xf[(to + total) * RECORD + f] = xf[(src + n) * RECORD + f];
      }
      // Its crossfade (F6b) where the shader finds it: the model's first column's w (0 in an affine model).
      if (e.level >= 0) { xf[to * RECORD + 35u] = fade; }
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

/** The pyramid's first level from an anti-aliased frame's depths: each texel the farthest of its pixel's samples. */
export const HIZ_MAX_MS_WGSL = /* wgsl */ `
@group(0) @binding(0) var depth: texture_depth_multisampled_2d;
@group(0) @binding(1) var level0: texture_storage_2d<r32float, write>;
@compute @workgroup_size(8, 8)
fn first(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(depth);
  if (id.x >= size.x || id.y >= size.y) { return; }
  var z = 0.0;
  for (var s = 0u; s < textureNumSamples(depth); s = s + 1u) { z = max(z, textureLoad(depth, vec2<i32>(id.xy), i32(s))); }
  textureStore(level0, vec2<i32>(id.xy), vec4<f32>(z, 0.0, 0.0, 1.0));
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
    let flex = 0;
    if (primitive.sway)
      for (const v of primitive.sway) {
        if (v >= 0) sway = Math.max(sway, v);
        else flex = Math.max(flex, -v);
      }
    // A plant drawn a copy at a time (F6b) stores its flexibility, negated: the shader's trunk bend (at most a quarter
    // of the height per unit of flex), branch sway (an eighth of the reach) and flutter, at up to twice its size.
    if (flex > 0) sway = Math.max(sway, 2 * flex * (0.25 * hi[1]! + 0.13 * Math.max(Math.abs(lo[0]!), Math.abs(hi[0]!), Math.abs(lo[2]!), Math.abs(hi[2]!)) + 0.02));
    s = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2, Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2, sway];
  }
  spheres.set(primitive, s);
  return s;
}

/** A run of copies and their instance records: a batch, shared by its LOD siblings. */
export interface CullSource {
  readonly first: number;
  readonly count: number;
  /** Null: every copy is seen (its vertices move, or it's see-through). */
  readonly sphere: readonly [number, number, number, number] | null;
}

/** One draw, as the cull sees it. */
export interface CullBatch {
  /** Its source's first copy. */
  readonly first: number;
  readonly count: number;
  readonly indexCount: number;
  /** Where its kept copies go, from the region's start. */
  readonly dst: number;
  /** The LOD level it draws and its chain's switch distances (in the mesh's units), or null to keep every seen copy. */
  readonly lod: { readonly level: number; readonly levels: number; readonly distances: readonly number[] } | null;
}

/** The most switch distances a chain may have on the GPU. */
export const MAX_LOD_SWITCHES = 8;


/** The culling's buffers and pipelines on one device; {@link plan} each frame, then the rounds. */
export class GpuCulling {
  private readonly uniforms: any;
  private sources: any = null;
  private sourceCapacity = 0;
  private entries: any = null;
  private entryCapacity = 0;
  private flags: any = null;
  private flagCapacity = 0;
  private last: any = null;
  private lastCapacity = 0;
  /** Every round's indirect arguments: the frustum's draws (the prepass), the two-phase cull's second prepass, then the shading's. */
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
  private frame: { batches: number; sources: number; copies: number; region: number; total: number; planes: Float32Array; viewProj: ArrayLike<number>; eye: readonly number[]; twoPhase: boolean } | null = null;

  constructor(private readonly device: any) {
    this.uniforms = device.createBuffer({ size: UNIFORM_STRIDE * ROUNDS, usage: UNIFORM | COPY_DST });
    const storage = (binding: number, type: string) => ({ binding, visibility: COMPUTE, buffer: { type } });
    this.cullLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: COMPUTE, buffer: { type: "uniform" } },
        storage(1, "read-only-storage"),
        storage(2, "storage"),
        storage(3, "storage"),
        storage(4, "storage"),
        { binding: 5, visibility: COMPUTE, texture: { sampleType: "unfilterable-float" } },
        storage(6, "read-only-storage"),
        storage(7, "storage"),
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
   * The frame's sources (in order of their first copy), draws and camera. The
   * instance buffer holds `copies` records from 0 and their motion records
   * from `copies`; both rounds pack each draw's kept copies at
   * `region + dst`, their motion records `total` on (the draws' copies
   * counted together), so the instance buffer needs `region + 2 × total`.
   * The second round packs over the first's once the prepass has drawn it.
   */
  plan(sources: readonly CullSource[], batches: readonly CullBatch[], copies: number, region: number, total: number, viewProj: ArrayLike<number>, eye: readonly number[], twoPhase = false): void {
    const grow = (buffer: any, capacity: number, need: number, bytes: number, usage: number): [any, number] => {
      if (need <= capacity && buffer) return [buffer, capacity];
      buffer?.destroy();
      const next = Math.max(need, capacity * 2, 16);
      return [this.device.createBuffer({ size: next * bytes, usage }), next];
    };
    [this.sources, this.sourceCapacity] = grow(this.sources, this.sourceCapacity, sources.length, SOURCE_BYTES, STORAGE | COPY_DST);
    [this.entries, this.entryCapacity] = grow(this.entries, this.entryCapacity, batches.length, ENTRY_BYTES, STORAGE | COPY_DST);
    [this.flags, this.flagCapacity] = grow(this.flags, this.flagCapacity, Math.max(copies, 64), 4, STORAGE | COPY_SRC);
    [this.args, this.argCapacity] = grow(this.args, this.argCapacity, Math.max(batches.length * ROUNDS, 32), INDIRECT_WORDS * 4, STORAGE | INDIRECT | COPY_DST | COPY_SRC);
    // Last frame's guess holds while the copies do; a new buffer guesses nothing (and the second round draws it all).
    if (!this.last || copies > this.lastCapacity) {
      this.last?.destroy();
      this.lastCapacity = Math.max(copies, this.lastCapacity * 2, 64);
      this.last = this.device.createBuffer({ size: this.lastCapacity * 4, usage: STORAGE });
    }
    const s = new ArrayBuffer(Math.max(1, sources.length) * SOURCE_BYTES);
    const su = new Uint32Array(s);
    const sf = new Float32Array(s);
    sources.forEach((b, k) => {
      su.set([b.first, b.count, b.sphere ? 1 : 0, 0], k * 8);
      if (b.sphere) sf.set(b.sphere, k * 8 + 4);
    });
    this.device.queue.writeBuffer(this.sources, 0, s);
    const e = new ArrayBuffer(Math.max(1, batches.length) * ENTRY_BYTES);
    const eu = new Uint32Array(e);
    const ei = new Int32Array(e);
    const ef = new Float32Array(e);
    batches.forEach((b, k) => {
      const o = k * (ENTRY_BYTES / 4);
      eu.set([b.first, b.count, b.dst, b.indexCount], o);
      const switches = b.lod ? Math.min(MAX_LOD_SWITCHES, b.lod.distances.length) : 0;
      ei[o + 4] = b.lod ? b.lod.level : -1;
      eu.set([b.lod ? b.lod.levels : 1, switches, 0], o + 5);
      if (b.lod) ef.set(b.lod.distances.slice(0, switches), o + 8);
    });
    this.device.queue.writeBuffer(this.entries, 0, e);
    this.frame = { batches: batches.length, sources: sources.length, copies, region, total, planes: frustumPlanesOf(viewProj), viewProj, eye, twoPhase };
  }

  /** Where a draw's arguments sit for a round (0: the prepass's, 1: the two-phase cull's second prepass, 2: the shading's), in bytes. */
  argsOffset(round: 0 | 1 | 2, batch: number): number {
    return (round * (this.frame?.batches ?? 0) + batch) * INDIRECT_WORDS * 4;
  }

  private writeUniforms(round: 0 | 1 | 2, size: [number, number], levels: number, occlusion: boolean): void {
    const f = this.frame!;
    const data = new ArrayBuffer(UNIFORM_BYTES);
    const floats = new Float32Array(data);
    const words = new Uint32Array(data);
    floats.set(f.planes, 0);
    floats.set(Array.from({ length: 16 }, (_, i) => f.viewProj[i]!), 24);
    floats.set([size[0], size[1], levels, occlusion ? 1 : 0], 40);
    words.set([f.batches, f.copies, f.region, round], 44);
    words.set([f.sources, f.total, f.twoPhase ? 1 : 0, 0], 48);
    floats.set([f.eye[0]!, f.eye[1]!, f.eye[2]!, 0], 52);
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

  private round(encoder: any, round: 0 | 1 | 2, instances: any, hiz: any, timing: Record<string, unknown> = {}): void {
    const f = this.frame!;
    if (f.batches === 0) return;
    const group = this.device.createBindGroup({
      layout: this.cullLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms, offset: round * UNIFORM_STRIDE, size: UNIFORM_BYTES } },
        { binding: 1, resource: { buffer: this.sources } },
        { binding: 2, resource: { buffer: instances } },
        { binding: 3, resource: { buffer: this.flags } },
        { binding: 4, resource: { buffer: this.args } },
        { binding: 5, resource: hiz },
        { binding: 6, resource: { buffer: this.entries } },
        { binding: 7, resource: { buffer: this.last } },
      ],
    });
    const pass = encoder.beginComputePass(timing);
    pass.setBindGroup(0, group);
    if (f.copies > 0 && f.sources > 0) {
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

  private msFirst: [any, any] | null = null;

  /** The first level's pipeline (and its layout) for multisampled depths, made on first use. */
  private multisampledFirst(): [any, any] {
    if (!this.msFirst) {
      const layout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: COMPUTE, texture: { sampleType: "depth", multisampled: true } },
          { binding: 1, visibility: COMPUTE, storageTexture: { access: "write-only", format: "r32float" } },
        ],
      });
      const pipeline = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: this.device.createShaderModule({ code: HIZ_MAX_MS_WGSL }), entryPoint: "first" },
      });
      this.msFirst = [pipeline, layout];
    }
    return this.msFirst;
  }

  /** The pyramid the shading's round last built (for the cluster pass, F6a), or null. */
  pyramid: { view: any; levels: number } | null = null;

  /** Whether this frame culls in two phases (see {@link plan}). */
  get twoPhase(): boolean {
    return this.frame?.twoPhase ?? false;
  }

  /** The two-phase cull's second round: a pyramid of the first prepass's `depth`, and the copies last frame didn't show tested against it. */
  encodeSecond(encoder: any, instances: any, depth: any, size: [number, number], timing?: Record<string, unknown>): void {
    const levels = this.encodePyramid(encoder, depth, size);
    this.writeUniforms(1, size, levels, true);
    this.round(encoder, 1, instances, this.hiz!.texture.createView(), timing);
  }

  /**
   * The shading's round: the pyramid of `depth` (single-sampled; null tests
   * the frustum alone), then the frustum's survivors against it, into the
   * region (over the prepass's) and the shading's arguments.
   */
  encodeOcclusion(encoder: any, instances: any, depth: any | null, size: [number, number], timing?: Record<string, unknown>, multisampled = false): void {
    const levels = depth ? this.encodePyramid(encoder, depth, size, multisampled) : 1;
    this.pyramid = depth ? { view: this.hiz!.texture.createView(), levels } : null;
    this.writeUniforms(2, size, levels, depth !== null);
    this.round(encoder, 2, instances, depth ? this.hiz!.texture.createView() : this.blankHiz().createView(), timing);
  }

  /** Build the pyramid of `depth` (an anti-aliased frame's: the farthest of each pixel's samples); its levels. */
  private encodePyramid(encoder: any, depth: any, size: [number, number], multisampled = false): number {
    const hiz = this.ensureHiz(size[0], size[1]);
    const pass = encoder.beginComputePass();
    const [first, layout] = multisampled ? this.multisampledFirst() : [this.firstPipeline, this.firstLayout];
    pass.setPipeline(first);
    pass.setBindGroup(0, this.device.createBindGroup({ layout, entries: [{ binding: 0, resource: depth.createView() }, { binding: 1, resource: hiz.views[0] }] }));
    pass.dispatchWorkgroups(Math.ceil(size[0] / 8), Math.ceil(size[1] / 8));
    pass.setPipeline(this.downPipeline);
    for (let level = 1; level < hiz.levels; level += 1) {
      const w = Math.max(1, size[0] >> level);
      const h = Math.max(1, size[1] >> level);
      pass.setBindGroup(0, this.device.createBindGroup({ layout: this.downLayout, entries: [{ binding: 0, resource: hiz.views[level - 1] }, { binding: 1, resource: hiz.views[level] }] }));
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    }
    pass.end();
    return hiz.levels;
  }

  destroy(): void {
    for (const b of [this.uniforms, this.entries, this.flags, this.args, this.last, this.sources]) b?.destroy();
    this.hiz?.texture.destroy();
    this.blank?.destroy();
  }
}

/**
 * The shadow casters culled for each of the sun's cascades (F0e): a copy is
 * drawn into a cascade only when its sphere reaches the cascade's box. The
 * box's near plane (toward the sun) is left out, since what stands between the
 * sun and the box still shadows it. A workgroup per caster batch and cascade
 * packs the survivors' models, in order, into the cascade's region (at the
 * batch's place in it), and writes that draw's indirect arguments.
 */
export const CASTER_CULL_WGSL = /* wgsl */ `
struct Entry { first: u32, count: u32, dst: u32, indexCount: u32, sphere: vec4<f32>, eligible: vec4<u32> };
struct Cull {
  planes: array<vec4<f32>, ${MAX_CASTER_CASCADES * 6}>,
  counts: vec4<u32>,   // x = batches, y = cascades, z = where the regions start, w = each region's copies
};
@group(0) @binding(0) var<uniform> cull: Cull;
@group(0) @binding(1) var<storage, read> entries: array<Entry>;
@group(0) @binding(2) var<storage, read_write> xf: array<f32>;
@group(0) @binding(3) var<storage, read_write> args: array<u32>;

const RECORD = ${INSTANCE_FLOATS}u;

fn seen(e: Entry, cascade: u32, i: u32) -> bool {
  if (e.eligible.x == 0u) { return true; }
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
    if (p == 4u) { continue; } // the near plane, toward the sun
    let plane = cull.planes[cascade * 6u + p];
    if (dot(plane.xyz, c) + plane.w < -r) { return false; }
  }
  return true;
}

var<workgroup> scan: array<u32, ${WORKGROUP}>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_id) local: vec3<u32>) {
  let index = group.x;
  let cascade = group.y;
  if (index >= cull.counts.x || cascade >= cull.counts.y) { return; }
  let e = entries[index];
  let region = cull.counts.z + cascade * cull.counts.w + e.dst;
  var kept = 0u;
  for (var start = 0u; start < e.count; start = start + ${WORKGROUP}u) {
    let j = start + local.x;
    var keep = 0u;
    if (j < e.count && seen(e, cascade, e.first + j)) { keep = 1u; }
    scan[local.x] = keep;
    workgroupBarrier();
    for (var step = 1u; step < ${WORKGROUP}u; step = step * 2u) {
      var add = 0u;
      if (local.x >= step) { add = scan[local.x - step]; }
      workgroupBarrier();
      scan[local.x] = scan[local.x] + add;
      workgroupBarrier();
    }
    if (keep == 1u) {
      // A caster reads only its model.
      let to = (region + kept + scan[local.x] - 1u) * RECORD + 32u;
      let src = (e.first + j) * RECORD + 32u;
      for (var f = 0u; f < 16u; f = f + 1u) { xf[to + f] = xf[src + f]; }
    }
    kept = kept + workgroupUniformLoad(&scan[${WORKGROUP - 1}u]);
  }
  if (local.x == 0u) {
    let a = (cascade * cull.counts.x + index) * ${INDIRECT_WORDS}u;
    args[a] = e.indexCount;
    args[a + 1u] = kept;
    args[a + 2u] = 0u;
    args[a + 3u] = 0u;
    args[a + 4u] = 0u;
  }
}
`;

/** One caster batch, as the caster cull sees it. */
export interface CasterBatch {
  /** Its first copy in the instance buffer. */
  readonly first: number;
  readonly count: number;
  /** Where its kept copies go in each cascade's region. */
  readonly dst: number;
  readonly indexCount: number;
  /** Its local sphere (widened by the wind), or null to keep every copy (its vertices move). */
  readonly sphere: readonly [number, number, number, number] | null;
}

/** The caster cull's buffers and pipeline on one device: {@link plan} each frame, then {@link encode}. */
export class CasterCulling {
  private readonly uniforms: any;
  private entries: any = null;
  private entryCapacity = 0;
  /** Every cascade's arguments, cascade by cascade, a caster batch each. */
  args: any = null;
  private argCapacity = 0;
  private readonly pipeline: any;
  private readonly layout: any;
  private frame: { batches: number; cascades: number } | null = null;

  constructor(private readonly device: any) {
    this.uniforms = device.createBuffer({ size: MAX_CASTER_CASCADES * 6 * 16 + 16, usage: UNIFORM | COPY_DST });
    const storage = (binding: number, type: string) => ({ binding, visibility: COMPUTE, buffer: { type } });
    this.layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: COMPUTE, buffer: { type: "uniform" } }, storage(1, "read-only-storage"), storage(2, "storage"), storage(3, "storage")] });
    this.pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: device.createShaderModule({ code: CASTER_CULL_WGSL }), entryPoint: "main" },
    });
  }

  /** The frame's caster batches and the cascades' view-projections; each cascade's region holds `regionCopies` from `region` on. */
  plan(batches: readonly CasterBatch[], cascades: readonly ArrayLike<number>[], region: number, regionCopies: number): void {
    const count = Math.min(cascades.length, MAX_CASTER_CASCADES);
    if (batches.length > this.entryCapacity) {
      this.entries?.destroy();
      this.entryCapacity = Math.max(batches.length, this.entryCapacity * 2, 16);
      this.entries = this.device.createBuffer({ size: this.entryCapacity * 48, usage: STORAGE | COPY_DST });
    }
    if (batches.length * count > this.argCapacity || !this.args) {
      this.args?.destroy();
      this.argCapacity = Math.max(batches.length * count, this.argCapacity * 2, 16);
      this.args = this.device.createBuffer({ size: this.argCapacity * INDIRECT_WORDS * 4, usage: STORAGE | INDIRECT | COPY_SRC });
    }
    const e = new ArrayBuffer(Math.max(1, batches.length) * 48);
    const eu = new Uint32Array(e);
    const ef = new Float32Array(e);
    batches.forEach((b, k) => {
      eu.set([b.first, b.count, b.dst, b.indexCount], k * 12);
      if (b.sphere) ef.set(b.sphere, k * 12 + 4);
      eu[k * 12 + 8] = b.sphere ? 1 : 0;
    });
    this.device.queue.writeBuffer(this.entries, 0, e);
    const u = new ArrayBuffer(MAX_CASTER_CASCADES * 6 * 16 + 16);
    const uf = new Float32Array(u);
    for (let c = 0; c < count; c += 1) uf.set(frustumPlanesOf(cascades[c]!), c * 24);
    new Uint32Array(u).set([batches.length, count, region, regionCopies], MAX_CASTER_CASCADES * 24);
    this.device.queue.writeBuffer(this.uniforms, 0, u);
    this.frame = { batches: batches.length, cascades: count };
  }

  /** Where a caster batch's arguments sit for a cascade, in bytes. */
  argsOffset(cascade: number, batch: number): number {
    return (cascade * (this.frame?.batches ?? 0) + batch) * INDIRECT_WORDS * 4;
  }

  encode(encoder: any, instances: any, timing: Record<string, unknown> = {}): void {
    const f = this.frame;
    if (!f || f.batches === 0 || f.cascades === 0) return;
    const pass = encoder.beginComputePass(timing);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: { buffer: this.entries } },
        { binding: 2, resource: { buffer: instances } },
        { binding: 3, resource: { buffer: this.args } },
      ],
    }));
    pass.dispatchWorkgroups(f.batches, f.cascades);
    pass.end();
  }

  destroy(): void {
    for (const b of [this.uniforms, this.entries, this.args]) b?.destroy();
  }
}
