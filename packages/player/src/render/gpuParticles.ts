/**
 * GPU particles (AAA_FIDELITY_ROADMAP.md F8a) on the linear-light renderer:
 * the emitters of particleGraph.ts (@cartbox/editor) simulated in compute and
 * drawn in the scene, after the see-through pass, against its depths.
 *
 * - **spawn** writes a frame's new particles into their emitter's ring (each
 *   request — a burst or the rate's spawns — a run of slots), from the same
 *   hash the CPU's reference uses;
 * - **update** integrates every slot: gravity, drag, curl noise, the
 *   attractor and vortex, the distance shapes, and the depth buffer (a
 *   particle that passes behind the prepass's surface, within a thickness,
 *   steps back and bounces off the G-buffer's normal);
 * - **sort** (blended emitters): each slot's view depth as a key, then a
 *   bitonic sort of (key, slot) pairs, back to front;
 * - **draw**: sprites (camera-facing, stretched along their velocity, a
 *   flipbook over their life with motion-vector blending between frames, a
 *   procedural soft disc without an atlas), meshes (instanced, oriented along
 *   their velocity) or ribbons (a strip through the ring in birth order).
 *   Lit by the key light and the frame's global lights plus the ambient, or
 *   emissive; faded softly where they meet the scene.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { PARTICLE_FLOATS, compileEmitter, type EmitterParams, type EmitterSpec } from "@cartbox/editor";

export const PARTICLE_WORKGROUP = 64;
/** Spawn requests an emitter takes a frame. */
export const MAX_SPAWN_REQUESTS = 64;
/** The emitter's uniform, in vec4s. */
const EMITTER_VEC4S = 32;

/** An emitter's uniform: see the WGSL `Emitter`. */
export function packEmitter(e: EmitterParams, frame: { dt: number; time: number; viewProj: ArrayLike<number>; width: number; height: number; depthTerms: readonly [number, number]; requests: number; spawnTotal: number }): ArrayBuffer {
  const buffer = new ArrayBuffer(EMITTER_VEC4S * 16);
  const f = new Float32Array(buffer);
  const u = new Uint32Array(buffer);
  u[0] = e.capacity;
  u[1] = frame.requests;
  u[2] = frame.spawnTotal;
  u[3] = e.shapes.length;
  f.set([e.shape, e.radius, e.angle, e.speed], 4);
  f.set([...e.extents, e.speedJitter], 8);
  f.set([e.life, e.lifeJitter, e.drag, frame.dt], 12);
  f.set([...e.gravity, e.curl], 16);
  f.set([e.curlScale, frame.time * e.curlSpeed, e.depthCollide ? 1 : 0, e.restitution], 20);
  f.set([...e.attractor, e.attract], 24);
  f.set([...e.vortexAxis, e.vortex], 28);
  f.set([e.friction, frame.width, frame.height, 0.25], 32); // the last: the depth collision's thickness (m)
  f.set([frame.depthTerms[0], frame.depthTerms[1], 0, 0], 36);
  for (let i = 0; i < 16; i += 1) f[40 + i] = frame.viewProj[i]!;
  e.shapes.forEach((s, k) => {
    const o = 56 + k * 8;
    if (s.kind === "sphere") f.set([0, ...s.center, s.radius, 0, 0, 0], o);
    else if (s.kind === "box") f.set([1, ...s.center, 0, ...s.half], o);
    else f.set([2, ...s.normal, s.offset, 0, 0, 0], o);
  });
  return buffer;
}

const EMITTER_WGSL = /* wgsl */ `
struct Emitter {
  counts: vec4<u32>,      // capacity, requests, spawns this frame, shapes
  shape: vec4<f32>,       // kind, radius, cone angle, speed
  extents: vec4<f32>,     // box half extents, speed jitter
  life: vec4<f32>,        // life, its jitter, drag, dt
  gravity: vec4<f32>,     // gravity, curl strength
  curl: vec4<f32>,        // curl scale, curl time, depth collision, restitution
  attractor: vec4<f32>,   // position, strength
  vortex: vec4<f32>,      // axis, strength
  frame: vec4<f32>,       // friction, width, height, thickness
  depth: vec4<f32>,       // the projection's depth terms
  viewProj: mat4x4<f32>,
  shapes: array<vec4<f32>, 16>, // kind + centre/normal + radius/offset; half extents
};
struct Particle {
  p: vec4<f32>, // position, age
  v: vec4<f32>, // velocity, life
  b: vec4<u32>, // birth, spare
};
fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn rand(birth: u32, k: u32) -> f32 { return f32(pcg(birth * 16u + k)) / 4294967296.0; }
`;

