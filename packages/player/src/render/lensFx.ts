/**
 * The lens pass (AAA_FIDELITY_ROADMAP.md F4e-2): the post stack's effects that
 * sample the frame and gather its bright light, run on the AAA tier's linear
 * frame before the tone map instead of on the display image after it.
 *
 * On the display image a light of 40 and one of 1.2 have both clipped to
 * white, so they streak, ray and blur the same; a highlight blurred by the
 * tilt-shift spreads its clipped value, not its light. In linear light they
 * keep what they are: the brighter light streaks harder, and a defocused
 * highlight stays bright (a bokeh), before the curve rolls it all off once.
 *
 * - **The same effects, word for word:** aberration, tilt-shift, the
 *   wet-floor reflection, god rays and streaks are the display stack's own
 *   WGSL (gpuPostFx.ts), in its order, reading the same uniforms.
 * - **The same pixels gather, and a clipped light as bright as it is.** The
 *   bright pass picks a pixel by how bright it shows (graded and through the
 *   scene's curve, as the display stack saw it), against the same threshold.
 *   What it gathers is what it showed, until that nears white
 *   ({@link CLIP_KNEE}); past that, the pixel as an HDR display shows it (the
 *   curve rolled off at the headroom), so a light of 40 gathers more than
 *   one of 2 where both had clipped to white, up to the headroom.
 * - **Gathered in display units.** God rays and streaks were authored as
 *   light added over the display image, so they go into a glare target that
 *   the tone map adds after its curve. Added as light before it, even a dim
 *   light's streak would show far brighter.
 * - **The screen's own shape stays in display space.** When the kaleidoscope
 *   folds the screen or the CRT bends it, the scanlines, dither and the rest
 *   follow that shape; then every effect stays in the display stack, as it
 *   was, so those looks are unchanged.
 */

import { ABERRATION_WGSL, GOD_RAYS_WGSL, POST_HELPERS_WGSL, POST_STRUCT_WGSL, REFLECTION_WGSL, STREAKS_WGSL, TILT_SHIFT_WGSL } from "../fx/gpuPostFx.js";
import type { PostFxUniforms } from "../fx/postfx.js";
import { GRADING_WGSL } from "./grading.js";
import { TONE_MAPPERS_WGSL } from "./toneMappers.js";

/** The effects the lens pass takes from the display stack, and what turns each off there. */
const LENS_OFF = { aberration: 0, tiltStrength: 0, reflectionStrength: 0, godrayStrength: 0, streakStrength: 0 } as const;

/**
 * A linear frame's post stack split in two: whether the lens pass runs, and
 * the stack the display pass runs after the tone map (the lens effects off
 * when the lens pass has them).
 */
export function splitLens(u: PostFxUniforms): { readonly lens: boolean; readonly display: PostFxUniforms } {
  const shaped = u.kaleidoSegments >= 2 || u.curvature > 0;
  const any = u.aberration !== 0 || u.tiltStrength > 0 || u.reflectionStrength > 0 || u.godrayStrength > 0 || u.streakStrength > 0;
  return shaped || !any ? { lens: false, display: u } : { lens: true, display: { ...u, ...LENS_OFF } };
}

/** How near white (in display terms) a gathered light starts to gather what an HDR display shows instead. */
export const CLIP_KNEE = 0.9;

/** Floats in the lens pass's own block: how a pixel will show (see {@link packLensShown}). */
export const LENS_SHOWN_FLOATS = 12;

/**
 * How the presenter will show a linear pixel, for the bright pass to pick by:
 * `[exposure, curve, tone-mapped, graded]`, `[brightness, contrast,
 * saturation, 1 when the curve maps as authored (F11a-5)]`, then `[the
 * exposure keeping grey on an HDR display, its headroom, 0, 0]`: the compose
 * pass's own values (gpuPresent.ts).
 */
