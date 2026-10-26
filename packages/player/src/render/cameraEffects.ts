/**
 * The physical camera's effects on the AAA tier (AAA_FIDELITY_ROADMAP.md
 * F4c), on the resolved HDR frame after TAA (and the upscaler), before the
 * presenter's bloom and tone map: bokeh depth of field, then per-object
 * motion blur. The settings come from physicalCamera.ts in @cartbox/editor.
 *
 * - **Depth of field** (gather-based, at half resolution). Each pixel's circle
 *   of confusion comes from its depth by the thin lens: scale · (1 − focus /
 *   distance), negative in front of the focus. The half-resolution frame
 *   weights each pixel by its own blur, so what is in focus stays out of it and
 *   can't bleed back round itself. The gather walks a fixed set of
 *   taps over a disc as wide as the frame's largest blur, each tap reshaped to
 *   the aperture's polygon (its blades), and takes a tap where that tap's own
 *   blur reaches back to this pixel (scatter as gather), weighted by the
 *   inverse of its blur's area so a spread-out highlight keeps its energy. A
 *   tap behind this pixel spreads no further than this pixel's own blur, so a
 *   sharp foreground never takes the background's halo; one in front spreads
 *   freely, so a blurred near object bleeds over what is in focus behind it
 *   (the near field). The composite blends the sharp frame toward the gathered
 *   one by how blurred the pixel is, or how much the near field covers it.
 * - **Motion blur** (McGuire et al. 2012). The velocity buffer's motion, times
 *   the share of the frame the shutter is open, is reduced to its largest per
 *   16-pixel tile and then over each tile's neighbours. Each pixel gathers 12
 *   taps along that largest motion, centred on itself and jittered: a tap
 *   counts by its own motion's reach when it is in front of the pixel, and by
 *   the pixel's when behind, so a moving object smears over a still
 *   background and a still object in front of a moving one stays sharp.
 *
 * The scene may render smaller than it is shown (F4b): the depths and
 * velocities are read at the render's size, by the frame's UVs.
 */

/** The largest circle of confusion, as a share of the frame's width (beyond this the bokeh is clamped). */
export const DOF_MAX_COC = 0.025;
/** Tile size for the motion blur's largest motion, in pixels of the frame. */
export const MOTION_TILE = 16;
/** The longest a pixel blurs, in pixels of the frame. */
export const MOTION_MAX_PIXELS = 48;
/** Floats in the passes' uniforms. */
export const CAMERA_UNIFORM_FLOATS = 16;

/** What a frame's camera does (SceneDraw.camera). */
export interface CameraEffects {
  /** Depth of field: the circle of confusion's scale (a share of the frame's width), the distance in focus, and the aperture's blades (0 round). */
  readonly dof?: { readonly scale: number; readonly focus: number; readonly blades: number } | null;
  /** Motion blur: the share of each frame's motion the shutter takes in (times any strength). */
  readonly motionBlur?: { readonly fraction: number } | null;
}

/**
 * The passes' uniforms: [coc scale, focus, the largest coc in pixels, blades],
 * [depth → distance terms (d = y / (z + x)), the frame's width, height],
 * [the shutter's share, the tile, the longest blur in pixels, the frame's index],
 * [the render's width, height, 0, 0].
 */
export function cameraUniforms(effects: CameraEffects, depthTerms: readonly [number, number], frame: { width: number; height: number }, render: { width: number; height: number }, index: number, out: Float32Array<ArrayBuffer> = new Float32Array(CAMERA_UNIFORM_FLOATS)): Float32Array<ArrayBuffer> {
  const dof = effects.dof ?? null;
  out.set([dof?.scale ?? 0, dof?.focus ?? 1, Math.max(1, DOF_MAX_COC * frame.width), dof?.blades ?? 0], 0);
  out.set([depthTerms[0], depthTerms[1], frame.width, frame.height], 4);
  out.set([effects.motionBlur?.fraction ?? 0, MOTION_TILE, MOTION_MAX_PIXELS, index % 1024], 8);
  out.set([render.width, render.height, 0, 0], 12);
  return out;
}

/** The circle of confusion, in pixels of the frame, of a point `distance` away (the shaders' sum, for tests). */
export function cocPixels(scale: number, focus: number, distance: number, width: number): number {
  const coc = scale * (1 - focus / Math.max(distance, 1e-4)) * width;
  const max = Math.max(1, DOF_MAX_COC * width);
  return Math.max(-max, Math.min(max, coc));
}

