/**
 * Colour grading through a 3D lookup table (HALO_INFINITE_STYLE_ROADMAP.md
 * I8): the CPU half of the post-process LUT. A LUT maps every display colour to
 * a graded one — the whole of a colourist's grade (curves, a warm key and cool
 * shadows, vibrance) in one table — so a look authored anywhere (a `.cube` file
 * from a grading tool) or built in here applies in a single texture read.
 *
 * The table is `size`³ RGB bytes, red varying fastest, then green, then blue —
 * the `.cube` order. The shader holds it as a strip of `size` slices (one per
 * blue step) side by side, reads two neighbouring slices with bilinear
 * filtering and mixes them by blue: trilinear interpolation, which
 * {@link applyLut} reproduces here as the reference the tests hold it to.
 *
 * DOM-free, like the rest of the effect model.
 */

/** A 3D colour lookup table: `size`³ RGB bytes, red fastest, then green, then blue. */
export interface GradingLut {
  readonly size: number;
  readonly data: Uint8Array;
}

/** The built-in looks' table size: 16 steps a channel is plenty for smooth grades. */
export const LUT_SIZE = 16;
export const MIN_LUT_SIZE = 2;
/** An imported table's largest size (33³ is the common high-quality `.cube`). */
export const MAX_LUT_SIZE = 33;

/** The looks the grading effect offers, by its `look` parameter; the last uses an imported table. */
export const LUT_LOOKS = ["Infinite", "Warm noon", "Cold steel", "Bleach bypass", "Imported"] as const;
/** The `look` value that reads the imported table. */
export const IMPORTED_LOOK = LUT_LOOKS.length - 1;

type Rgb = [number, number, number];

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const luma = (c: Rgb): number => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
const smooth = (e0: number, e1: number, v: number): number => {
  const t = clamp01((v - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Saturation pushed more where a colour is dull than where it is already vivid. */
function vibrance(c: Rgb, amount: number): Rgb {
  const y = luma(c);
  const sat = Math.max(...c) - Math.min(...c);
  const k = 1 + amount * (1 - sat);
  return [y + (c[0] - y) * k, y + (c[1] - y) * k, y + (c[2] - y) * k];
}

/** Saturation scaled evenly (`keep` of it left). */
function desaturate(c: Rgb, keep: number): Rgb {
  const y = luma(c);
  return [y + (c[0] - y) * keep, y + (c[1] - y) * keep, y + (c[2] - y) * keep];
}

/** A gentle S-curve on each channel round mid-grey. */
function sCurve(c: Rgb, amount: number): Rgb {
  const s = (v: number) => {
    const x = clamp01(v);
    const curved = x * x * (3 - 2 * x);
    return x + (curved - x) * amount;
  };
  return [s(c[0]), s(c[1]), s(c[2])];
}

/** Tint the shadows and the highlights apart (each a small RGB offset), weighted by brightness. */
function splitTint(c: Rgb, shadows: Rgb, highlights: Rgb): Rgb {
  const y = luma(c);
  const lo = 1 - smooth(0.1, 0.5, y);
  const hi = smooth(0.45, 0.95, y);
  return [c[0] + shadows[0] * lo + highlights[0] * hi, c[1] + shadows[1] * lo + highlights[1] * hi, c[2] + shadows[2] * lo + highlights[2] * hi];
}

/** One built-in look, as a function of a display colour. */
const LOOKS: readonly ((c: Rgb) => Rgb)[] = [
  // Infinite: clean, saturated daylight — colours lifted where they're dull, a
  // touch of contrast, warm sunlit highlights over cool blue-teal shade.
  (c) => splitTint(sCurve(vibrance(c, 0.35), 0.25), [-0.015, 0.01, 0.04], [0.035, 0.015, -0.03]),
  // Warm noon: a golden cast through the mids and highlights.
  (c) => splitTint(sCurve(vibrance(c, 0.15), 0.15), [0.0, 0.0, 0.01], [0.06, 0.03, -0.05]),
  // Cold steel: muted and blue, the shadows bluest.
  (c) => splitTint(vibrance(c, -0.3), [-0.02, 0.0, 0.05], [-0.01, 0.01, 0.03]),
  // Bleach bypass: half the colour gone, hard contrast.
  (c) => sCurve(desaturate(c, 0.45), 0.6),
];

/** The table for a built-in look (`look` past the built-ins gives the identity). */
export function lookLut(look: number, size = LUT_SIZE): GradingLut {
  const fn = LOOKS[Math.round(look)] ?? ((c: Rgb) => c);
  const data = new Uint8Array(size * size * size * 3);
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const out = fn([r / (size - 1), g / (size - 1), b / (size - 1)]);
        const o = ((b * size + g) * size + r) * 3;
        data[o] = Math.round(clamp01(out[0]) * 255);
        data[o + 1] = Math.round(clamp01(out[1]) * 255);
        data[o + 2] = Math.round(clamp01(out[2]) * 255);
      }
    }
  }
  return { size, data };
}