/** Spawn: 0 the emitter, 1 the particles, 2 the requests (at + count, dir + first slot, birth). */
export const PARTICLE_SPAWN_WGSL = /* wgsl */ `${EMITTER_WGSL}
@group(0) @binding(0) var<uniform> e: Emitter;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var<storage, read> requests: array<vec4<f32>>;

@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  var i = id.x;
  if (i >= e.counts.z) { return; }
  // Which request: the runs are in order.
  var r = 0u;
  loop {
    let count = u32(requests[r * 3u].w + 0.5);
    if (i < count || r + 1u >= e.counts.y) { break; }
    i = i - count;
    r = r + 1u;
  }
  let at = requests[r * 3u].xyz;
  let dir = requests[r * 3u + 1u].xyz;
  let first = u32(requests[r * 3u + 1u].w + 0.5);
  let birth = bitcast<u32>(requests[r * 3u + 2u].x) + i;
  let slot = (first + i) % e.counts.x;
  // A direction: on the sphere, or within the cone about dir.
  let len = length(dir);
  var axis = vec3<f32>(0.0, 1.0, 0.0);
  if (len > 1e-6) { axis = dir / len; }
  var cosMax = -1.0;
  if (e.shape.x > 1.5 && e.shape.x < 2.5) { cosMax = cos(e.shape.z); }
  let cosT = 1.0 - rand(birth, 0u) * (1.0 - cosMax);
  let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  let phi = 6.28318530718 * rand(birth, 1u);
  var helper = vec3<f32>(0.0, 1.0, 0.0);
  if (abs(axis.y) >= 0.99) { helper = vec3<f32>(1.0, 0.0, 0.0); }
  let t = normalize(cross(helper, axis));
  let b = cross(axis, t);
  let d = axis * cosT + (t * cos(phi) + b * sin(phi)) * sinT;
  var p = at;
  if (e.shape.x > 0.5 && e.shape.x < 2.5) { p = p + d * (e.shape.y * pow(rand(birth, 2u), 1.0 / 3.0)); }
  else if (e.shape.x > 2.5) { p = p + (vec3<f32>(rand(birth, 2u), rand(birth, 3u), rand(birth, 4u)) * 2.0 - vec3<f32>(1.0)) * e.extents.xyz; }
  let speed = e.shape.w * (1.0 + e.extents.w * (rand(birth, 5u) * 2.0 - 1.0));
  let life = max(0.01, e.life.x * (1.0 + e.life.y * (rand(birth, 6u) * 2.0 - 1.0)));
  particles[slot] = Particle(vec4<f32>(p, 0.0), vec4<f32>(d * speed, life), vec4<u32>(birth, 0u, 0u, 0u));
}
`;