const SHARED = (multisampled: boolean) => /* wgsl */ `
struct Camera { dof: vec4<f32>, frame: vec4<f32>, motion: vec4<f32>, render: vec4<f32> };
@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var depth: ${multisampled ? "texture_depth_multisampled_2d" : "texture_depth_2d"};

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

// The render's pixel under a point of the frame (in the frame's pixels).
fn renderPixel(q: vec2<f32>) -> vec2<i32> {
  let r = vec2<i32>(cam.render.xy);
  return clamp(vec2<i32>(q / cam.frame.zw * cam.render.xy), vec2<i32>(0), r - 1);
}
// The distance to what the frame shows at a point (in the frame's pixels); far for nothing drawn.
fn distanceAt(q: vec2<f32>) -> f32 {
  let z = textureLoad(depth, renderPixel(q), 0);
  if (z >= 1.0) { return 1e6; }
  return cam.frame.y / (z + cam.frame.x);
}
// The circle of confusion there, in the frame's pixels: negative in front of the focus.
fn cocAt(q: vec2<f32>) -> f32 {
  let coc = cam.dof.x * (1.0 - cam.dof.y / max(distanceAt(q), 1e-4)) * cam.frame.z;
  return clamp(coc, -cam.dof.z, cam.dof.z);
}
`;

/** Depth of field, pass 1 (half resolution): the frame averaged down, and its circle of confusion beside it. */
export function dofPrefilterWgsl(multisampled: boolean): string {
  return /* wgsl */ `${SHARED(multisampled)}
@group(0) @binding(2) var colour: texture_2d<f32>;
struct Out { @location(0) colour: vec4<f32>, @location(1) coc: vec4<f32> };
@fragment
fn prefilter(@builtin(position) frag: vec4<f32>) -> Out {
  let size = vec2<i32>(textureDimensions(colour));
  let p = vec2<i32>(frag.xy) * 2;
  var c = vec4<f32>(0.0);
  var total = 0.0;
  var coc = 0.0;
  for (var k = 0; k < 4; k += 1) {
    let q = min(p + vec2<i32>(k & 1, k >> 1), size - 1);
    // Each by its own blur: what is in focus stays out of the blurred frame, so it can't bleed back round itself.
    let qc = cocAt(vec2<f32>(q) + 0.5);
    let w = abs(qc) + 1e-3;
    c = c + textureLoad(colour, q, 0) * w;
    total = total + w;
    // The most blurred of the four's, sign and all.
    if (abs(qc) > abs(coc)) { coc = qc; }
  }
  return Out(c / total, vec4<f32>(coc * 0.5, 0.0, 0.0, 1.0));
}
`;
}

