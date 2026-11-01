/**
 * Clustered lights on the GPU (AAA_FIDELITY_ROADMAP.md F0e): the cells of
 * lightClusters.ts (EP8) built by compute passes from the frame's packed
 * light list, into the same table and index list the shaders read, so the
 * CPU no longer walks every light against every cell each frame.
 *
 * Three passes: each cell lists the lights touching it (its sphere against
 * the cell's box, as the CPU tests it, in light order, up to
 * {@link CLUSTER_MAX_PER_CELL}) into a scratch row of its own; one workgroup
 * turns the counts into each cell's start in the index list (held to
 * {@link CLUSTER_INDEX_CAP}, as the CPU does); and each cell copies its row
 * there. The sphere is widened a little more than the CPU's, so a float's
 * rounding can only add a light to a cell, never drop one.
 */

import { CLUSTER_CELLS, CLUSTER_INDEX_CAP, CLUSTER_MAX_PER_CELL, CLUSTER_X, CLUSTER_Y, type ClusterGrid, type Mat4 } from "@cartbox/editor";

import { LIGHT_FLOATS } from "./scenePacking.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- WebGPU handles aren't typed in this build */

const STORAGE = 0x80;
const COPY_DST = 0x08;
const UNIFORM = 0x40;
const SCAN = 256;

export const LIGHT_CLUSTER_WGSL = /* wgsl */ `
struct Grid {
  view: mat4x4<f32>,
  a: vec4<f32>,       // near, far, sx, sy
  b: vec4<f32>,       // tile width, tile height, slice scale, unused
  size: vec4<f32>,    // width, height
  lights: vec4<u32>,  // first clustered light, lights
};
@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<storage, read> lights: array<f32>;
@group(0) @binding(2) var<storage, read_write> rows: array<u32>;
@group(0) @binding(3) var<storage, read_write> counts: array<u32>;
@group(0) @binding(4) var<storage, read_write> data: array<u32>;

const CELLS = ${CLUSTER_CELLS}u;
const MAX = ${CLUSTER_MAX_PER_CELL}u;
const CAP = ${CLUSTER_INDEX_CAP}u;

fn ndcX(x: f32) -> f32 { return min(grid.size.x, x) / grid.size.x * 2.0 - 1.0; }
fn ndcY(y: f32) -> f32 { return 1.0 - min(grid.size.y, y) / grid.size.y * 2.0; }

@compute @workgroup_size(64)
fn list(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.x;
  if (cell >= CELLS) { return; }
  let tx = cell % ${CLUSTER_X}u;
  let ty = (cell / ${CLUSTER_X}u) % ${CLUSTER_Y}u;
  let k = cell / ${CLUSTER_X * CLUSTER_Y}u;
  let near = grid.a.x;
  let far = grid.a.y;
  let d0 = near * exp(f32(k) / grid.b.z);
  let d1 = near * exp(f32(k + 1u) / grid.b.z);
  let ya = ndcY(f32(ty) * grid.b.y);
  let yb = ndcY(f32(ty + 1u) * grid.b.y);
  let yMin = min(min(ya * d0, ya * d1), min(yb * d0, yb * d1)) / grid.a.w;
  let yMax = max(max(ya * d0, ya * d1), max(yb * d0, yb * d1)) / grid.a.w;
  let xa = ndcX(f32(tx) * grid.b.x);
  let xb = ndcX(f32(tx + 1u) * grid.b.x);
  let xMin = min(min(xa * d0, xa * d1), min(xb * d0, xb * d1)) / grid.a.z;
  let xMax = max(max(xa * d0, xa * d1), max(xb * d0, xb * d1)) / grid.a.z;
  var n = 0u;
  for (var li = grid.lights.x; li < grid.lights.y; li = li + 1u) {
    let b = li * ${LIGHT_FLOATS}u;
    let p = vec4<f32>(lights[b], lights[b + 1u], lights[b + 2u], 1.0);
    let v = grid.view * p;
    let cd = -v.z;
    let r = lights[b + 8u] * 1.002 + 2e-3;
    if (cd + r < near || cd - r > far) { continue; }
    let dd = select(select(0.0, cd - d1, cd > d1), d0 - cd, cd < d0);
    let dy = select(select(0.0, v.y - yMax, v.y > yMax), yMin - v.y, v.y < yMin);
    let dx = select(select(0.0, v.x - xMax, v.x > xMax), xMin - v.x, v.x < xMin);
    if (dx * dx + dy * dy + dd * dd > r * r) { continue; }
    if (n < MAX) {
      rows[cell * MAX + n] = li;
      n = n + 1u;
    }
  }
  counts[cell] = n;
}

var<workgroup> sums: array<u32, ${SCAN}>;

/** One workgroup: each thread a run of cells; the runs' sums scanned; each cell's start written to the table. */
@compute @workgroup_size(${SCAN})
fn scan(@builtin(local_invocation_id) local: vec3<u32>) {
  let per = (CELLS + ${SCAN - 1}u) / ${SCAN}u;
  let run = local.x * per;
  var total = 0u;
  for (var c = run; c < min(run + per, CELLS); c = c + 1u) { total = total + counts[c]; }
  sums[local.x] = total;
  workgroupBarrier();
  for (var step = 1u; step < ${SCAN}u; step = step * 2u) {
    let add = select(0u, sums[local.x - step], local.x >= step);
    workgroupBarrier();
    sums[local.x] = sums[local.x] + add;
    workgroupBarrier();
  }
  var at = sums[local.x] - total;
  for (var c = run; c < min(run + per, CELLS); c = c + 1u) {
    let start = min(at, CAP);
    data[c * 2u] = start;
    data[c * 2u + 1u] = min(counts[c], CAP - start);
    at = at + counts[c];
  }
}

@compute @workgroup_size(64)
fn fill(@builtin(global_invocation_id) id: vec3<u32>) {
  let cell = id.x;
  if (cell >= CELLS) { return; }
  let start = data[cell * 2u];
  let n = data[cell * 2u + 1u];
  for (var i = 0u; i < n; i = i + 1u) { data[CELLS * 2u + start + i] = rows[cell * MAX + i]; }
}
`;