/** Update: 0 the emitter, 1 the particles, 2 the scene's depths, 3 the G-buffer. */
export const PARTICLE_UPDATE_WGSL = /* wgsl */ `${EMITTER_WGSL}
@group(0) @binding(0) var<uniform> e: Emitter;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var sceneDepth: texture_depth_2d;
@group(0) @binding(3) var gbuffer: texture_2d<f32>;

fn curlNoise(q: vec3<f32>, s: f32, t: f32) -> vec3<f32> {
  let dpzdy = s * cos(2.0 * s * q.y + 1.1 * t);
  let dpydz = s * cos(s * q.z + 1.3 * t);
  let dpxdz = s * cos(2.0 * s * q.z + 1.7 * t);
  let dpzdx = s * cos(s * q.x + 0.7 * t);
  let dpydx = s * cos(2.0 * s * q.x + 0.9 * t);
  let dpxdy = s * cos(s * q.y + t);
  return vec3<f32>(dpzdy - dpydz, dpxdz - dpzdx, dpydx - dpxdy);
}
fn octDecode(o: vec2<f32>) -> vec3<f32> {
  var n = vec3<f32>(o.x, o.y, 1.0 - abs(o.x) - abs(o.y));
  let t = max(-n.z, 0.0);
  n.x = n.x + select(t, -t, n.x >= 0.0);
  n.y = n.y + select(t, -t, n.y >= 0.0);
  return normalize(n);
}
// Where a point falls on screen: its pixel (x < 0 off screen or behind the eye), its eye depth, and the
// prepass surface's eye depth there (far away where nothing was drawn).
fn screenAt(p: vec3<f32>) -> vec4<f32> {
  let clip = e.viewProj * vec4<f32>(p, 1.0);
  if (clip.w <= 0.0) { return vec4<f32>(-1.0, 0.0, 0.0, 0.0); }
  let ndc = clip.xyz / clip.w;
  if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0 || ndc.z <= 0.0 || ndc.z >= 1.0) { return vec4<f32>(-1.0, 0.0, 0.0, 0.0); }
  let px = vec2<f32>(floor((ndc.x * 0.5 + 0.5) * e.frame.y), floor((0.5 - ndc.y * 0.5) * e.frame.z));
  let surface = textureLoad(sceneDepth, vec2<i32>(px), 0);
  var eyeS = 1e9;
  if (surface < 1.0) { eyeS = e.depth.y / (surface + e.depth.x); }
  return vec4<f32>(px, e.depth.y / (ndc.z + e.depth.x), eyeS);
}
fn bounce(v: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  let vn = dot(v, n);
  if (vn >= 0.0) { return v; }
  return (v - vn * n) * (1.0 - e.frame.x) - vn * e.curl.w * n;
}

@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= e.counts.x) { return; }
  var q = particles[i];
  if (q.p.w >= q.v.w) { return; }
  let dt = e.life.w;
  var a = e.gravity.xyz;
  if (e.gravity.w > 0.0) { a = a + curlNoise(q.p.xyz, e.curl.x, e.curl.y) * e.gravity.w; }
  if (e.attractor.w != 0.0) {
    let d = e.attractor.xyz - q.p.xyz;
    a = a + d / max(0.1, length(d)) * e.attractor.w;
  }
  if (e.vortex.w != 0.0) { a = a + cross(e.vortex.xyz, q.p.xyz - e.attractor.xyz) * e.vortex.w; }
  var v = (q.v.xyz + a * dt) * exp(-e.life.z * dt);
  let before = q.p.xyz;
  var p = before + v * dt;
  for (var k = 0u; k < e.counts.w; k = k + 1u) {
    let s = e.shapes[k * 2u];
    let h = e.shapes[k * 2u + 1u];
    var d = 0.0;
    var n = vec3<f32>(0.0, 1.0, 0.0);
    if (s.x < 0.5) {
      let r = p - s.yzw;
      let l = max(length(r), 1e-9);
      d = l - h.x;
      n = r / l;
    } else if (s.x < 1.5) {
      let c = p - s.yzw;
      let o = abs(c) - h.yzw;
      d = length(max(o, vec3<f32>(0.0))) + min(max(o.x, max(o.y, o.z)), 0.0);
      n = vec3<f32>(0.0);
      if (o.x > o.y && o.x > o.z) { n.x = select(-1.0, 1.0, c.x >= 0.0); }
      else if (o.y > o.z) { n.y = select(-1.0, 1.0, c.y >= 0.0); }
      else { n.z = select(-1.0, 1.0, c.z >= 0.0); }
    } else {
      n = normalize(s.yzw);
      d = dot(p, n) - h.x;
    }
    if (d < 0.0) {
      p = p - n * d;
      v = bounce(v, n);
    }
  }
  // The depth buffer: a particle in front of the prepass's surface a step ago and behind it now (or just behind
  // it, within the thickness) steps back and bounces off the G-buffer's normal.
  if (e.curl.z > 0.5) {
    let now = screenAt(p);
    let then = screenAt(before);
    if (now.x >= 0.0 && now.z > now.w) {
      let crossed = then.x >= 0.0 && then.z <= then.w + 1e-3;
      if (crossed || now.z - now.w < e.frame.w) {
        let n = octDecode(textureLoad(gbuffer, vec2<i32>(now.xy), 0).xy);
        p = before;
        v = bounce(v, n);
      }
    }
  }
  particles[i] = Particle(vec4<f32>(p, q.p.w + dt), vec4<f32>(v, q.v.w), q.b);
}
`;

/** Sort keys: 0 the emitter, 1 the particles, 2 the pairs (key as sortable bits, slot). Dead particles last. */
export const PARTICLE_KEYS_WGSL = /* wgsl */ `${EMITTER_WGSL}
@group(0) @binding(0) var<uniform> e: Emitter;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var<storage, read_write> pairs: array<vec2<u32>>;

@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= e.counts.x) { return; }
  let q = particles[i];
  var key = 0xffffffffu;
  if (q.p.w < q.v.w) {
    // Back to front: the farthest (largest clip w) first, as ascending keys of its negation's bits.
    let w = (e.viewProj * vec4<f32>(q.p.xyz, 1.0)).w;
    key = 0x7fffffffu - min(bitcast<u32>(max(w, 0.0)), 0x7ffffffeu);
  }
  pairs[i] = vec2<u32>(key, i);
}
`;

/** One bitonic stage over the pairs: binding 0 (k, j), 1 the pairs. */
export const PARTICLE_SORT_WGSL = /* wgsl */ `
struct Stage { k: u32, j: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> stage: Stage;
@group(0) @binding(1) var<storage, read_write> pairs: array<vec2<u32>>;

@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= arrayLength(&pairs)) { return; }
  let l = i ^ stage.j;
  if (l <= i) { return; }
  let a = pairs[i];
  let b = pairs[l];
  let up = (i & stage.k) == 0u;
  if ((a.x > b.x) == up) {
    pairs[i] = b;
    pairs[l] = a;
  }
}
`;

/** The (k, j) stages of a bitonic sort over `n` (a power of two). */
export function bitonicStages(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 2; k <= n; k <<= 1) for (let j = k >> 1; j > 0; j >>= 1) out.push([k, j]);
  return out;
}

