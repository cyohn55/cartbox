/**
 * GPU cloth (AAA_FIDELITY_ROADMAP.md F7d): the compute passes that run
 * `stepCloth` (cloth.ts in @cartbox/editor) a thread a particle, after GPU
 * skinning (F7a) has written the skinned vertices the cloth hangs from.
 *
 * - **predict** reads the skinned position from the vertex buffer, pins a
 *   held particle there, and moves a free one by its velocity, gravity and the
 *   wind (by how squarely its last normal faces it);
 * - **solve**, run `iterations` times, ping-pongs two position buffers: each
 *   particle averages its constraints' corrections from the one, keeps within
 *   its distance of the skin and out of the capsules, and writes the other
 *   (Jacobi, as the CPU does);
 * - **finish** writes the positions back into the vertex buffer, and each
 *   vertex's normal from its triangles (area-weighted), for the scene to draw.
 *
 * The vertex layout is the renderer's 16 floats: position at 0..2, normal at 3..5.
 */

/** Threads a workgroup. */
export const CLOTH_WORKGROUP = 64;

/** The passes' parameters: count, capsules, then dt, damping, stretch, bend, wind response, margin, relaxation, and the wind. */
export function clothParams(count: number, capsules: number, dt: number, damping: number, stretch: number, bend: number, windResponse: number, margin: number, relax: number, wind: readonly number[], gravity: readonly number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(64);
  const u = new Uint32Array(buffer);
  const f = new Float32Array(buffer);
  u[0] = count;
  u[1] = capsules;
  f[2] = dt;
  f[3] = damping;
  f[4] = stretch;
  f[5] = bend;
  f[6] = windResponse;
  f[7] = margin;
  f[8] = wind[0]!;
  f[9] = wind[1]!;
  f[10] = wind[2]!;
  f[11] = relax;
  f[12] = gravity[0]!;
  f[13] = gravity[1]!;
  f[14] = gravity[2]!;
  return buffer;
}

const PARAMS = /* wgsl */ `
struct Params {
  count: u32,
  capsules: u32,
  dt: f32,
  damping: f32,
  stretch: f32,
  bend: f32,
  windResponse: f32,
  margin: f32,
  wind: vec3<f32>,
  relax: f32,
  gravity: vec3<f32>,
};
@group(0) @binding(0) var<uniform> params: Params;
`;

/** Predict: bindings 1 the vertex buffer (read: the skinned positions and last normals), 2 the positions, 3 the previous, 4 each particle's (inverse mass, max distance). */
export const CLOTH_PREDICT_WGSL = /* wgsl */ `${PARAMS}
@group(0) @binding(1) var<storage, read> vertices: array<f32>;
@group(0) @binding(2) var<storage, read_write> position: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> previous: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> particle: array<vec2<f32>>;

@compute @workgroup_size(${CLOTH_WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) { return; }
  let skinned = vec3<f32>(vertices[i * 16u], vertices[i * 16u + 1u], vertices[i * 16u + 2u]);
  if (particle[i].x == 0.0) {
    position[i] = vec4<f32>(skinned, 0.0);
    previous[i] = vec4<f32>(skinned, 0.0);
    return;
  }
  let p = position[i].xyz;
  let v = (p - previous[i].xyz) * (1.0 - params.damping);
  let rel = params.wind - v / params.dt;
  let n = vec3<f32>(vertices[i * 16u + 3u], vertices[i * 16u + 4u], vertices[i * 16u + 5u]);
  let facing = abs(dot(n, rel)) / max(length(rel), 1e-9);
  previous[i] = vec4<f32>(p, 0.0);
  position[i] = vec4<f32>(p + v + (params.gravity + rel * params.windResponse * facing) * params.dt * params.dt, 0.0);
}
`;

/**
 * Solve: 1 the positions read, 2 written, 3 the neighbours' starts, 4 their
 * entries (neighbour, rest length, 0 stretch or 1 bend), 5 the particles, 6 the
 * skinned positions (the vertex buffer), 7 the capsules (a, then b and radius).
 */
