/**
 * Projected decals on the AAA tier's GPU (AAA_FIDELITY_ROADMAP.md F1f; see
 * projectedDecals.ts in @cartbox/editor): the frame's boxes and every decal's
 * tiles in one storage buffer, which the linear-light shader reads before it
 * lights a surface. The fragment stage's sampled textures are all bound, so
 * the tiles are read from the buffer and filtered by hand, as the DFG and LTC
 * tables are.
 *
 * The buffer, in u32s:
 * - **header**: the box count, a tile's side, where the tiles start, 0;
 * - **boxes**: {@link DECAL_WORDS} apiece, up to {@link MAX_GPU_DECALS}, the nearest
 *   the camera. Three rows take a world point into the box (−1..1 inside):
 *   each a half-axis over its length², and minus its dot with the centre. A
 *   fourth is the tile, what is left of the mark, and its glow; a fifth the
 *   surface's normal (the box's third axis) for the angle fade;
 * - **tiles**: each texel's colour (RGBA8, coverage in alpha) and surface
 *   (normal x and y encoded, roughness, occlusion), interleaved, tile after tile.
 */

import { MAX_DECAL_DEFS, type DecalTiles, type ProjectedDecal } from "@cartbox/editor";

/** Boxes the shader takes a frame: the nearest the camera. */
export const MAX_GPU_DECALS = 256;
/** u32s a box takes: five vec4s. */
export const DECAL_WORDS = 20;
const HEADER = 4;
/** The tile side the buffer is laid out for (the editor's DECAL_TILE). */
export const GPU_DECAL_TILE = 64;
/** Where the tiles start, and the buffer's size: header, every box, every decal's tile. */
export const DECAL_TILES_AT = HEADER + MAX_GPU_DECALS * DECAL_WORDS;
export const DECAL_BUFFER_WORDS = DECAL_TILES_AT + MAX_DECAL_DEFS * GPU_DECAL_TILE * GPU_DECAL_TILE * 2;

/** The header and boxes (the buffer's head): the nearest {@link MAX_GPU_DECALS} to `eye`, kept in their order. */
export function packDecalBoxes(decals: readonly ProjectedDecal[], eye: readonly [number, number, number]): Uint32Array {
  let kept = decals;
  if (decals.length > MAX_GPU_DECALS) {
    const far = (d: ProjectedDecal) => (d.center[0] - eye[0]) ** 2 + (d.center[1] - eye[1]) ** 2 + (d.center[2] - eye[2]) ** 2;
    const cut = [...decals].map(far).sort((a, b) => a - b)[MAX_GPU_DECALS - 1]!;
    let room = MAX_GPU_DECALS;
    kept = decals.filter((d) => far(d) <= cut && room-- > 0);
  }
  const words = new Uint32Array(HEADER + kept.length * DECAL_WORDS);
  const floats = new Float32Array(words.buffer);
  words[0] = kept.length;
  words[1] = GPU_DECAL_TILE;
  words[2] = DECAL_TILES_AT;
  kept.forEach((d, i) => {
    const o = HEADER + i * DECAL_WORDS;
    d.axes.forEach((a, r) => {
      const l2 = a[0] * a[0] + a[1] * a[1] + a[2] * a[2] || 1;
      floats[o + r * 4] = a[0] / l2;
      floats[o + r * 4 + 1] = a[1] / l2;
      floats[o + r * 4 + 2] = a[2] / l2;
      floats[o + r * 4 + 3] = -(a[0] * d.center[0] + a[1] * d.center[1] + a[2] * d.center[2]) / l2;
    });
    floats[o + 12] = d.tile;
    floats[o + 13] = Math.max(0, Math.min(1, d.alpha));
    floats[o + 14] = d.glow;
    const z = d.axes[2];
    const zl = Math.hypot(z[0], z[1], z[2]) || 1;
    floats[o + 16] = z[0] / zl;
    floats[o + 17] = z[1] / zl;
    floats[o + 18] = z[2] / zl;
  });
  return words;
}

/** The tiles as the buffer holds them (from DECAL_TILES_AT): colour and surface interleaved, texel by texel. */
export function packDecalTiles(tiles: DecalTiles): Uint32Array {
  if (tiles.size !== GPU_DECAL_TILE) throw new Error(`decal tiles are ${tiles.size}², the buffer is laid out for ${GPU_DECAL_TILE}²`);
  const texels = Math.min(tiles.count, MAX_DECAL_DEFS) * tiles.size * tiles.size;
  const out = new Uint32Array(texels * 2);
  const c = tiles.colour;
  const s = tiles.surface;
  for (let i = 0; i < texels; i += 1) {
    out[i * 2] = (c[i * 4]! | (c[i * 4 + 1]! << 8) | (c[i * 4 + 2]! << 16) | (c[i * 4 + 3]! << 24)) >>> 0;
    out[i * 2 + 1] = (s[i * 4]! | (s[i * 4 + 1]! << 8) | (s[i * 4 + 2]! << 16) | (s[i * 4 + 3]! << 24)) >>> 0;
  }
  return out;
}