/** The look of an emitter as the draw reads it (vec4s): see `Look`. */
export function packLook(e: EmitterParams, camera: { right: readonly number[]; up: readonly number[]; eye: readonly number[] }, light: { direction: readonly number[]; color: readonly number[]; ambient: number; lights: number }, atlas: boolean, motion: boolean): Float32Array {
  return Float32Array.from([
    ...e.colorStart,
    ...e.colorEnd,
    e.sizeStart, e.sizeEnd, e.glow, e.stretch,
    e.frames, atlas ? 1 : 0, motion && e.motionVectors ? 1 : 0, e.additive ? 1 : 0,
    camera.right[0]!, camera.right[1]!, camera.right[2]!, e.render,
    camera.up[0]!, camera.up[1]!, camera.up[2]!, e.capacity,
    camera.eye[0]!, camera.eye[1]!, camera.eye[2]!, light.ambient,
    light.direction[0]!, light.direction[1]!, light.direction[2]!, light.lights,
    light.color[0]!, light.color[1]!, light.color[2]!, 0,
  ]);
}

/**
 * Draw: 0 the emitter, 1 the look, 2 the particles, 3 the order (sorted pairs), 4 the lights, 5 the atlas,
 * 6 the motion vectors, 7 a sampler, 8 the scene's depths (soft edges).
 */