export const CLOTH_SOLVE_WGSL = /* wgsl */ `${PARAMS}
@group(0) @binding(1) var<storage, read> source: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> dest: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> starts: array<u32>;
@group(0) @binding(4) var<storage, read> entries: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> particle: array<vec2<f32>>;
@group(0) @binding(6) var<storage, read> vertices: array<f32>;
@group(0) @binding(7) var<storage, read> capsules: array<vec4<f32>>;

@compute @workgroup_size(${CLOTH_WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) { return; }
  let p = source[i].xyz;
  let wi = particle[i].x;
  if (wi == 0.0) { dest[i] = vec4<f32>(p, 0.0); return; }
  var c = vec3<f32>(0.0);
  let first = starts[i];
  let last = starts[i + 1u];
  for (var e = first; e < last; e = e + 1u) {
    let entry = entries[e];
    let j = u32(entry.x + 0.5);
    let d = source[j].xyz - p;
    let len = length(d);
    if (len < 1e-9) { continue; }
    let k = select(params.stretch, params.bend, entry.z > 0.5);
    let w = wi / (wi + particle[j].x);
    c = c + d * (k * w * (len - entry.y) / len);
  }
  let n = last - first;
  var q = p;
  if (n > 0u) { q = p + c * (params.relax / f32(n)); }
  // Within its distance of the skin.
  let s = vec3<f32>(vertices[i * 16u], vertices[i * 16u + 1u], vertices[i * 16u + 2u]);
  let f = q - s;
  let fl = length(f);
  let m = particle[i].y;
  if (fl > m) { q = s + f * (m / fl); }
  // Out of the body's capsules.
  for (var k = 0u; k < params.capsules; k = k + 1u) {
    let a = capsules[k * 2u].xyz;
    let b = capsules[k * 2u + 1u].xyz;
    let r = capsules[k * 2u + 1u].w + params.margin;
    let ab = b - a;
    let len2 = dot(ab, ab);
    var t = 0.0;
    if (len2 > 1e-12) { t = clamp(dot(q - a, ab) / len2, 0.0, 1.0); }
    let near = a + ab * t;
    let dq = q - near;
    let dist = length(dq);
    if (dist < r) {
      var dir = vec3<f32>(0.0, 1.0, 0.0);
      if (dist > 1e-9) { dir = dq / dist; }
      q = near + dir * r;
    }
  }
  dest[i] = vec4<f32>(q, 0.0);
}
`;

/**
 * Finish: 1 the vertex buffer (written), 2 the positions, 3 each vertex's
 * triangles' starts, 4 the triangles (a vertex's, by index into 5), 5 the indices.
 */
export const CLOTH_FINISH_WGSL = /* wgsl */ `${PARAMS}
@group(0) @binding(1) var<storage, read_write> vertices: array<f32>;
@group(0) @binding(2) var<storage, read> position: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> triStarts: array<u32>;
@group(0) @binding(4) var<storage, read> tris: array<u32>;
@group(0) @binding(5) var<storage, read> indices: array<u32>;

@compute @workgroup_size(${CLOTH_WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= params.count) { return; }
  let p = position[i].xyz;
  var n = vec3<f32>(0.0);
  for (var e = triStarts[i]; e < triStarts[i + 1u]; e = e + 1u) {
    let t = tris[e] * 3u;
    let a = position[indices[t]].xyz;
    let b = position[indices[t + 1u]].xyz;
    let c = position[indices[t + 2u]].xyz;
    n = n + cross(b - a, c - a);
  }
  let len = length(n);
  if (len > 1e-12) { n = n / len; } else { n = vec3<f32>(vertices[i * 16u + 3u], vertices[i * 16u + 4u], vertices[i * 16u + 5u]); }
  vertices[i * 16u] = p.x;
  vertices[i * 16u + 1u] = p.y;
  vertices[i * 16u + 2u] = p.z;
  vertices[i * 16u + 3u] = n.x;
  vertices[i * 16u + 4u] = n.y;
  vertices[i * 16u + 5u] = n.z;
}
`;

/** Each vertex's triangles, for the normals: `starts[v]..starts[v + 1]` index `tris` (a triangle's index). */
export function vertexTriangles(indices: Uint32Array, count: number): { starts: Uint32Array; tris: Uint32Array } {
  const lists: number[][] = Array.from({ length: count }, () => []);
  for (let t = 0; t + 2 < indices.length; t += 3) for (let k = 0; k < 3; k += 1) lists[indices[t + k]!]?.push(t / 3);
  const starts = new Uint32Array(count + 1);
  const tris: number[] = [];
  lists.forEach((l, v) => {
    starts[v] = tris.length;
    tris.push(...l);
  });
  starts[count] = tris.length;
  return { starts, tris: Uint32Array.from(tris.length > 0 ? tris : [0]) };
}

/** The capsules as the solve reads them: two vec4s each (a; b and the radius). */
export function packCapsules(capsules: readonly { readonly a: readonly number[]; readonly b: readonly number[]; readonly radius: number }[]): Float32Array {
  const out = new Float32Array(Math.max(1, capsules.length) * 8);
  capsules.forEach((c, k) => out.set([c.a[0]!, c.a[1]!, c.a[2]!, 0, c.b[0]!, c.b[1]!, c.b[2]!, c.radius], k * 8));
  return out;
}