/** Depth of field, pass 2 (half resolution): the gather, into colour and the near field's cover. */
export const DOF_GATHER_WGSL = /* wgsl */ `
struct Camera { dof: vec4<f32>, frame: vec4<f32>, motion: vec4<f32>, render: vec4<f32> };
@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var halfColour: texture_2d<f32>;
@group(0) @binding(2) var halfCoc: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

// The aperture's polygon (n blades): how far its edge stands, at angle a, from a unit circle's.
fn blade(a: f32, n: f32) -> f32 {
  if (n < 2.5) { return 1.0; }
  let seg = 6.2831853 / n;
  let t = a - seg * floor(a / seg) - seg * 0.5;
  return cos(seg * 0.5) / cos(t);
}

struct Out { @location(0) colour: vec4<f32>, @location(1) near: vec4<f32> };
@fragment
fn gather(@builtin(position) frag: vec4<f32>) -> Out {
  let size = vec2<i32>(textureDimensions(halfColour));
  let p = vec2<i32>(frag.xy);
  let c0 = textureLoad(halfCoc, p, 0).r;
  let reach = cam.dof.z * 0.5;
  // The centre counts as one tap of its own blur.
  let own = max(abs(c0), 0.5);
  var sum = textureLoad(halfColour, p, 0) / (own * own);
  var weight = 1.0 / (own * own);
  var near = 0.0;
  var nearTaps = 0.0;
  // Three rings of 8, 16 and 24 taps out to the frame's largest blur.
  for (var ring = 1; ring <= 3; ring += 1) {
    let count = ring * 8;
    let r = f32(ring) / 3.0 * reach;
    for (var k = 0; k < count; k += 1) {
      let a = (f32(k) + 0.5 * f32(ring & 1)) / f32(count) * 6.2831853;
      let o = vec2<i32>(round(vec2<f32>(cos(a), sin(a)) * r * blade(a, cam.dof.w)));
      // Where the tap really landed: a whole texel off, or none.
      let dist = length(vec2<f32>(o));
      let q = clamp(p + o, vec2<i32>(0), size - 1);
      let s = textureLoad(halfColour, q, 0);
      let cs = textureLoad(halfCoc, q, 0).r;
      // How far this tap's blur reaches: no further than this pixel's own, from behind it.
      var spread = abs(cs);
      if (cs > c0) { spread = min(spread, max(abs(c0), 0.0)); }
      let w = clamp(spread - dist + 1.0, 0.0, 1.0) / max(spread * spread, 0.25);
      sum = sum + s * w;
      weight = weight + w;
      // The near field: taps in front of the focus whose blur reaches here.
      if (cs < -0.5) {
        near = near + clamp(-cs - dist + 1.0, 0.0, 1.0);
        nearTaps = nearTaps + 1.0;
      }
    }
  }
  let cover = select(0.0, clamp(near / max(nearTaps, 1.0) * 2.0, 0.0, 1.0), nearTaps > 0.0);
  return Out(sum / weight, vec4<f32>(cover, 0.0, 0.0, 1.0));
}
`;

/** Depth of field, pass 3: the sharp frame blended toward the gathered one by its blur, or the near field's cover. */
export function dofCompositeWgsl(multisampled: boolean): string {
  return /* wgsl */ `${SHARED(multisampled)}
@group(0) @binding(2) var colour: texture_2d<f32>;
@group(0) @binding(3) var blurred: texture_2d<f32>;
@group(0) @binding(4) var nearCover: texture_2d<f32>;
@group(0) @binding(5) var linearSamp: sampler;
@group(0) @binding(6) var halfCoc: texture_2d<f32>;
@fragment
fn composite(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(frag.xy);
  let sharp = textureLoad(colour, p, 0);
  let uv = frag.xy / cam.frame.zw;
  let signed = cocAt(frag.xy);
  let coc = abs(signed);
  // The four nearest half-resolution texels, bilinear, each by how alike its blur is to this pixel's: an
  // in-focus neighbour's texel doesn't bleed into the blurred pixel beside it.
  let half = vec2<i32>(textureDimensions(blurred));
  let f = frag.xy * 0.5 - 0.5;
  let base = vec2<i32>(floor(f));
  let t = f - floor(f);
  var soft = vec4<f32>(0.0);
  var total = 0.0;
  for (var k = 0; k < 4; k += 1) {
    let o = vec2<i32>(k & 1, k >> 1);
    let h = clamp(base + o, vec2<i32>(0), half - 1);
    let bil = select(1.0 - t.x, t.x, o.x == 1) * select(1.0 - t.y, t.y, o.y == 1);
    let alike = exp(-abs(textureLoad(halfCoc, h, 0).r * 2.0 - signed));
    let w = bil * alike + 1e-4 * bil;
    soft = soft + textureLoad(blurred, h, 0) * w;
    total = total + w;
  }
  soft = soft / total;
  let cover = textureSampleLevel(nearCover, linearSamp, uv, 0.0).r;
  let amount = max(smoothstep(0.5, 2.0, coc), cover);
  return mix(sharp, soft, amount);
}
`;
}

/** Motion blur, pass 1: each tile's largest motion (in the frame's pixels). */
export const MOTION_TILES_WGSL = /* wgsl */ `
struct Camera { dof: vec4<f32>, frame: vec4<f32>, motion: vec4<f32>, render: vec4<f32> };
@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var velocity: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment
fn tiles(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let tile = cam.motion.y;
  let rsize = vec2<i32>(cam.render.xy);
  // The tile's corners in the render's pixels; a stride keeps a large tile's reads in hand.
  let lo = vec2<i32>(floor(frag.xy - 0.5) * tile / cam.frame.zw * cam.render.xy);
  let hi = min(vec2<i32>(ceil((floor(frag.xy - 0.5) + 1.0) * tile / cam.frame.zw * cam.render.xy)), rsize);
  let stride = max(1, (hi.x - lo.x) / 8);
  var best = vec2<f32>(0.0);
  for (var y = lo.y; y < hi.y; y += stride) {
    for (var x = lo.x; x < hi.x; x += stride) {
      let v = textureLoad(velocity, vec2<i32>(x, y), 0).xy * cam.frame.zw * cam.motion.x;
      if (dot(v, v) > dot(best, best)) { best = v; }
    }
  }
  return vec4<f32>(best, 0.0, 1.0);
}
`;

