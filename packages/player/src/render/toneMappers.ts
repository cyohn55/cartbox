/**
 * The AAA tier's tone mappers (AAA_FIDELITY_ROADMAP.md F4d): the curve that
 * takes the linear HDR frame, exposed, into the display's 0..1, chosen per
 * scene (`SceneLighting.tonemapper`). Each is here twice, as WGSL for the
 * presenter and as TypeScript for the tests, term for term.
 *
 * - **filmic**: Narkowicz's fit of the ACES curve, per channel: what every
 *   tier has used since F0b, and still the default, so a scene looks as it did.
 * - **aces**: Hill's fit of the ACES RRT and ODT, through the AP1 working
 *   space: the reference ACES look, desaturating highlights toward white.
 * - **agx**: Sobotka's AgX (Wrensch's minimal fit), which compresses in a
 *   log space rotated off the primaries, so a saturated light goes to white
 *   without the hue skew per-channel curves give it.
 * - **neutral**: Khronos PBR Neutral, which leaves colours under 0.76 as
 *   they are (so a material's base colour shows as authored) and rolls off
 *   above it.
 *
 * Each maps in one of two domains (F11a-5). **Physical**: the curve on the
 * exposed light, then the sRGB encode, as a linear pipeline does. **As
 * authored**: the curve on the light's sRGB encoding, as the byte path's
 * shader maps its display-space shading, so a map tuned there shows as tuned;
 * its shadows and midtones lift and its highlights hold lower.
 */

/** The curves, in the order the presenter's uniform names them. */
export const TONE_MAPPERS = ["filmic", "aces", "agx", "neutral"] as const;
export type ToneMapper = (typeof TONE_MAPPERS)[number];

type Rgb = [number, number, number];

/** Multiply a row-major 3×3 into a colour. */
function mul(m: readonly number[], c: readonly number[]): Rgb {
  return [m[0]! * c[0]! + m[1]! * c[1]! + m[2]! * c[2]!, m[3]! * c[0]! + m[4]! * c[1]! + m[5]! * c[2]!, m[6]! * c[0]! + m[7]! * c[1]! + m[8]! * c[2]!];
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function filmic(c: readonly number[]): Rgb {
  return c.map((x) => {
    const v = Math.max(0, x);
    return clamp01((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14));
  }) as Rgb;
}

const ACES_IN = [0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777];
const ACES_OUT = [1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602];
function aces(c: readonly number[]): Rgb {
  const v = mul(ACES_IN, c.map((x) => Math.max(0, x)));
  const fit = v.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081));
  return mul(ACES_OUT, fit).map(clamp01) as Rgb;
}