/** The identity table: every colour maps to itself. */
export function identityLut(size = LUT_SIZE): GradingLut {
  return lookLut(-1, size);
}

/**
 * Read an Adobe/Resolve `.cube` 3D LUT: `LUT_3D_SIZE n`, an optional
 * `DOMAIN_MIN`/`DOMAIN_MAX`, then n³ lines of three floats, red fastest.
 * Comments (`#`) and a `TITLE` are skipped. Null when it isn't one, it's a 1D
 * LUT, or its size is out of range.
 */
export function parseCubeLut(text: string): GradingLut | null {
  let size = 0;
  let min: Rgb = [0, 0, 0];
  let max: Rgb = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const key = parts[0]!.toUpperCase();
    if (key === "TITLE") continue;
    if (key === "LUT_1D_SIZE") return null;
    if (key === "LUT_3D_SIZE") {
      size = Number(parts[1]);
      continue;
    }
    if (key === "DOMAIN_MIN" || key === "DOMAIN_MAX") {
      const v = parts.slice(1, 4).map(Number) as Rgb;
      if (v.length !== 3 || !v.every(Number.isFinite)) return null;
      if (key === "DOMAIN_MIN") min = v;
      else max = v;
      continue;
    }
    if (/^[A-Z_]/.test(key)) continue; // another keyword some tool wrote
    if (parts.length !== 3) return null;
    for (const p of parts) {
      const v = Number(p);
      if (!Number.isFinite(v)) return null;
      values.push(v);
    }
  }
  if (!Number.isInteger(size) || size < MIN_LUT_SIZE || size > MAX_LUT_SIZE || values.length !== size * size * size * 3) return null;
  const data = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const c = i % 3;
    const span = max[c]! - min[c]! || 1;
    data[i] = Math.round(clamp01((values[i]! - min[c]!) / span) * 255);
  }
  return { size, data };
}

/** Pack a table for the settings (which travel as JSON): its size and its bytes as base64. */
export function encodeLut(lut: GradingLut): { size: number; data: string } {
  let binary = "";
  for (let i = 0; i < lut.data.length; i += 1) binary += String.fromCharCode(lut.data[i]!);
  return { size: lut.size, data: btoa(binary) };
}

/** Unpack a stored table, or null when it is malformed. */
export function decodeLut(value: unknown): GradingLut | null {
  if (!value || typeof value !== "object") return null;
  const { size, data } = value as { size?: unknown; data?: unknown };
  if (typeof size !== "number" || !Number.isInteger(size) || size < MIN_LUT_SIZE || size > MAX_LUT_SIZE || typeof data !== "string") return null;
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return null;
  }
  if (binary.length !== size * size * size * 3) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { size, data: bytes };
}

/**
 * Grade one colour (0..1 channels) through the table, trilinearly — what the
 * shader does with its strip texture. Outside 0..1 is clamped first.
 */
export function applyLut(lut: GradingLut, r: number, g: number, b: number): Rgb {
  const n = lut.size;
  const at = (v: number) => {
    const x = clamp01(v) * (n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    return [i, x - i] as const;
  };
  const [ri, rt] = at(r);
  const [gi, gt] = at(g);
  const [bi, bt] = at(b);
  const out: Rgb = [0, 0, 0];
  for (let k = 0; k < 8; k += 1) {
    const dr = k & 1, dg = (k >> 1) & 1, db = k >> 2;
    const w = (dr ? rt : 1 - rt) * (dg ? gt : 1 - gt) * (db ? bt : 1 - bt);
    if (w === 0) continue;
    const o = (((bi + db) * n + gi + dg) * n + ri + dr) * 3;
    out[0] += (lut.data[o]! / 255) * w;
    out[1] += (lut.data[o + 1]! / 255) * w;
    out[2] += (lut.data[o + 2]! / 255) * w;
  }
  return out;
}

/** The table as the shader's RGBA strip: `size` slices of `size × size`, blue picking the slice. */
export function lutStrip(lut: GradingLut): { width: number; height: number; data: Uint8Array } {
  const n = lut.size;
  const width = n * n;
  const data = new Uint8Array(width * n * 4);
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        const from = ((b * n + g) * n + r) * 3;
        const to = (g * width + b * n + r) * 4;
        data[to] = lut.data[from]!;
        data[to + 1] = lut.data[from + 1]!;
        data[to + 2] = lut.data[from + 2]!;
        data[to + 3] = 255;
      }
    }
  }
  return { width, height: n, data };
}
