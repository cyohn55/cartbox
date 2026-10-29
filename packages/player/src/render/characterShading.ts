/**
 * Character shading on the linear-light renderer (AAA_FIDELITY_ROADMAP.md
 * F7c): the WGSL for skin, eyes, hair and the mouth, which the scene shader
 * calls where it lights a surface whose material has a `character`
 * (characterShading.ts in @cartbox/editor, whose functions these mirror term
 * for term). The uniform's `char0..char1` carry it (see scenePacking.ts):
 *
 * - skin  (1): char0 = (1, the second lobe's share, the lobes' roughness scales); char1 = (micro-normal tiling, its strength, cavity)
 * - eye   (2): char0 = (2, iris radius, iris depth, cornea IOR); char1 = (limbus width, caustic)
 * - hair  (3): char0 = (3, shift, secondary shift, scatter); char1 = (1 when its alpha dithers, the frame for the dither)
 * - mouth (4): char0 = (4, occlusion, how open, depth); char1 = the opening (the mesh's space)
 */

import { characterKindCode, type ResolvedCharacter } from "@cartbox/editor";

/** A material's character into its two uniform vec4s; zeros for none. `frame` moves a hair's dither. */
export function packCharacter(c: ResolvedCharacter | null, dither: boolean, frame: number): [number[], number[]] {
  if (!c) return [[0, 0, 0, 0], [0, 0, 0, 0]];
  const code = characterKindCode(c.kind);
  switch (c.kind) {
    case "skin":
      return [[code, c.lobeMix, c.lobeRoughness[0], c.lobeRoughness[1]], [c.microScale, c.microStrength, c.cavity, 0]];
    case "eye":
      return [[code, c.irisRadius, c.irisDepth, c.corneaIor], [c.limbus, c.caustic, 0, 0]];
    case "hair":
      return [[code, c.shift, c.secondaryShift, c.scatter], [dither ? 1 : 0, frame % 64, 0, 0]];
    case "mouth":
      return [[code, c.occlusion, c.open, c.depth], [c.opening[0], c.opening[1], c.opening[2], 0]];
  }
}

/**
 * The helpers, after the uniform struct (they read `u`). The scene shader
 * sets the private state in its fragment stage: `charT` (a hair's strand
 * tangent, or an eye's U tangent), `charB` (the eye's V tangent), `charMask`
 * (how much is iris), `charFwd` (the eye's axis), `charOff` (the point's
 * offset from the pupil, world), `charSpec` (what the specular keeps: a
 * skin's cavities, a mouth's depth) and `charLit` (what all the light keeps).
 */