export function packLensShown(
  exposure: number,
  curve: number,
  toneMapped: boolean,
  grade: { readonly brightness: number; readonly contrast: number; readonly saturation: number } | null,
  extendedExposure: number,
  headroom: number,
  out = new Float32Array(LENS_SHOWN_FLOATS),
  authored = false,
): Float32Array {
  out.set([exposure, curve, toneMapped ? 1 : 0, grade ? 1 : 0, grade?.brightness ?? 1, grade?.contrast ?? 1, grade?.saturation ?? 1, authored ? 1 : 0, extendedExposure, headroom, 0, 0]);
  return out;
}

/**
 * The lens pass: the linear frame (binding 1) through the sampling effects
 * into a linear target (location 0), and its god rays and streaks gathered
 * in display units into the glare (location 1).
 */
export const LENS_WGSL = /* wgsl */ `
${POST_STRUCT_WGSL}@group(0) @binding(0) var<uniform> u: Post;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var nearestClamp: sampler;
@group(0) @binding(3) var<uniform> shown: array<vec4f, 3>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let x = f32((i << 1u) & 2u);
  let y = f32(i & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}
const TAU = 6.2831853;

fn src(uv: vec2f) -> vec3f { return textureSampleLevel(source, nearestClamp, uv, 0.0).rgb; }
${POST_HELPERS_WGSL}${TONE_MAPPERS_WGSL}
${GRADING_WGSL}
fn toSrgb(c: vec3f) -> vec3f {
  let v = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(v, vec3f(1.0 / 2.4)) - vec3f(0.055), v * 12.92, v <= vec3f(0.0031308));
}
fn graded(c: vec3f) -> vec3f {
  if (shown[0].w > 0.5) { return gradeLinear(c, shown[1].x, shown[1].y, shown[1].z); }
  return c;
}
// The pixel as an SDR display shows it: graded, through the curve (physically or as authored, F11a-5), encoded.
fn display(c: vec3f) -> vec3f {
  let rgb = graded(c);
  if (shown[0].z > 0.5) { return clamp(shownWith(shown[0].y, rgb, shown[0].x, shown[1].w > 0.5), vec3f(0.0), vec3f(1.0)); }
  return toSrgb(rgb);
}
// …and as an HDR display shows it: the curve's white at the headroom, grey where SDR shows it.
fn displayHdr(c: vec3f) -> vec3f {
  let rgb = graded(c);
  let headroom = shown[2].y;
  if (shown[0].z > 0.5) { return shownWideWith(shown[0].y, rgb, shown[0].x, shown[2].x, headroom, shown[1].w > 0.5); }
  return toSrgbExtended(clamp(rgb, vec3f(0.0), vec3f(headroom)));
}
// Picked by how bright it shows, as the display stack picks. What it gives is
// what it showed, until it clips: from 0.9 of white, what an HDR display shows.
fn brightPass(uv: vec2f) -> vec3f {
  let c = src(uv);
  let sdr = display(c);
  let gathered = mix(sdr, displayHdr(c), glslSmoothstep(${CLIP_KNEE}, 1.0, luma(sdr)));
  return gathered * glslSmoothstep(u.fog2.z, 1.0, luma(sdr));
}
struct Lensed {
  @location(0) light: vec4f,
  @location(1) glare: vec4f,
};

@fragment fn lens(@builtin(position) pos: vec4f) -> Lensed {
  let size = u.size.xy;
  let uv = pos.xy / size;
  let centered = uv - 0.5;
${ABERRATION_WGSL}
${TILT_SHIFT_WGSL}
${REFLECTION_WGSL}
  // The sampled light is done; the gathers add into the glare, in display units.
  let light = vec4f(max(color, vec3f(0.0)), textureSampleLevel(source, nearestClamp, uv, 0.0).a);
  color = vec3f(0.0);
${GOD_RAYS_WGSL}
${STREAKS_WGSL}
  return Lensed(light, vec4f(color, 0.0));
}
`;
