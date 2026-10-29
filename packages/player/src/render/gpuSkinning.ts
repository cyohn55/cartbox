/**
 * GPU skinning and morph targets (AAA_FIDELITY_ROADMAP.md F7a): a compute pass
 * that writes a skinned primitive's posed vertices straight into the vertex
 * buffer the scene draws, where the CPU used to skin and upload them.
 *
 * - **Morphs first.** Each vertex adds its own morph deltas (the targets that
 *   move it, packed per vertex by `morphCsr`) times the targets' weights, to
 *   its bind position and normal.
 * - **Then skinning**, by linear blending of the joints' matrices (what every
 *   other renderer draws) or by dual quaternions (Kavan), per mesh.
 * - **Motion vectors** keep working: the renderer copies the vertices it had
 *   to the previous-position buffer before the pass writes new ones (F0c).
 *
 * The vertex layout is the renderer's 64 bytes: position (0..2), normal
 * (3..5), then the UVs, blend, sway and tangent, which the pass leaves as they
 * are (a skinned copy's tangents are zero: it takes the derivative frame).
 */

/** Threads a workgroup. */
export const SKIN_WORKGROUP = 64;

/** The skinning pass's parameters: vertex count, joint count, whether by dual quaternions, and the targets. */
export function skinParams(vertices: number, joints: number, dualQuaternion: boolean, targets: number): Uint32Array {
  return Uint32Array.from([vertices, joints, dualQuaternion ? 1 : 0, targets]);
}

/**
 * Bindings: 0 the parameters; 1 the bind shape (two vec4s a vertex: position,
 * normal); 2 the influences (a vec4<u32> of joints, then a vec4 of weights, a
 * vertex); 3 the joints (a 4×4 each, or a dual quaternion's two vec4s); 4 the
 * morphs' per-vertex starts; 5 their entries (two vec4s: the target and the
 * position delta, the normal delta); 6 the targets' weights; 7 the vertex
 * buffer, 16 floats a vertex.
 */
export const SKIN_WGSL = /* wgsl */ `
struct Params {
  vertices: u32,
  joints: u32,
  dualQuaternion: u32,
  targets: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bind: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> influences: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read> joints: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> morphStarts: array<u32>;
@group(0) @binding(5) var<storage, read> morphEntries: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read> morphWeights: array<f32>;
@group(0) @binding(7) var<storage, read_write> vertices: array<f32>;

fn rotateByQuat(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  let c = cross(q.xyz, v) + q.w * v;
  return v + 2.0 * cross(q.xyz, c);
}

@compute @workgroup_size(${SKIN_WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let v = id.x;
  if (v >= params.vertices) { return; }
  var p = bind[v * 2u].xyz;
  var n = bind[v * 2u + 1u].xyz;
  // Morph targets: the deltas that move this vertex, by their targets' weights.
  if (params.targets > 0u) {
    for (var e = morphStarts[v]; e < morphStarts[v + 1u]; e = e + 1u) {
      let a = morphEntries[e * 2u];
      let b = morphEntries[e * 2u + 1u];
      let w = morphWeights[u32(a.x + 0.5)];
      p = p + w * a.yzw;
      n = n + w * b.xyz;
    }
    n = normalize(n + vec3<f32>(1e-12, 0.0, 0.0));
  }
  let js = influences[v * 2u];
  let ws = bitcast<vec4<f32>>(influences[v * 2u + 1u]);
  var outP = p;
  var outN = n;
  var total = 0.0;
  if (params.dualQuaternion == 0u) {
    var m0 = vec4<f32>(0.0);
    var m1 = vec4<f32>(0.0);
    var m2 = vec4<f32>(0.0);
    var m3 = vec4<f32>(0.0);
    for (var k = 0u; k < 4u; k = k + 1u) {
      let w = ws[k];
      let j = js[k];
      if (w <= 0.0 || j >= params.joints) { continue; }
      total = total + w;
      m0 = m0 + joints[j * 4u] * w;
      m1 = m1 + joints[j * 4u + 1u] * w;
      m2 = m2 + joints[j * 4u + 2u] * w;
      m3 = m3 + joints[j * 4u + 3u] * w;
    }
    if (total > 0.0) {
      let m = mat4x4<f32>(m0, m1, m2, m3) * (1.0 / total);
      outP = (m * vec4<f32>(p, 1.0)).xyz;
      outN = normalize((m * vec4<f32>(n, 0.0)).xyz + vec3<f32>(1e-12, 0.0, 0.0));
    }
  } else {
    var r = vec4<f32>(0.0);
    var d = vec4<f32>(0.0);
    var first = 0xffffffffu;
    for (var k = 0u; k < 4u; k = k + 1u) {
      let w = ws[k];
      let j = js[k];
      if (w <= 0.0 || j >= params.joints) { continue; }
      if (first == 0xffffffffu) { first = j; }
      let qr = joints[j * 2u];
      let s = select(1.0, -1.0, dot(joints[first * 2u], qr) < 0.0);
      r = r + qr * (w * s);
      d = d + joints[j * 2u + 1u] * (w * s);
      total = total + w;
    }
    if (total > 0.0) {
      let len = max(length(r), 1e-12);
      r = r / len;
      d = d / len;
      let t = 2.0 * (r.w * d.xyz - d.w * r.xyz + cross(r.xyz, d.xyz));
      outP = rotateByQuat(r, p) + t;
      outN = rotateByQuat(r, n);
    }
  }
  let o = v * 16u;
  vertices[o] = outP.x;
  vertices[o + 1u] = outP.y;
  vertices[o + 2u] = outP.z;
  vertices[o + 3u] = outN.x;
  vertices[o + 4u] = outN.y;
  vertices[o + 5u] = outN.z;
}
`;

/** A primitive's bind shape as the pass reads it: position and normal, two vec4s a vertex. */
export function packBindShape(positions: Float32Array, normals: Float32Array | null): Float32Array {
  const n = positions.length / 3;
  const out = new Float32Array(n * 8);
  for (let v = 0; v < n; v += 1) {
    out.set(positions.subarray(v * 3, v * 3 + 3), v * 8);
    if (normals) out.set(normals.subarray(v * 3, v * 3 + 3), v * 8 + 4);
    else out[v * 8 + 5] = 1;
  }
  return out;
}

/** A primitive's influences: four joints (u32), then four weights (as u32 bits), a vertex. */
export function packInfluences(joints: Uint16Array, weights: Float32Array): Uint32Array {
  const n = joints.length / 4;
  const out = new Uint32Array(n * 8);
  const bits = new Float32Array(out.buffer);
  for (let v = 0; v < n; v += 1) {
    for (let k = 0; k < 4; k += 1) {
      out[v * 8 + k] = joints[v * 4 + k]!;
      bits[v * 8 + 4 + k] = weights[v * 4 + k]!;
    }
  }
  return out;
}