// AgX's inset and outset, row-major (the transposes of the column-major GLSL ones).
const AGX_IN = [0.842479062253094, 0.0784335999999992, 0.0792237451477643, 0.0423282422610123, 0.878468636469772, 0.0791661274605434, 0.0423756549057051, 0.0784336, 0.879142973793104];
const AGX_OUT = [1.19687900512017, -0.0980208811401368, -0.0990297440797205, -0.0528968517574562, 1.15190312990417, -0.0989611768448433, -0.0529716355144438, -0.0980434501171241, 1.15107367264116];
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;
function agx(c: readonly number[]): Rgb {
  const v = mul(AGX_IN, c.map((x) => Math.max(1e-10, x)));
  const curve = v.map((x) => {
    const t = (Math.min(AGX_MAX_EV, Math.max(AGX_MIN_EV, Math.log2(x))) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
    const t2 = t * t;
    const t4 = t2 * t2;
    return 15.5 * t4 * t2 - 40.14 * t4 * t + 31.96 * t4 - 6.868 * t2 * t + 0.4298 * t2 + 0.1191 * t - 0.00232;
  });
  // Out of AgX's space, then its display curve back to linear light.
  return mul(AGX_OUT, curve).map((x) => clamp01(Math.max(0, x) ** 2.2)) as Rgb;
}

const NEUTRAL_START = 0.8 - 0.04;
const NEUTRAL_DESATURATION = 0.15;
function neutral(c: readonly number[]): Rgb {
  let rgb = c.map((x) => Math.max(0, x)) as Rgb;
  const low = Math.min(...rgb);
  const offset = low < 0.08 ? low - 6.25 * low * low : 0.04;
  rgb = rgb.map((x) => x - offset) as Rgb;
  const peak = Math.max(...rgb);
  if (peak < NEUTRAL_START) return rgb.map(clamp01) as Rgb;
  const d = 1 - NEUTRAL_START;
  const newPeak = 1 - (d * d) / (peak + d - NEUTRAL_START);
  rgb = rgb.map((x) => (x * newPeak) / peak) as Rgb;
  const g = 1 - 1 / (NEUTRAL_DESATURATION * (peak - newPeak) + 1);
  return rgb.map((x) => clamp01(x + (newPeak - x) * g)) as Rgb;
}

/** A linear, exposed colour through `mapper`, as the presenter maps it: display-linear 0..1, before the sRGB encode. */
export function toneMap(mapper: ToneMapper, c: readonly [number, number, number]): Rgb {
  switch (mapper) {
    case "aces":
      return aces(c);
    case "agx":
      return agx(c);
    case "neutral":
      return neutral(c);
    default:
      return filmic(c);
  }
}

/** The sRGB curve and its inverse, both carried past 1. */
export const srgbEncode = (v: number): number => (v <= 0.0031308 ? Math.max(0, v) * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
export const srgbDecode = (v: number): number => (v <= 0.04045 ? Math.max(0, v) / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * A linear colour as the display shows it under `exposure` (sRGB-encoded,
 * 0..1): physically, or as authored (see the module comment).
 */
export function shownAs(mapper: ToneMapper, c: readonly [number, number, number], exposure: number, authored = false): Rgb {
  if (authored) return toneMap(mapper, c.map((x) => srgbEncode(Math.max(0, x)) * exposure) as Rgb);
  return toneMap(mapper, c.map((x) => x * exposure) as Rgb).map(srgbEncode) as Rgb;
}

/** The uniform's index for a curve (filmic for anything unknown). */
export function toneMapperIndex(mapper: ToneMapper | undefined): number {
  const i = mapper ? TONE_MAPPERS.indexOf(mapper) : 0;
  return i < 0 ? 0 : i;
}

const wgslMat = (m: readonly number[]) => `mat3x3f(${[0, 1, 2].map((col) => [0, 1, 2].map((row) => m[row * 3 + col]!.toString()).join(", ")).join(", ")})`;

/** The curves in WGSL: `toneMapWith(index, colour)`, index as {@link toneMapperIndex}. */
export const TONE_MAPPERS_WGSL = /* wgsl */ `
fn toneFilmic(x: vec3f) -> vec3f {
  let v = max(x, vec3f(0.0));
  return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}
fn toneAces(x: vec3f) -> vec3f {
  let v = ${wgslMat(ACES_IN)} * max(x, vec3f(0.0));
  let fit = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  return clamp(${wgslMat(ACES_OUT)} * fit, vec3f(0.0), vec3f(1.0));
}
fn toneAgx(x: vec3f) -> vec3f {
  let v = ${wgslMat(AGX_IN)} * max(x, vec3f(1e-10));
  let t = (clamp(log2(v), vec3f(${AGX_MIN_EV}), vec3f(${AGX_MAX_EV})) - ${AGX_MIN_EV}) / (${AGX_MAX_EV} - ${AGX_MIN_EV});
  let t2 = t * t;
  let t4 = t2 * t2;
  let curve = 15.5 * t4 * t2 - 40.14 * t4 * t + 31.96 * t4 - 6.868 * t2 * t + 0.4298 * t2 + 0.1191 * t - 0.00232;
  return clamp(pow(max(${wgslMat(AGX_OUT)} * curve, vec3f(0.0)), vec3f(2.2)), vec3f(0.0), vec3f(1.0));
}
fn toneNeutral(x: vec3f) -> vec3f {
  var c = max(x, vec3f(0.0));
  let low = min(c.r, min(c.g, c.b));
  let offset = select(0.04, low - 6.25 * low * low, low < 0.08);
  c = c - offset;
  let peak = max(c.r, max(c.g, c.b));
  if (peak < ${NEUTRAL_START}) { return clamp(c, vec3f(0.0), vec3f(1.0)); }
  let d = 1.0 - ${NEUTRAL_START};
  let newPeak = 1.0 - d * d / (peak + d - ${NEUTRAL_START});
  c = c * (newPeak / peak);
  let g = 1.0 - 1.0 / (${NEUTRAL_DESATURATION} * (peak - newPeak) + 1.0);
  return clamp(mix(c, vec3f(newPeak), g), vec3f(0.0), vec3f(1.0));
}
fn toneMapWith(index: f32, c: vec3f) -> vec3f {
  if (index > 2.5) { return toneNeutral(c); }
  if (index > 1.5) { return toneAgx(c); }
  if (index > 0.5) { return toneAces(c); }
  return toneFilmic(c);
}
// The sRGB curve, carried past 1.
fn srgbOf(x: vec3f) -> vec3f {
  let v = max(x, vec3f(0.0));
  return select(1.055 * pow(v, vec3f(1.0 / 2.4)) - vec3f(0.055), v * 12.92, v <= vec3f(0.0031308));
}
// Light x as the display shows it under exposure e, sRGB-encoded (F11a-5): physically, the curve on
// the light then the encode; as authored, the curve on the encoded light, as the byte path's shader maps.
fn shownWith(index: f32, x: vec3f, e: f32, authored: bool) -> vec3f {
  if (authored) { return toneMapWith(index, srgbOf(x) * e); }
  return srgbOf(toneMapWith(index, x * e));
}
// …as an HDR display shows it, encoded: the curve's white at headroom h (its encoding, as authored)
// and grey where SDR shows it (s, extendedExposure's).
fn shownWideWith(index: f32, x: vec3f, e: f32, s: f32, h: f32, authored: bool) -> vec3f {
  if (authored) {
    let top = srgbOf(vec3f(h)).x;
    return toneMapWith(index, srgbOf(x) * (e * s / top)) * top;
  }
  return srgbOf(toneMapWith(index, x * (e * s / h)) * h);
}
`;