/**
 * The WGSL the linear-light shader declares: the buffer's binding and
 * `applyDecals`, which lays the frame's boxes over a surface before it is lit.
 */
export function decalWgsl(group: number, binding: number): string {
  return /* wgsl */ `
// Projected decals (F1f, decalBuffer.ts): the boxes and their tiles, in one buffer.
@group(${group}) @binding(${binding}) var<storage, read> decalData: array<u32>;
struct Decalled { albedo: vec3<f32>, rough: f32, ao: f32, metallic: f32, N: vec3<f32>, glow: vec3<f32> };
fn decalWord(i: u32) -> f32 { return bitcast<f32>(decalData[i]); }
fn decalRow(i: u32) -> vec4<f32> { return vec4<f32>(decalWord(i), decalWord(i + 1u), decalWord(i + 2u), decalWord(i + 3u)); }
// A tile's colour and surface at uv (0..1), bilinearly between texel centres.
fn decalSample(tile: u32, uv: vec2<f32>) -> array<vec4<f32>, 2> {
  let n = decalData[1];
  let base = decalData[2] + tile * n * n * 2u;
  let p = clamp(uv * f32(n) - 0.5, vec2<f32>(0.0), vec2<f32>(f32(n - 1u)));
  let p0 = vec2<u32>(p);
  let p1 = min(p0 + 1u, vec2<u32>(n - 1u));
  let f = p - vec2<f32>(p0);
  var out: array<vec4<f32>, 2>;
  for (var k = 0u; k < 2u; k = k + 1u) {
    let a = unpack4x8unorm(decalData[base + (p0.y * n + p0.x) * 2u + k]);
    let b = unpack4x8unorm(decalData[base + (p0.y * n + p1.x) * 2u + k]);
    let c = unpack4x8unorm(decalData[base + (p1.y * n + p0.x) * 2u + k]);
    let d = unpack4x8unorm(decalData[base + (p1.y * n + p1.x) * 2u + k]);
    out[k] = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  return out;
}
// Every box round P, in order, over the surface: its colour by its coverage (faded as the surface turns from
// the box's normal, toward the box's depth, and as the mark fades), its roughness, occlusion, relief and glow.
fn applyDecals(P: vec3<f32>, s: Decalled) -> Decalled {
  var o = s;
  let count = decalData[0];
  for (var i = 0u; i < count; i = i + 1u) {
    let at = 4u + i * ${DECAL_WORDS}u;
    let rx = decalRow(at);
    let ry = decalRow(at + 4u);
    let rz = decalRow(at + 8u);
    let q = vec3<f32>(dot(rx.xyz, P) + rx.w, dot(ry.xyz, P) + ry.w, dot(rz.xyz, P) + rz.w);
    if (any(abs(q) > vec3<f32>(1.0))) { continue; }
    let info = decalRow(at + 12u);
    let nz = decalRow(at + 16u).xyz;
    let facing = smoothstep(0.15, 0.45, dot(o.N, nz));
    let depth = 1.0 - smoothstep(0.6, 1.0, abs(q.z));
    let fade = facing * depth * info.y;
    if (fade <= 0.0) { continue; }
    let t = decalSample(u32(info.x + 0.5), q.xy * 0.5 + vec2<f32>(0.5));
    let a = t[0].a * fade;
    if (a <= 0.0) { continue; }
    let colour = toLinear(t[0].rgb);
    o.albedo = mix(o.albedo, colour, a);
    o.rough = mix(o.rough, max(t[1].z, 0.045), a);
    o.metallic = mix(o.metallic, 0.0, a);
    o.ao = o.ao * mix(1.0, t[1].w, a);
    // The relief, in the box's frame: across, along, out of the surface.
    let lean = t[1].xy * 2.0 - vec2<f32>(1.0);
    let bent = normalize(o.N + normalize(rx.xyz) * lean.x + normalize(ry.xyz) * lean.y);
    o.N = normalize(mix(o.N, bent, a));
    o.glow = o.glow + colour * info.z * a;
  }
  return o;
}
`;
}
