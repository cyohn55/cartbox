/**
 * A light's colour temperature (AAA_FIDELITY_ROADMAP.md F2e): the colour of a
 * black body at so many kelvin, as the tint it lays over the light's colour.
 *
 * The chromaticity is the Planckian locus as Kim et al. fit it with cubics
 * (US patent 7,024,034, 2006; within 0.0005 of Planck's law in xy from
 * 1667 K to 25 000 K). It is taken to linear sRGB, clamped into the gamut,
 * and divided by 6500 K's, so 6500 K is white, as a light's colour has always
 * been read. It is then scaled to unit luminance, so a temperature
 * changes a light's colour and not its brightness. That is the physical
 * reading of an intensity in candela or lux: they are photometric, and
 * already count only what the eye sees.
 *
 * A light's colour is authored in sRGB (the byte-space renderers shade in it,
 * and the linear-light one decodes it). So the tinted colour is decoded, tinted
 * in linear light, and encoded back. The linear-light renderer gets exactly
 * the light the tint stands for, and the byte-space renderers a colour that
 * reads the same. It can rise past 1 (a warm light's red), as the encoding's
 * curve carries on past it.
 */

/** The temperatures the locus is fitted over, in kelvin; a temperature outside is held to them. */
export const MIN_LIGHT_TEMPERATURE = 1667;
export const MAX_LIGHT_TEMPERATURE = 25000;
/** The temperature that is white: a light without one reads as this. */
export const WHITE_TEMPERATURE = 6500;

/** CIE 1931 xy of a black body at `kelvin` (Kim et al.'s cubic fit). */
export function planckianXy(kelvin: number): readonly [number, number] {
  const t = Math.min(MAX_LIGHT_TEMPERATURE, Math.max(MIN_LIGHT_TEMPERATURE, kelvin));
  const t1 = 1e3 / t;
  const t2 = t1 * t1;
  const t3 = t2 * t1;
  const x = t <= 4000 ? -0.2661239 * t3 - 0.234358 * t2 + 0.8776956 * t1 + 0.17991 : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t1 + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  const y =
    t <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

/** Linear sRGB (Rec. 709 primaries) of chromaticity xy at unit luminance, clamped into the gamut. */
function xyToLinearRgb(x: number, y: number): [number, number, number] {
  const X = x / y;
  const Z = (1 - x - y) / y;
  return [
    Math.max(0, 3.2404542 * X - 1.5371385 - 0.4985314 * Z),
    Math.max(0, -0.969266 * X + 1.8760108 + 0.041556 * Z),
    Math.max(0, 0.0556434 * X - 0.2040259 + 1.0572252 * Z),
  ];
}

const WHITE = xyToLinearRgb(...planckianXy(WHITE_TEMPERATURE));

/** The linear-light tint of a black body at `kelvin`: 6500 K white, at unit (Rec. 709) luminance. */
export function temperatureTint(kelvin: number): readonly [number, number, number] {
  const c = xyToLinearRgb(...planckianXy(kelvin));
  const r = c[0] / WHITE[0];
  const g = c[1] / WHITE[1];
  const b = c[2] / WHITE[2];
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b || 1;
  return [r / y, g / y, b / y];
}

function decode(v: number): number {
  const c = Math.max(0, v);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function encode(v: number): number {
  const c = Math.max(0, v);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** An authored (sRGB) colour tinted to `kelvin`, in authored space: decoded, tinted in linear light, encoded. */
export function tintToTemperature(color: readonly [number, number, number], kelvin: number): [number, number, number] {
  const t = temperatureTint(kelvin);
  return [encode(decode(color[0]) * t[0]), encode(decode(color[1]) * t[1]), encode(decode(color[2]) * t[2])];
}
