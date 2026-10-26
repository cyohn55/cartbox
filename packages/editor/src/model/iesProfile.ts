/**
 * IES light profiles (AAA_FIDELITY_ROADMAP.md F9d, and F2e's deferred IES): a
 * real fixture's measured distribution of light, read from an IESNA LM-63 file
 * (1986, 1991, 1995 or 2002), so a downlight throws its pool and a wall washer
 * its scallops.
 *
 * The file gives candela on a grid of vertical angles (0° straight down the
 * fixture's axis, 180° up) and horizontal ones (round the axis). A light takes
 * the profile as {@link IesProfile}: the candela resampled to
 * {@link IES_VERTICAL_SAMPLES} vertical angles from 0 to 180° and
 * {@link IES_HORIZONTAL_SAMPLES} horizontal ones round the full circle (the
 * file's symmetry unfolded), normalised so its brightest sample is 1, with the
 * peak's candela kept so it can set the light's intensity in physical units.
 * The AAA renderer multiplies a spot or point light by it, about the light's
 * axis (a spot's direction, else straight down).
 */

/** Vertical angles a profile keeps, 0 (down the axis) to 180°. */
export const IES_VERTICAL_SAMPLES = 32;
/** Horizontal angles a profile keeps round the axis. */
export const IES_HORIZONTAL_SAMPLES = 16;

export interface IesProfile {
  /** IES_VERTICAL_SAMPLES × IES_HORIZONTAL_SAMPLES intensities (0..1), vertical angle fastest. */
  readonly samples: readonly number[];
  /** The brightest candela in the file, times its multiplier. */
  readonly peakCandela: number;
  /** The file's name for the fixture (its [LUMINAIRE] or [TEST] keyword), when it gives one. */
  readonly label?: string;
}