export const CHARACTER_WGSL = /* wgsl */ `
var<private> charT: vec3<f32>;
var<private> charB: vec3<f32>;
var<private> charMask: f32 = 0.0;
var<private> charR: f32 = 0.0;
var<private> charFwd: vec3<f32>;
var<private> charOff: vec3<f32>;
var<private> charSpec: f32 = 1.0;
var<private> charLit: f32 = 1.0;

fn charKind() -> i32 { return i32(u.char0.x + 0.5); }

fn charHash(p: vec2<f32>) -> f32 { return fract(sin(p.x * 127.1 + p.y * 311.7) * 43758.5453); }
fn charNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = p - i;
  let s = f * f * (vec2<f32>(3.0) - 2.0 * f);
  let a = charHash(i);
  let b = charHash(i + vec2<f32>(1.0, 0.0));
  let c = charHash(i + vec2<f32>(0.0, 1.0));
  let d = charHash(i + vec2<f32>(1.0, 1.0));
  return a + (b - a) * s.x + (c - a) * s.y + (a - b - c + d) * s.x * s.y;
}
// A skin's pores: the noise's slope in tangent space (microTilt).
fn charMicroTilt(uv: vec2<f32>) -> vec2<f32> {
  let p = uv * u.char1.x;
  let e = 0.25;
  let du = charNoise(p + vec2<f32>(e, 0.0)) - charNoise(p - vec2<f32>(e, 0.0));
  let dv = charNoise(p + vec2<f32>(0.0, e)) - charNoise(p - vec2<f32>(0.0, e));
  return -vec2<f32>(du, dv) * u.char1.y;
}

fn charGgx(ndh: f32, rough: f32) -> f32 {
  let a2 = rough * rough * rough * rough;
  let d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d + 1e-7);
}
// Skin's two lobes (dualLobeD).
fn charDualLobe(ndh: f32, rough: f32) -> f32 {
  let r0 = clamp(rough * u.char0.z, 0.045, 1.0);
  let r1 = clamp(rough * u.char0.w, 0.045, 1.0);
  return mix(charGgx(ndh, r0), charGgx(ndh, r1), u.char0.y);
}

// The eye (irisMask, limbusShade).
fn charIrisMask(r: f32) -> f32 {
  let w = max(u.char1.x, 1e-4);
  let t = clamp((u.char0.y - r) / w + 0.5, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn charLimbus(r: f32) -> f32 {
  if (u.char1.x <= 0.0) { return 1.0; }
  let t = clamp(1.0 - abs(r - u.char0.y) / u.char1.x, 0.0, 1.0);
  return 1.0 - 0.65 * t * t;
}
// Where the iris is seen through the cornea (irisParallax): the offset in UV.
fn charIrisParallax(V: vec3<f32>, N: vec3<f32>) -> vec2<f32> {
  var into = refract(-V, N, 1.0 / u.char0.w);
  if (dot(into, into) < 1e-8) { into = -charFwd; }
  let down = max(0.2, -dot(into, charFwd));
  let t = u.char0.z / down;
  return vec2<f32>(t * dot(into, charT), t * dot(into, charB));
}
// The iris's light (irisLight): refracted onto its plane, gathered on the far side.
fn charIrisLight(Ld: vec3<f32>, N: vec3<f32>) -> f32 {
  let into = refract(-Ld, N, 1.0 / u.char0.w);
  if (dot(into, into) < 1e-8) { return 0.0; }
  let ndl = max(0.0, -dot(into, charFwd));
  let side = dot(into, charOff);
  return ndl * (1.0 + u.char1.y * max(0.0, side) * 4.0);
}

// Hair (kajiyaKay, shiftTangent, hairExponent, hairScatter).
fn charKajiya(tdh: f32, e: f32) -> f32 {
  let s = sqrt(max(0.0, 1.0 - tdh * tdh));
  return (e + 2.0) / 6.28318531 * pow(s, e);
}
fn charHairExponent(rough: f32) -> f32 {
  let a = max(0.045, rough) * max(0.045, rough);
  return max(2.0, 2.0 / (a * a) - 2.0);
}
// Whether a hair texel survives the frame's dither (ditherKeeps): TAA averages the frames into its alpha.
fn charDitherKeeps(alpha: f32, pixel: vec2<f32>) -> bool {
  let shift = u.char1.y * 5.588238;
  let threshold = fract(52.9829189 * fract((pixel.x + shift) * 0.06711056 + (pixel.y + shift) * 0.00583715));
  return alpha > threshold;
}

// The mouth (mouthOcclusion): darker deeper behind the opening, less so the wider it opens.
fn charMouth(objPos: vec3<f32>) -> f32 {
  let t = clamp(length(objPos - u.char1.xyz) / max(u.char0.w, 1e-4), 0.0, 1.0);
  let s = t * t * (3.0 - 2.0 * t);
  return 1.0 - u.char0.y * (1.0 - 0.6 * u.char0.z) * s;
}

/**
 * One light on a character surface, for unit radiance (the caller scales it
 * by the light's colour, intensity, falloff and shadow): the reflection and
 * the diffuse, cosine included. \`kdm\` is the diffuse's share; the diffuse
 * it adds goes to \`diffuseLit\` for the scattering pass.
 */
fn charLight(Ld: vec3<f32>, N: vec3<f32>, V: vec3<f32>, ndv: f32, rough: f32, f0: vec3<f32>, kdm: f32, albedo: vec3<f32>) -> vec3<f32> {
  let kind = charKind();
  let ndl = dot(N, Ld);
  let H = normalize(Ld + V);
  let vdh = max(0.0, dot(V, H));
  let F = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - vdh, 5.0);
  if (kind == 3) {
    // Hair: a wrapped diffuse, Kajiya-Kay's two shifted lobes (R white toward the tip, TRT coloured and
    // broader toward the root), faded as the light goes behind, and the light through it from behind (TT).
    let wrap = max(0.0, 0.25 + 0.75 * ndl);
    let e = charHairExponent(rough);
    let t1 = normalize(charT + u.char0.y * N);
    let t2 = normalize(charT + u.char0.z * N);
    let r = charKajiya(dot(t1, H), e);
    let trt = charKajiya(dot(t2, H), e * 0.25);
    let facing = smoothstep(-0.1, 0.25, ndl);
    let tt = u.char0.w * pow(max(0.0, -dot(Ld, V)), 4.0);
    let diffuse = kdm * albedo * wrap;
    diffuseLit = diffuseLit + diffuse;
    return diffuse + (F * r + F * trt * albedo) * facing * charSpec + albedo * tt;
  }
  if (ndl <= 0.0) { return vec3<f32>(0.0); }
  let ndh = max(0.0, dot(N, H));
  let a2 = rough * rough * rough * rough;
  var D = charGgx(ndh, rough);
  if (kind == 1) { D = charDualLobe(ndh, rough); }
  let spec = F * D * smithVisibility(ndl, ndv, a2) * 3.14159265 * eComp * charSpec;
  var diffuse = kdm * (vec3<f32>(1.0) - F) * albedo;
  var cosine = ndl;
  // The iris takes its light through the cornea.
  if (kind == 2) { cosine = mix(ndl, charIrisLight(Ld, N), charMask); }
  diffuseLit = diffuseLit + diffuse * cosine * charLit;
  return (diffuse * cosine + spec * ndl) * charLit;
}
`;

