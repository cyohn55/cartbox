/**
 * Orders palette colours into a visual gradient for the picker. Returns the
 * original palette indices in display order — grayscale/near-neutral colours
 * first (dark→light), then chromatic colours by hue and, within a hue, by
 * lightness. This is a *display* ordering only: the returned indices are the
 * real palette slots, so selecting a swatch still writes its original index and
 * existing artwork is untouched.
 */

/** Saturation at or below this reads as neutral (grouped as grayscale). */
const NEUTRAL_SATURATION_MAX = 0.12;

function parseHex(hex: string): [number, number, number] {
  const value = hex.replace(/^#/, "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** RGB (0..255) to HSL with hue in degrees and saturation/lightness in 0..1. */
function rgbToHsl(red: number, green: number, blue: number): { hue: number; saturation: number; lightness: number } {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { hue: 0, saturation: 0, lightness };

  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return { hue: hue * 60, saturation, lightness };
}

export function gradientSortOrder(colors: readonly string[]): number[] {
  const entries = colors.map((hex, index) => {
    const { hue, saturation, lightness } = rgbToHsl(...parseHex(hex));
    return { index, neutral: saturation <= NEUTRAL_SATURATION_MAX, hue, lightness };
  });

  entries.sort((a, b) => {
    if (a.neutral !== b.neutral) return a.neutral ? -1 : 1; // neutrals lead
    if (!a.neutral && a.hue !== b.hue) return a.hue - b.hue; // then by hue
    return a.lightness - b.lightness; // then dark→light
  });

  return entries.map((entry) => entry.index);
}
