/**
 * The AAA tier's grade and display output (AAA_FIDELITY_ROADMAP.md F4d), in
 * WGSL for the presenter and TypeScript for the tests, term for term.
 *
 * - **The grade in log space.** The post stack's brightness, contrast and
 *   saturation work on the tone-mapped 8-bit frame, so contrast pivots on
 *   display 0.5 and pushes highlights into the clip. On a linear frame they
 *   run before the tone map instead: brightness as an exposure gain,
 *   saturation about the luma in linear light, and contrast in ACEScct's log
 *   encoding about 18% grey, where a stop is a stop at any brightness. A LUT
 *   stays where it was authored, on the display image after the tone map.
 * - **HDR output.** On a display that shows more than SDR white
 *   (`toneMapping: "extended"`), the curve rolls off to {@link HDR_HEADROOM}
 *   times SDR white instead of 1, exposed so 18% grey shows as it does in SDR:
 *   the picture is the same and its highlights go further.
 * - **Lens dirt.** Smudges on the lens that the bloom lights up: soft blobs
 *   at hashed places on a grid, a fixed pattern over the frame.
 */

import { toneMap, type ToneMapper } from "./toneMappers.js";

/** How many times SDR white the extended output's highlights reach (displays don't report their peak). */
export const HDR_HEADROOM = 3;

const CCT_CUT = 0.0078125;
const CCT_A = 10.5402377416545;
const CCT_B = 0.0729055341958355;

/** Linear to ACEScct, and back. */
export function toAcesCct(x: number): number {
  return x <= CCT_CUT ? CCT_A * x + CCT_B : (Math.log2(Math.max(x, 1e-10)) + 9.72) / 17.52;
}
export function fromAcesCct(y: number): number {
  return y <= CCT_A * CCT_CUT + CCT_B ? (y - CCT_B) / CCT_A : 2 ** (y * 17.52 - 9.72);
}

/** 18% grey in ACEScct: contrast's pivot. */
export const CCT_GREY = toAcesCct(0.18);

const luma = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

/** The grade on a linear colour (post stack semantics: 1 is neutral for all three). */
export function gradeLinear(c: readonly [number, number, number], brightness: number, contrast: number, saturation: number): [number, number, number] {
  const lit = c.map((x) => Math.max(0, x) * brightness);
  const y = luma(lit);
  const sat = lit.map((x) => Math.max(0, y + (x - y) * saturation));
  return sat.map((x) => fromAcesCct((toAcesCct(x) - CCT_GREY) * contrast + CCT_GREY)) as [number, number, number];
}

/**
 * The exposure that keeps 18% grey where SDR shows it when a curve's white is
 * moved to `headroom`: `headroom · curve(0.18 · s / headroom)` equals `curve(0.18)`.
 */
export function extendedExposure(mapper: ToneMapper, headroom = HDR_HEADROOM): number {
  const want = toneMap(mapper, [0.18, 0.18, 0.18])[1];
  let lo = 0.01;
  let hi = 100;
  for (let i = 0; i < 60; i += 1) {
    const mid = Math.sqrt(lo * hi);
    const got = headroom * toneMap(mapper, [(0.18 * mid) / headroom, (0.18 * mid) / headroom, (0.18 * mid) / headroom])[1];
    if (got < want) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

/** The extended output of a linear, exposed colour: display-linear, up to `headroom`. */
export function toneMapExtended(mapper: ToneMapper, c: readonly [number, number, number], headroom = HDR_HEADROOM): [number, number, number] {
  const s = extendedExposure(mapper, headroom);
  return toneMap(mapper, c.map((x) => (x * s) / headroom) as [number, number, number]).map((x) => x * headroom) as [number, number, number];
}

/** The WGSL: `gradeLinear`, the extended sRGB encode, and the lens dirt mask. */
export const GRADING_WGSL = /* wgsl */ `
fn toAcesCct(x: vec3f) -> vec3f {
  return select((log2(max(x, vec3f(1e-10))) + 9.72) / 17.52, ${CCT_A} * x + ${CCT_B}, x <= vec3f(${CCT_CUT}));
}
fn fromAcesCct(y: vec3f) -> vec3f {
  return select(exp2(y * 17.52 - 9.72), (y - ${CCT_B}) / ${CCT_A}, y <= vec3f(${CCT_A * CCT_CUT + CCT_B}));
}
fn gradeLinear(c: vec3f, brightness: f32, contrast: f32, saturation: f32) -> vec3f {
  let lit = max(c, vec3f(0.0)) * brightness;
  let y = dot(lit, vec3f(0.2126, 0.7152, 0.0722));
  let sat = max(vec3f(y) + (lit - vec3f(y)) * saturation, vec3f(0.0));
  return fromAcesCct((toAcesCct(sat) - ${CCT_GREY}) * contrast + ${CCT_GREY});
}
// The sRGB curve, extended past 1 for a display that shows more than SDR white.
fn toSrgbExtended(c: vec3f) -> vec3f {
  let v = max(c, vec3f(0.0));
  return select(1.055 * pow(v, vec3f(1.0 / 2.4)) - vec3f(0.055), v * 12.92, v <= vec3f(0.0031308));
}
fn dirtHash(p: vec2f) -> vec2f {
  let q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}
// Smudges on the lens: in each cell of a grid (two scales), a soft blob at a hashed place and size.
fn lensDirt(uv: vec2f, aspect: f32) -> f32 {
  var dirt = 0.0;
  for (var scale = 0; scale < 2; scale = scale + 1) {
    let cells = select(5.0, 11.0, scale == 1);
    let q = vec2f(uv.x * aspect, uv.y) * cells;
    let base = floor(q);
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      for (var dx = -1; dx <= 1; dx = dx + 1) {
        let cell = base + vec2f(f32(dx), f32(dy));
        let h = dirtHash(cell + f32(scale) * 17.0);
        let centre = cell + h;
        let radius = 0.25 + 0.45 * fract(h.x * 7.3 + h.y * 3.1);
        let d = length(q - centre) / radius;
        dirt = dirt + max(0.0, 1.0 - d * d) * (0.35 + 0.65 * fract(h.y * 5.7));
      }
    }
  }
  return min(dirt, 1.5);
}
`;