export const PARTICLE_DRAW_WGSL = /* wgsl */ `${EMITTER_WGSL}
struct Look {
  colorStart: vec4<f32>,
  colorEnd: vec4<f32>,
  size: vec4<f32>,      // start, end, glow, stretch
  flip: vec4<f32>,      // frames, atlas, motion vectors, additive
  right: vec4<f32>,     // camera right, render mode
  up: vec4<f32>,        // camera up, capacity
  eye: vec4<f32>,       // eye, ambient
  sun: vec4<f32>,       // key light direction (toward it), global lights
  sunColor: vec4<f32>,
};
struct Light {
  d0: vec4<f32>,
  d1: vec4<f32>,
  d2: vec4<f32>,
  d3: vec4<f32>,
  d4: vec4<f32>,
};
@group(0) @binding(0) var<uniform> e: Emitter;
@group(0) @binding(1) var<uniform> look: Look;
@group(0) @binding(2) var<storage, read> particles: array<Particle>;
@group(0) @binding(3) var<storage, read> order: array<vec2<u32>>;
@group(0) @binding(4) var<storage, read> lights: array<Light>;
@group(0) @binding(5) var atlas: texture_2d<f32>;
@group(0) @binding(6) var motion: texture_2d<f32>;
@group(0) @binding(7) var samp: sampler;
@group(0) @binding(8) var sceneDepth: texture_depth_2d;

struct Out {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) colour: vec4<f32>,
  @location(2) life: f32,
  @location(3) world: vec3<f32>,
  @location(4) normal: vec3<f32>,
};

fn lit(world: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
  // The key light (half-Lambert: a particle is lit through), the global lights, the ambient.
  var l = look.sunColor.rgb * (0.5 + 0.5 * dot(n, look.sun.xyz)) + vec3<f32>(look.eye.w);
  let count = u32(look.sun.w + 0.5);
  for (var k = 0u; k < count; k = k + 1u) {
    let g = lights[k];
    var dir = normalize(g.d0.xyz);
    var atten = 1.0;
    if (g.d0.w > 0.5) {
      let to = g.d0.xyz - world;
      let dist = max(length(to), 0.01);
      dir = to / dist;
      if (g.d2.x > 0.0) { let q = clamp(1.0 - pow(dist / g.d2.x, 4.0), 0.0, 1.0); atten = q * q / (dist * dist); } else { atten = 1.0 / (dist * dist); }
    }
    l = l + g.d1.rgb * g.d1.w * atten * (0.5 + 0.5 * dot(n, dir));
  }
  return l;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> Out {
  var out: Out;
  let corner = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0))[vi];
  let cap = e.counts.x;
  let mode = u32(look.right.w + 0.5);
  var slot = ii;
  if (look.flip.w < 0.5 && mode == 0u) { slot = order[ii].y; }
  let q = particles[slot];
  out.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0); // off screen, for the dead
  if (q.p.w >= q.v.w) { return out; }
  let t = q.p.w / q.v.w;
  let size = mix(look.size.x, look.size.y, t);
  out.colour = mix(look.colorStart, look.colorEnd, t);
  out.life = t;
  var world = q.p.xyz;
  if (mode == 2u) {
    // A ribbon: the segment to the next one born, unless the ring wrapped there or it is dead.
    let next = particles[(slot + 1u) % cap];
    if (next.p.w >= next.v.w || next.b.x != q.b.x + 1u) { return out; }
    let a = q.p.xyz;
    let b = next.p.xyz;
    let along = b - a;
    let toEye = normalize(look.eye.xyz - a);
    var side = cross(along, toEye);
    side = side / max(length(side), 1e-6) * size * 0.5;
    let end = select(a, b, corner.x > 0.0);
    world = end + side * corner.y;
    out.uv = vec2<f32>(corner.x * 0.5 + 0.5, corner.y * 0.5 + 0.5);
    out.normal = toEye;
  } else {
    // A sprite facing the camera, stretched along its velocity on screen.
    var right = look.right.xyz;
    var up = look.up.xyz;
    let v = q.v.xyz;
    let onScreen = v - dot(v, normalize(look.eye.xyz - world)) * normalize(look.eye.xyz - world);
    if (look.size.w > 0.0 && length(onScreen) > 1e-4) {
      up = normalize(onScreen);
      right = normalize(cross(up, normalize(look.eye.xyz - world)));
      up = up * (1.0 + look.size.w * length(onScreen) * 0.1 / max(size, 1e-4));
    }
    world = world + (right * corner.x + up * corner.y) * size * 0.5;
    out.uv = corner * 0.5 + vec2<f32>(0.5);
    out.normal = normalize(look.eye.xyz - q.p.xyz);
  }
  out.world = world;
  out.pos = e.viewProj * vec4<f32>(world, 1.0);
  return out;
}

@fragment
fn fs(in: Out) -> @location(0) vec4<f32> {
  var tex = vec4<f32>(1.0);
  if (look.flip.y > 0.5) {
    // The flipbook: this frame and the next, blended, each pushed along its motion vectors toward the in-between.
    let frames = max(1.0, look.flip.x);
    let f = clamp(in.life, 0.0, 0.9999) * frames;
    let frame = floor(f);
    let next = min(frames - 1.0, frame + 1.0);
    let w = f - frame;
    var uvA = vec2<f32>((frame + in.uv.x) / frames, 1.0 - in.uv.y);
    var uvB = vec2<f32>((next + in.uv.x) / frames, 1.0 - in.uv.y);
    if (look.flip.z > 0.5) {
      let mA = (textureSampleLevel(motion, samp, uvA, 0.0).xy * 2.0 - vec2<f32>(1.0)) / frames;
      let mB = (textureSampleLevel(motion, samp, uvB, 0.0).xy * 2.0 - vec2<f32>(1.0)) / frames;
      uvA = uvA - mA * w;
      uvB = uvB + mB * (1.0 - w);
    }
    tex = mix(textureSampleLevel(atlas, samp, uvA, 0.0), textureSampleLevel(atlas, samp, uvB, 0.0), w);
  } else if (u32(look.right.w + 0.5) != 2u) {
    // A soft disc.
    let d = length(in.uv * 2.0 - vec2<f32>(1.0));
    tex = vec4<f32>(vec3<f32>(1.0 - 0.45 * d * d), clamp((1.0 - d) * 1.6, 0.0, 1.0));
  }
  var c = in.colour * tex;
  // Soft where it meets the scene: faded over its last 20 cm in front of the surface.
  let px = vec2<i32>(in.pos.xy);
  let surface = textureLoad(sceneDepth, px, 0);
  let eyeS = e.depth.y / (surface + e.depth.x);
  let eyeP = e.depth.y / (in.pos.z + e.depth.x);
  c.a = c.a * clamp((eyeS - eyeP) / 0.2, 0.0, 1.0);
  var rgb = c.rgb * look.size.z;
  if (look.size.z <= 0.0) { rgb = c.rgb * lit(in.world, normalize(in.normal)); }
  if (look.flip.w > 0.5) { return vec4<f32>(rgb * c.a, 0.0); }
  return vec4<f32>(rgb * c.a, c.a);
}

// A mesh particle: the mesh's vertex, scaled by the size and turned along the velocity.
struct MeshIn {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
};
@vertex
fn vsMesh(v: MeshIn, @builtin(instance_index) ii: u32) -> Out {
  var out: Out;
  out.pos = vec4<f32>(0.0, 0.0, 2.0, 1.0);
  var slot = ii;
  if (look.flip.w < 0.5) { slot = order[ii].y; }
  let q = particles[slot];
  if (q.p.w >= q.v.w) { return out; }
  let t = q.p.w / q.v.w;
  let size = mix(look.size.x, look.size.y, t);
  // A frame whose +Y follows the velocity.
  var y = vec3<f32>(0.0, 1.0, 0.0);
  if (length(q.v.xyz) > 1e-4) { y = normalize(q.v.xyz); }
  var x = cross(y, vec3<f32>(0.0, 0.0, 1.0));
  if (length(x) < 1e-4) { x = cross(y, vec3<f32>(1.0, 0.0, 0.0)); }
  x = normalize(x);
  let z = cross(x, y);
  let world = q.p.xyz + (x * v.position.x + y * v.position.y + z * v.position.z) * size;
  out.world = world;
  out.normal = normalize(x * v.normal.x + y * v.normal.y + z * v.normal.z);
  out.colour = mix(look.colorStart, look.colorEnd, t);
  out.life = t;
  out.uv = vec2<f32>(0.5);
  out.pos = e.viewProj * vec4<f32>(world, 1.0);
  return out;
}
@fragment
fn fsMesh(in: Out) -> @location(0) vec4<f32> {
  var rgb = in.colour.rgb * look.size.z;
  if (look.size.z <= 0.0) { rgb = in.colour.rgb * lit(in.world, normalize(in.normal)); }
  return vec4<f32>(rgb * in.colour.a, select(in.colour.a, 0.0, look.flip.w > 0.5));
}
`;