/** Motion blur, pass 2: each tile's largest motion among its neighbours. */
export const MOTION_NEIGHBOURS_WGSL = /* wgsl */ `
@group(0) @binding(0) var tiles: texture_2d<f32>;
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment
fn neighbours(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(tiles));
  let p = vec2<i32>(frag.xy);
  var best = vec2<f32>(0.0);
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let v = textureLoad(tiles, clamp(p + vec2<i32>(x, y), vec2<i32>(0), size - 1), 0).xy;
      if (dot(v, v) > dot(best, best)) { best = v; }
    }
  }
  return vec4<f32>(best, 0.0, 1.0);
}
`;

/** Motion blur, pass 3: the gather along each tile neighbourhood's largest motion. */
export function motionGatherWgsl(multisampled: boolean): string {
  return /* wgsl */ `${SHARED(multisampled)}
@group(0) @binding(2) var colour: texture_2d<f32>;
@group(0) @binding(3) var velocity: texture_2d<f32>;
@group(0) @binding(4) var neighbourMax: texture_2d<f32>;

fn motionAt(q: vec2<f32>) -> vec2<f32> {
  let v = textureLoad(velocity, renderPixel(q), 0).xy * cam.frame.zw * cam.motion.x;
  let l = length(v);
  return select(v, v * (cam.motion.z / l), l > cam.motion.z);
}
// McGuire's cone: how much a sample whose motion reaches |v| pixels covers a point dist pixels off.
fn cone(dist: f32, v: f32) -> f32 { return clamp(1.0 - dist / max(v, 1e-3), 0.0, 1.0); }
fn cylinder(dist: f32, v: f32) -> f32 { return 1.0 - smoothstep(0.95 * v, 1.05 * v, dist); }
fn softDepth(a: f32, b: f32) -> f32 { return clamp(1.0 - (b - a) / max(0.01 * min(a, b), 0.05), 0.0, 1.0); }

@fragment
fn gather(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(colour));
  let p = vec2<i32>(frag.xy);
  let c = textureLoad(colour, p, 0);
  let tiles = vec2<i32>(textureDimensions(neighbourMax));
  var vmax = textureLoad(neighbourMax, min(p / i32(cam.motion.y), tiles - 1), 0).xy;
  let lmax = length(vmax);
  if (lmax < 0.5) { return c; }
  if (lmax > cam.motion.z) { vmax = vmax * (cam.motion.z / lmax); }
  let vc = length(motionAt(frag.xy));
  let zc = distanceAt(frag.xy);
  // The centre's own weight: as if it were a sample of its own motion.
  let own = 1.0 / max(vc, 1.0);
  var sum = c * own;
  var weight = own;
  let jitter = fract(52.9829189 * fract(dot(frag.xy + cam.motion.w * 5.588238, vec2<f32>(0.06711056, 0.00583715)))) - 0.5;
  for (var k = 0; k < 12; k += 1) {
    if (k == 6) { continue; }
    let t = mix(-0.5, 0.5, (f32(k) + jitter + 0.5) / 12.0);
    let q = clamp(frag.xy + vmax * t, vec2<f32>(0.5), vec2<f32>(size) - 0.5);
    let dist = length(vmax * t);
    let zs = distanceAt(q);
    let vs = length(motionAt(q));
    // In front of the centre: it smears by its own motion. Behind: the centre's motion reveals it.
    let front = softDepth(zc, zs);
    let back = softDepth(zs, zc);
    let w = front * cone(dist, vs) + back * cone(dist, vc) + cylinder(dist, vs) * cylinder(dist, vc) * 2.0;
    sum = sum + textureLoad(colour, vec2<i32>(q), 0) * w;
    weight = weight + w;
  }
  return sum / weight;
}
`;
}