/** The passes and their scratch, on one device. */
export class GpuLightClusters {
  private readonly uniforms: any;
  private readonly rows: any;
  private readonly counts: any;
  private readonly pipelines: { list: any; scan: any; fill: any };
  private readonly layout: any;

  constructor(private readonly device: any) {
    this.uniforms = device.createBuffer({ size: 128, usage: UNIFORM | COPY_DST });
    this.rows = device.createBuffer({ size: CLUSTER_CELLS * CLUSTER_MAX_PER_CELL * 4, usage: STORAGE });
    this.counts = device.createBuffer({ size: CLUSTER_CELLS * 4, usage: STORAGE });
    const storage = (binding: number, type: string) => ({ binding, visibility: 0x4, buffer: { type } });
    this.layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: 0x4, buffer: { type: "uniform" } }, storage(1, "read-only-storage"), storage(2, "storage"), storage(3, "storage"), storage(4, "storage")],
    });
    const module = device.createShaderModule({ code: LIGHT_CLUSTER_WGSL });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const make = (entryPoint: string) => device.createComputePipeline({ layout, compute: { module, entryPoint } });
    this.pipelines = { list: make("list"), scan: make("scan"), fill: make("fill") };
  }

  /** The params the shaders take (a tile's size, the near plane, the slice scale), as the CPU build gives them. */
  static params(grid: ClusterGrid): [number, number, number, number] {
    return [grid.tileW, grid.tileH, grid.near, grid.scale];
  }

  /** Write the frame's camera and lights; {@link encode} then builds the cells into `data` (the table, then the index list). */
  prepare(grid: ClusterGrid, view: Mat4, width: number, height: number, globalCount: number, lightCount: number): void {
    const bytes = new ArrayBuffer(128);
    const f = new Float32Array(bytes);
    f.set(Array.from({ length: 16 }, (_, i) => view[i]!), 0);
    f.set([grid.near, grid.far, grid.sx, grid.sy], 16);
    f.set([grid.tileW, grid.tileH, grid.scale, 0], 20);
    f.set([width, height, 0, 0], 24);
    new Uint32Array(bytes).set([globalCount, lightCount, 0, 0], 28);
    this.device.queue.writeBuffer(this.uniforms, 0, bytes);
  }

  encode(encoder: any, lights: any, data: any, timing: Record<string, unknown> = {}): void {
    const group = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: { buffer: lights } },
        { binding: 2, resource: { buffer: this.rows } },
        { binding: 3, resource: { buffer: this.counts } },
        { binding: 4, resource: { buffer: data } },
      ],
    });
    const pass = encoder.beginComputePass(timing);
    pass.setBindGroup(0, group);
    pass.setPipeline(this.pipelines.list);
    pass.dispatchWorkgroups(Math.ceil(CLUSTER_CELLS / 64));
    pass.setPipeline(this.pipelines.scan);
    pass.dispatchWorkgroups(1);
    pass.setPipeline(this.pipelines.fill);
    pass.dispatchWorkgroups(Math.ceil(CLUSTER_CELLS / 64));
    pass.end();
  }

  destroy(): void {
    for (const b of [this.uniforms, this.rows, this.counts]) b.destroy();
  }
}