/** A mesh for mesh particles: positions and normals, and its triangles. */
export interface ParticleMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

/** An emitter's GPU state. */
interface GpuEmitter {
  readonly spec: EmitterSpec;
  readonly params: EmitterParams;
  readonly particles: any;
  readonly requests: any;
  readonly uniform: any;
  readonly look: any;
  readonly pairs: any | null;
  readonly atlas: any;
  readonly motion: any;
  head: number;
  born: number;
  carry: number;
  pending: { at: readonly number[]; dir: readonly number[]; count: number }[];
  mesh: { vertices: any; indices: any; count: number } | null;
}

/** What the renderer hands a frame's simulation and draw. */
export interface ParticleFrame {
  readonly dt: number;
  readonly time: number;
  readonly viewProj: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
  readonly depthTerms: readonly [number, number];
  readonly eye: readonly number[];
  readonly right: readonly number[];
  readonly up: readonly number[];
  readonly light: { readonly direction: readonly number[]; readonly color: readonly number[]; readonly ambient: number; readonly lights: number };
}

/** The GPU particle system: emitters, their rings, and the passes over them. */
export class GpuParticles {
  private readonly emitters: GpuEmitter[];
  private pipes: { spawn: any; update: any; keys: any; sort: any; draw: Map<string, any>; layout: any } | null = null;
  private stages: { buffer: any; offsets: Map<number, number> } | null = null;
  private time = 0;

