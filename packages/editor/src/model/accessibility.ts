/**
 * Accessibility settings as engine features (ENGINE_PARITY_ROADMAP.md EP19b):
 * what a player can set once and have every cart honour.
 *
 * - **Text size**: UI documents' text drawn larger (×1, ×1.5, ×2), shrinking
 *   back only where it would overflow its widget. Carts read it with
 *   cartbox.textscale() to size text they draw themselves.
 * - **Colour filters**: a correction for protanopia, deuteranopia or
 *   tritanopia (daltonisation: the colour difference a player can't see is
 *   moved into channels they can), or high contrast. Applied to the finished
 *   frame, so it works for every renderer and every cart. Carts can read it
 *   with cartbox.colorfilter() (to add shapes to colour-coded markers, say).
 *   The same matrices also *simulate* each type, so the editor can preview a
 *   cart as a colour-blind player sees it.
 * - **Remapping** is the controls' rebinding (EP15), kept in the same settings.
 *
 * Pure: settings in, numbers out.
 */

export type ColorFilter = "none" | "protanopia" | "deuteranopia" | "tritanopia" | "high-contrast";

export const COLOR_FILTERS: readonly ColorFilter[] = ["none", "protanopia", "deuteranopia", "tritanopia", "high-contrast"];

export const COLOR_FILTER_LABELS: Readonly<Record<ColorFilter, string>> = {
  none: "Off",
  protanopia: "Protanopia (red-weak)",
  deuteranopia: "Deuteranopia (green-weak)",
  tritanopia: "Tritanopia (blue-weak)",
  "high-contrast": "High contrast",
};

export const TEXT_SCALES: readonly number[] = [1, 1.5, 2];

export interface AccessibilitySettings {
  /** UI text size multiplier (one of TEXT_SCALES). */
  readonly textScale: number;
  readonly colorFilter: ColorFilter;
}

export const DEFAULT_ACCESSIBILITY: AccessibilitySettings = { textScale: 1, colorFilter: "none" };

/** Settings read defensively. */
export function parseAccessibility(raw: unknown): AccessibilitySettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const scale = typeof r.textScale === "number" ? TEXT_SCALES.reduce((best, s) => (Math.abs(s - (r.textScale as number)) < Math.abs(best - (r.textScale as number)) ? s : best), 1) : 1;
  const filter = COLOR_FILTERS.includes(r.colorFilter as ColorFilter) ? (r.colorFilter as ColorFilter) : "none";
  return { textScale: scale, colorFilter: filter };
}

type M3 = readonly [number, number, number, number, number, number, number, number, number];

/** Machado, Oliveira & Fernandes (2009), severity 1: how each type sees linear RGB. */
const SIMULATE: Readonly<Record<"protanopia" | "deuteranopia" | "tritanopia", M3>> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

/** Where the unseen difference goes (Fidaner et al.): red's error into green and blue. */
const SHIFT: M3 = [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1];

const IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul(a: M3, b: M3): M3 {
  const out: number[] = [];
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) out.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
  return out as unknown as M3;
}

/**
 * The filter as an SVG feColorMatrix (4×5, row-major, applied in linear RGB):
 * `correct` for players, `simulate` for previewing. Null for "none".
 */
export function colorFilterMatrix(filter: ColorFilter, kind: "correct" | "simulate" = "correct"): number[] | null {
  if (filter === "none") return null;
  let m: M3;
  let offset = 0;
  if (filter === "high-contrast") {
    // Contrast ×1.5 about mid-grey, and a little more saturation.
    const k = 1.5;
    const s = 1.25;
    const lum = [0.2126, 0.7152, 0.0722];
    const sat: number[] = [];
    for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) sat.push((1 - s) * lum[c]! + (r === c ? s : 0));
    m = (sat.map((v) => v * k) as unknown) as M3;
    offset = (1 - k) * 0.5;
  } else if (kind === "simulate") {
    m = SIMULATE[filter];
  } else {
    // Daltonise: c + SHIFT·(c − simulate(c)) = (I + SHIFT·(I − S))·c
    const error = IDENTITY.map((v, i) => v - SIMULATE[filter][i]!) as unknown as M3;
    m = IDENTITY.map((v, i) => v + mul(SHIFT, error)[i]!) as unknown as M3;
  }
  const out: number[] = [];
  for (let r = 0; r < 3; r += 1) out.push(m[r * 3]!, m[r * 3 + 1]!, m[r * 3 + 2]!, 0, offset);
  out.push(0, 0, 0, 1, 0);
  return out.map((v) => Math.round(v * 1e6) / 1e6);
}

/** Apply a 4×5 matrix to one linear RGB colour (0..1, clamped): what the filter does to it. */
export function applyColorMatrix(matrix: readonly number[], rgb: readonly [number, number, number]): [number, number, number] {
  const out: number[] = [];
  for (let r = 0; r < 3; r += 1) {
    const v = matrix[r * 5]! * rgb[0] + matrix[r * 5 + 1]! * rgb[1] + matrix[r * 5 + 2]! * rgb[2] + matrix[r * 5 + 4]!;
    out.push(Math.min(1, Math.max(0, v)));
  }
  return out as [number, number, number];
}

/** An SVG document defining the filter as `#cbx-color-filter`, for a CSS `filter: url(…)` (null for "none"). */
export function colorFilterSvg(filter: ColorFilter, kind: "correct" | "simulate" = "correct", id = "cbx-color-filter"): string | null {
  const matrix = colorFilterMatrix(filter, kind);
  if (!matrix) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute"><filter id="${id}" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="${matrix.join(" ")}"/></filter></svg>`;
}

/**
 * The text scale a UI text is drawn at: its own scale times the player's text
 * size (rounded, as the console only draws whole scales), stepped back down
 * while it would overflow its box. `width` is the text's width at scale 1.
 */
export function accessibleTextScale(scale: number, textScale: number, width: number, boxWidth: number, boxHeight: number, lineHeight = 6): number {
  let s = Math.max(scale, Math.round(scale * textScale));
  while (s > scale && ((boxWidth > 0 && width * s > boxWidth) || (boxHeight > 0 && lineHeight * s > boxHeight))) s -= 1;
  return s;
}
