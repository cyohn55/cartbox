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