/** Parse an LM-63 file into its angles and candela. Throws with a reason when it can't. */
export function parseIes(text: string): { vertical: number[]; horizontal: number[]; candela: number[][]; multiplier: number; label?: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (!/^IESNA|^\[|^TILT/i.test(lines[0]?.trim() ?? "") && !lines.some((l) => /^TILT\s*=/i.test(l.trim()))) throw new Error("Not an IES profile.");
  let label: string | undefined;
  let i = 0;
  for (; i < lines.length; i += 1) {
    const l = lines[i]!.trim();
    const m = /^\[(LUMINAIRE|TEST|LUMCAT)\]\s*(.+)$/i.exec(l);
    if (m && !label) label = m[2]!.trim();
    if (/^TILT\s*=/i.test(l)) break;
  }
  if (i >= lines.length) throw new Error("IES profile without a TILT line.");
  const tilt = lines[i]!.trim().split("=")[1]!.trim().toUpperCase();
  // The numbers follow, whitespace- or comma-separated across any number of lines.
  const numbers = lines
    .slice(i + 1)
    .join(" ")
    .split(/[\s,]+/)
    .filter((s) => s.length > 0)
    .map(Number);
  let k = 0;
  if (tilt === "INCLUDE") {
    // Lamp-to-luminaire geometry, the pair count, then the angles and their multipliers.
    k += 1;
    const pairs = numbers[k++]!;
    k += pairs * 2;
  }
  const take = () => {
    if (k >= numbers.length || !Number.isFinite(numbers[k]!)) throw new Error("IES profile ends early.");
    return numbers[k++]!;
  };
  take(); // lamps
  take(); // lumens per lamp
  const multiplier = take();
  const nv = Math.round(take());
  const nh = Math.round(take());
  take(); // photometric type
  take(); // units
  take(); // width
  take(); // length
  take(); // height
  take(); // ballast factor
  take(); // future use / ballast-lamp factor
  take(); // input watts
  if (!(nv > 0 && nh > 0 && nv * nh < 1e6)) throw new Error("IES profile with no angles.");
  const vertical = Array.from({ length: nv }, take);
  const horizontal = Array.from({ length: nh }, take);
  const candela = Array.from({ length: nh }, () => Array.from({ length: nv }, take));
  return { vertical, horizontal, candela, multiplier: multiplier > 0 ? multiplier : 1, ...(label ? { label } : {}) };
}

/** Linear interpolation into sorted `xs` at `x`: the index below and the weight of the one above. */
function bracket(xs: readonly number[], x: number): [number, number] {
  if (x <= xs[0]!) return [0, 0];
  if (x >= xs[xs.length - 1]!) return [xs.length - 1, 0];
  let lo = 0;
  while (lo < xs.length - 2 && xs[lo + 1]! < x) lo += 1;
  const span = xs[lo + 1]! - xs[lo]!;
  return [lo, span > 0 ? (x - xs[lo]!) / span : 0];
}

/** An IES file as a light's profile (see the module comment). */
export function iesProfile(text: string): IesProfile {
  const { vertical, horizontal, candela, multiplier, label } = parseIes(text);
  const last = horizontal[horizontal.length - 1]!;
  // Unfold the file's horizontal symmetry onto the full circle.
  const fold = (h: number): number => {
    if (horizontal.length === 1) return 0;
    if (last <= 0) return 0;
    if (last <= 90) {
      const a = h % 180;
      const b = a > 90 ? 180 - a : a;
      return h >= 180 ? b : b;
    }
    if (last <= 180) return h > 180 ? 360 - h : h;
    return h;
  };
  const at = (v: number, h: number): number => {
    const [hi, hw] = bracket(horizontal, fold(h));
    const [vi, vw] = bracket(vertical, v);
    const row = (r: number) => {
      const c = candela[Math.min(r, candela.length - 1)]!;
      return c[vi]! * (1 - vw) + (c[Math.min(vi + 1, c.length - 1)] ?? c[vi]!) * vw;
    };
    return row(hi) * (1 - hw) + row(Math.min(hi + 1, horizontal.length - 1)) * hw;
  };
  const raw: number[] = [];
  for (let h = 0; h < IES_HORIZONTAL_SAMPLES; h += 1) {
    for (let v = 0; v < IES_VERTICAL_SAMPLES; v += 1) raw.push(Math.max(0, at((v / (IES_VERTICAL_SAMPLES - 1)) * 180, (h / IES_HORIZONTAL_SAMPLES) * 360)));
  }
  const peak = Math.max(...candela.flat(), 1e-9);
  const top = Math.max(...raw, 1e-9);
  return { samples: raw.map((x) => x / top), peakCandela: peak * multiplier, ...(label ? { label } : {}) };
}

/** A profile's intensity at a vertical angle (radians from the axis, 0..π) and a horizontal one (radians), bilinear. */
export function sampleIes(profile: IesProfile, vertical: number, horizontal: number): number {
  const v = Math.max(0, Math.min(1, vertical / Math.PI)) * (IES_VERTICAL_SAMPLES - 1);
  const h = ((((horizontal / (2 * Math.PI)) % 1) + 1) % 1) * IES_HORIZONTAL_SAMPLES;
  const v0 = Math.floor(v), v1 = Math.min(IES_VERTICAL_SAMPLES - 1, v0 + 1), vw = v - v0;
  const h0 = Math.floor(h) % IES_HORIZONTAL_SAMPLES, h1 = (h0 + 1) % IES_HORIZONTAL_SAMPLES, hw = h - Math.floor(h);
  const s = (hh: number, vv: number) => profile.samples[hh * IES_VERTICAL_SAMPLES + vv]!;
  return (s(h0, v0) * (1 - vw) + s(h0, v1) * vw) * (1 - hw) + (s(h1, v0) * (1 - vw) + s(h1, v1) * vw) * hw;
}

/** A stored profile, read defensively; null when malformed. */
export function readIesProfile(raw: unknown): IesProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.samples) || r.samples.length !== IES_VERTICAL_SAMPLES * IES_HORIZONTAL_SAMPLES) return null;
  if (!r.samples.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const peak = typeof r.peakCandela === "number" && Number.isFinite(r.peakCandela) && r.peakCandela > 0 ? r.peakCandela : 1;
  return { samples: (r.samples as number[]).map((x) => Math.max(0, Math.min(1, x))), peakCandela: peak, ...(typeof r.label === "string" ? { label: r.label.slice(0, 80) } : {}) };
}
