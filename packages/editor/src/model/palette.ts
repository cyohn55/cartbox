/**
 * TIC-80's default 16-colour palette ("Sweetie-16"). Used to seed a fresh cart
 * so the editor opens with the same colours creators expect. Values are the
 * canonical hex codes from the TIC-80 core.
 */
export const SWEETIE_16: readonly string[] = [
  "#1a1c2c",
  "#5d275d",
  "#b13e53",
  "#ef7d57",
  "#ffcd75",
  "#a7f070",
  "#38b764",
  "#257179",
  "#29366f",
  "#3b5dc9",
  "#41a6f6",
  "#73eff7",
  "#f4f4f4",
  "#94b0c2",
  "#566c86",
  "#333c57",
];

/** Parse a `#rrggbb` string into an [r, g, b] triplet (0..255). */
export function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** Format an [r, g, b] triplet as a `#rrggbb` string. */
export function rgbToHex(red: number, green: number, blue: number): string {
  const channel = (value: number) => Math.max(0, Math.min(255, value | 0)).toString(16).padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

/** The default palette flattened to RGB bytes, ready to seed engine memory. */
export function defaultPaletteBytes(): Uint8Array {
  const bytes = new Uint8Array(SWEETIE_16.length * 3);
  SWEETIE_16.forEach((hex, index) => {
    const [red, green, blue] = hexToRgb(hex);
    bytes[index * 3] = red;
    bytes[index * 3 + 1] = green;
    bytes[index * 3 + 2] = blue;
  });
  return bytes;
}

/** An [r, g, b] triplet, each channel 0..255. */
type Rgb = readonly [number, number, number];

/** An [r, g, b] triplet to HSL (hue in degrees, saturation/lightness in 0..1). */
function rgbToHsl(red: number, green: number, blue: number): [number, number, number] {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness]; // achromatic
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return [hue * 60, saturation, lightness];
}

/**
 * WCAG relative luminance (0..1) of an [r, g, b] triplet — the perceptual
 * brightness used to reason about contrast, weighting green far above blue.
 */
export function relativeLuminance([red, green, blue]: Rgb): number {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** WCAG contrast ratio (1..21) between two colours; order-independent. */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Lighten `hex` just enough to reach `minContrast` against `background`, keeping
 * its hue and saturation, so a coloured mark stays legible on a dark surface
 * (the marquee panel, the shoulder buttons) without losing its identity. Returns
 * the colour unchanged when it already clears the target. Because raising HSL
 * lightness toward white monotonically raises luminance, a binary search finds
 * the least lightening that satisfies the target.
 */
export function ensureContrast(hex: string, background: Rgb, minContrast: number): string {
  const rgb = hexToRgb(hex);
  if (contrastRatio(rgb, background) >= minContrast) return hex;
  const [hue, saturation, lightness] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  let lowLightness = lightness; // known too dark
  let highLightness = 1; // white: maximally contrasting on any dark surface
  let result = rgbToHex(...hslToRgb(hue, saturation, highLightness));
  for (let step = 0; step < 24; step += 1) {
    const midLightness = (lowLightness + highLightness) / 2;
    const candidate = hslToRgb(hue, saturation, midLightness);
    if (contrastRatio(candidate, background) >= minContrast) {
      highLightness = midLightness;
      result = rgbToHex(...candidate);
    } else {
      lowLightness = midLightness;
    }
  }
  return result;
}

/** HSL (hue in degrees, saturation/lightness in 0..1) to an [r, g, b] triplet (0..255). */
function hslToRgb(hueDegrees: number, saturation: number, lightness: number): [number, number, number] {
  const hue = ((((hueDegrees % 360) + 360) % 360) / 360);
  if (saturation === 0) {
    const gray = Math.round(lightness * 255);
    return [gray, gray, gray];
  }
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (offset: number): number => {
    let t = hue + offset;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(channel(1 / 3) * 255), Math.round(channel(0) * 255), Math.round(channel(-1 / 3) * 255)];
}

/** The Pro console's authoring palette size. */
export const PRO_PALETTE_SIZE = 64;

/**
 * The Pro console's default 64-colour palette. The first 16 entries are
 * Sweetie-16, so indices shared with Classic content read the same; the next 48
 * are generated as 8 hues × 6 lightness steps, giving usable shade ramps across
 * the spectrum for the wider palette.
 */
export function proPaletteHex(): string[] {
  const colors: string[] = [...SWEETIE_16];
  const hues = [0, 45, 90, 135, 180, 225, 270, 315];
  const lightnessSteps = [0.25, 0.38, 0.5, 0.62, 0.74, 0.86];
  for (const hue of hues) {
    for (const lightness of lightnessSteps) {
      if (colors.length >= PRO_PALETTE_SIZE) break;
      const [red, green, blue] = hslToRgb(hue, 0.6, lightness);
      colors.push(rgbToHex(red, green, blue));
    }
  }
  return colors;
}

/** The default starter palette for a model, sized to its authoring palette. */
export function paletteForModel(model: { paletteSize: number }): readonly string[] {
  return model.paletteSize >= PRO_PALETTE_SIZE ? proPaletteHex() : SWEETIE_16;
}