  constructor(
    private readonly device: any,
    private readonly colourFormat: string,
    specs: readonly EmitterSpec[],
    looks: readonly ({ atlas?: { width: number; height: number; data: Uint8ClampedArray }; motion?: { width: number; height: number; data: Uint8ClampedArray }; mesh?: ParticleMesh } | undefined)[] = [],
  ) {
    const texture = (image: { width: number; height: number; data: Uint8ClampedArray } | undefined, fallback: number[]) => {
      const w = image?.width ?? 1;
      const h = image?.height ?? 1;
      const t = device.createTexture({ size: { width: w, height: h }, format: "rgba8unorm", usage: 0x04 | 0x02 });
      const data = image ? new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength) : Uint8Array.from(fallback);
      device.queue.writeTexture({ texture: t }, data, { bytesPerRow: w * 4, rowsPerImage: h }, { width: w, height: h });
      return t;
    };
    this.emitters = specs.map((spec, i) => {
      const params = compileEmitter(spec);
      const look = looks[i];
      const sorted = !params.additive && params.render !== 2;
      let mesh: GpuEmitter["mesh"] = null;
      if (look?.mesh && params.render === 1) {
        const m = look.mesh;
        const interleaved = new Float32Array((m.positions.length / 3) * 6);
        for (let v = 0; v < m.positions.length / 3; v += 1) interleaved.set([...m.positions.subarray(v * 3, v * 3 + 3), ...m.normals.subarray(v * 3, v * 3 + 3)], v * 6);
        const vertices = device.createBuffer({ size: interleaved.byteLength, usage: 0x20 | 0x08 });
        device.queue.writeBuffer(vertices, 0, interleaved);
        const indices = device.createBuffer({ size: Math.max(4, m.indices.byteLength), usage: 0x10 | 0x08 });
        device.queue.writeBuffer(indices, 0, m.indices);
        mesh = { vertices, indices, count: m.indices.length };
      }
      // Every slot starts dead: age ≥ life.
      const initial = new Float32Array(params.capacity * PARTICLE_FLOATS);
      for (let s = 0; s < params.capacity; s += 1) initial[s * PARTICLE_FLOATS + 3] = 1;
      const particles = device.createBuffer({ size: initial.byteLength, usage: 0x80 | 0x08 | 0x04 });
      device.queue.writeBuffer(particles, 0, initial);
      return {
        spec,
        params,
        particles,
        requests: device.createBuffer({ size: MAX_SPAWN_REQUESTS * 48, usage: 0x80 | 0x08 }),
        uniform: device.createBuffer({ size: EMITTER_VEC4S * 16, usage: 0x40 | 0x08 }),
        look: device.createBuffer({ size: 144, usage: 0x40 | 0x08 }),
        pairs: sorted ? device.createBuffer({ size: params.capacity * 8, usage: 0x80 | 0x08 | 0x04 }) : null,
        atlas: texture(look?.atlas, [255, 255, 255, 255]),
        motion: texture(look?.motion, [128, 128, 0, 255]),
        head: 0,
        born: 0,
        carry: 0,
        pending: [],
        mesh,
      };
    });
  }

  /** An emitter's index by name, or −1. */
  indexOf(name: string): number {
    return this.emitters.findIndex((e) => e.spec.name === name);
  }

  /** Fire an emitter's burst at `at` toward `dir`, `scale` times its count. */
  burst(index: number, at: readonly number[], dir: readonly number[] = [0, 0, 0], scale = 1): void {
    const e = this.emitters[index];
    if (!e) return;
    const count = Math.max(1, Math.round(e.params.burst * Math.max(0, scale)));
    if (e.pending.length < MAX_SPAWN_REQUESTS - 1) e.pending.push({ at, dir, count: Math.min(count, e.params.capacity) });
  }

  /** Spawn `count` from an emitter (as its rate does), at `at`. */
  emit(index: number, count: number, at: readonly number[], dir: readonly number[] = [0, 0, 0]): void {
    const e = this.emitters[index];
    if (e && count > 0 && e.pending.length < MAX_SPAWN_REQUESTS - 1) e.pending.push({ at, dir, count: Math.min(count, e.params.capacity) });
  }

  /** Each emitter's ring: its particles buffer and capacity (for tests and the profiler). */
  ring(index: number): { buffer: any; capacity: number; born: number } | null {
    const e = this.emitters[index];
    return e ? { buffer: e.particles, capacity: e.params.capacity, born: e.born } : null;
  }

  /** Whether any emitter has particles or spawns to run. */
  get active(): boolean {
    return this.emitters.some((e) => e.born > 0 || e.pending.length > 0 || e.params.rate > 0);
  }

  private pipelines(): NonNullable<GpuParticles["pipes"]> {
    if (this.pipes) return this.pipes;
    const device = this.device;
    const compute = (code: string) => device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } });
    this.pipes = { spawn: compute(PARTICLE_SPAWN_WGSL), update: compute(PARTICLE_UPDATE_WGSL), keys: compute(PARTICLE_KEYS_WGSL), sort: compute(PARTICLE_SORT_WGSL), draw: new Map(), layout: null };
    return this.pipes;
  }

  /** The draw pipeline for a blend and a kind (sprite and ribbon, or mesh). */
  private drawPipeline(additive: boolean, mesh: boolean): any {
    const pipes = this.pipelines();
    const key = `${additive}:${mesh}`;
    let pipe = pipes.draw.get(key);
    if (pipe) return pipe;
    const device = this.device;
    const module = device.createShaderModule({ code: PARTICLE_DRAW_WGSL });
    const blend = additive
      ? { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } }
      : { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } };
    // One layout for sprites, ribbons and meshes: a mesh's shaders leave some bindings unused, which "auto" would drop.
    pipes.layout ??= device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 3, buffer: { type: "uniform" } },
        { binding: 1, visibility: 3, buffer: { type: "uniform" } },
        { binding: 2, visibility: 3, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: 3, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: 3, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: 3, texture: { sampleType: "float" } },
        { binding: 6, visibility: 3, texture: { sampleType: "float" } },
        { binding: 7, visibility: 3, sampler: { type: "filtering" } },
        { binding: 8, visibility: 3, texture: { sampleType: "depth" } },
      ],
    });
    pipe = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [pipes.layout] }),
      vertex: mesh
        ? { module, entryPoint: "vsMesh", buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" }] }] }
        : { module, entryPoint: "vs" },
      fragment: { module, entryPoint: mesh ? "fsMesh" : "fs", targets: [{ format: this.colourFormat, ...(mesh ? {} : { blend }) }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: false, depthCompare: "less-equal" },
    });
    pipes.draw.set(key, pipe);
    return pipe;
  }

  /** The bitonic stages' uniforms, one 256-byte slot each, for rings up to `n`. */
  private stageBuffer(n: number): NonNullable<GpuParticles["stages"]> {
    if (this.stages && this.stages.offsets.size >= bitonicStages(n).length) return this.stages;
    const all = bitonicStages(n);
    const data = new Uint32Array(all.length * 64);
    const offsets = new Map<number, number>();
    all.forEach(([k, j], s) => {
      data.set([k, j, 0, 0], s * 64);
      offsets.set(k * 65536 + j, s * 256);
    });
    const buffer = this.device.createBuffer({ size: data.byteLength, usage: 0x40 | 0x08 });
    this.device.queue.writeBuffer(buffer, 0, data);
    this.stages = { buffer, offsets };
    return this.stages;
  }

  /**
   * Simulate a frame (spawn, update, sort keys and sort) into `encoder`'s compute pass. `depth` and `gbuffer`
   * are the prepass's (for the depth collision).
   */
  simulate(encoder: any, frame: ParticleFrame, depth: any, gbuffer: any): void {
    const device = this.device;
    const pipes = this.pipelines();
    this.time += frame.dt;
    const pass = encoder.beginComputePass();
    for (const e of this.emitters) {
      // The rate's spawns, at the emitter's origin.
      e.carry += e.params.rate * frame.dt;
      const rated = Math.floor(e.carry);
      e.carry -= rated;
      if (rated > 0) e.pending.push({ at: [0, 0, 0], dir: [0, 0, 0], count: Math.min(rated, e.params.capacity) });
      const requests = e.pending.splice(0, MAX_SPAWN_REQUESTS);
      const data = new Float32Array(Math.max(1, requests.length) * 12);
      const bits = new Uint32Array(data.buffer);
      let total = 0;
      requests.forEach((r, k) => {
        data.set([r.at[0]!, r.at[1]!, r.at[2]!, r.count, r.dir[0]!, r.dir[1]!, r.dir[2]!, (e.head + total) % e.params.capacity], k * 12);
        bits[k * 12 + 8] = (e.born + total) >>> 0;
        total += r.count;
      });
      device.queue.writeBuffer(e.requests, 0, data);
      device.queue.writeBuffer(e.uniform, 0, packEmitter(e.params, { ...frame, requests: requests.length, spawnTotal: total }));
      const group = (pipe: any, entries: any[]) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: entries.map((resource, binding) => ({ binding, resource })) });
      if (total > 0) {
        pass.setPipeline(pipes.spawn);
        pass.setBindGroup(0, group(pipes.spawn, [{ buffer: e.uniform }, { buffer: e.particles }, { buffer: e.requests }]));
        pass.dispatchWorkgroups(Math.ceil(total / PARTICLE_WORKGROUP));
        e.head = (e.head + total) % e.params.capacity;
        e.born += total;
      }
      const groups = Math.ceil(e.params.capacity / PARTICLE_WORKGROUP);
      pass.setPipeline(pipes.update);
      pass.setBindGroup(0, group(pipes.update, [{ buffer: e.uniform }, { buffer: e.particles }, depth.createView(), gbuffer.createView()]));
      pass.dispatchWorkgroups(groups);
      if (e.pairs) {
        pass.setPipeline(pipes.keys);
        pass.setBindGroup(0, group(pipes.keys, [{ buffer: e.uniform }, { buffer: e.particles }, { buffer: e.pairs }]));
        pass.dispatchWorkgroups(groups);
        const stages = this.stageBuffer(e.params.capacity);
        pass.setPipeline(pipes.sort);
        for (const [k, j] of bitonicStages(e.params.capacity)) {
          const offset = stages.offsets.get(k * 65536 + j)!;
          pass.setBindGroup(0, group(pipes.sort, [{ buffer: stages.buffer, offset, size: 16 }, { buffer: e.pairs }]));
          pass.dispatchWorkgroups(groups);
        }
      }
    }
    pass.end();
  }

  /** Draw every emitter into an open render pass (colour and the scene's depths, read-only). */
  draw(pass: any, frame: ParticleFrame, lights: any, depth: any): void {
    const device = this.device;
    const sampler = (this.sampler ??= device.createSampler({ magFilter: "linear", minFilter: "linear" }));
    for (const e of this.emitters) {
      if (e.born === 0) continue;
      const mesh = e.params.render === 1 && e.mesh !== null;
      const pipe = this.drawPipeline(e.params.additive, mesh);
      device.queue.writeBuffer(e.look, 0, packLook(e.params, frame, frame.light, e.params.frames > 1, true));
      const entries = [{ buffer: e.uniform }, { buffer: e.look }, { buffer: e.particles }, { buffer: e.pairs ?? e.requests }, { buffer: lights }, e.atlas.createView(), e.motion.createView(), sampler, depth.createView()];
      pass.setPipeline(pipe);
      pass.setBindGroup(0, device.createBindGroup({ layout: this.pipelines().layout, entries: entries.map((resource, binding) => ({ binding, resource })) }));
      if (mesh) {
        pass.setVertexBuffer(0, e.mesh!.vertices);
        pass.setIndexBuffer(e.mesh!.indices, "uint32");
        pass.drawIndexed(e.mesh!.count, e.params.capacity);
      } else pass.draw(6, e.params.capacity);
    }
  }

  private sampler: any = null;

  dispose(): void {
    for (const e of this.emitters) for (const b of [e.particles, e.requests, e.uniform, e.look, e.pairs, e.atlas, e.motion, e.mesh?.vertices, e.mesh?.indices]) b?.destroy?.();
    this.stages?.buffer.destroy?.();
  }
}
