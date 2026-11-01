/**
 * Water on the AAA tier (AAA_FIDELITY_ROADMAP.md F5d), the CPU reference the
 * linear-light scene shader mirrors: what a water material adds over B5's
 * ripples (materialEffects.ts).
 *
 * - **Waves.** Lakes and rivers take a sum of four Gerstner waves along the
 *   flow (their slopes tilt the surface); open water takes an FFT ocean
 *   (Tessendorf 2001): a Phillips spectrum on a 64² grid over a patch some
 *   tens of metres wide, its heights' slopes found by an inverse FFT each frame
 *   on the CPU and tiled over the surface.
 * - **Ripples you make.** A 64² wave-equation grid, 25 cm a cell, follows the
 *   eye; whatever disturbs the water (a cart's `cartbox.splash`, a round
 *   landing) drops a ring into it, which spreads, reflects off nothing and
 *   dies away.
 * - **Depth.** What is seen through the water loses light by Beer–Lambert
 *   absorption over the water between the surface and it (red goes first),
 *   and the water's own turbidity scatters light in, toward its colour: the
 *   deeper, the bluer-greener and murkier.
 * - **Foam** where the water is shallow over something (the shore, a rock),
 *   broken by noise, and on the ripples' crests.
 * - **Caustics** on what lies under a water plane: the sun focused by the
 *   waves into a bright, moving web, fading with depth.
 * - **Under water**, the eye sees through the water's absorption and
 *   scattering instead of air.
 *
 * Distances are metres. Pure and DOM-free.
 */

type V3 = [number, number, number];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** What a water material adds (F5d), each optional. */
export interface WaterLook {
  /** The water's absorption per metre (RGB): red goes first. */
  readonly absorption?: readonly [number, number, number];
  /** Its scattering per metre (RGB): how turbid, and its colour. */
  readonly scattering?: readonly [number, number, number];
  /** Shore and crest foam, 0..1. */
  readonly foam?: number;
  /** Gerstner waves' height (m): lakes and rivers. */
  readonly waves?: number;
  /** The FFT ocean's share of the surface's slope, 0..1: open water. */
  readonly ocean?: number;
}

/** Clear river water: red absorbed in a couple of metres, a little green turbidity. */
export const WATER_DEFAULTS = { absorption: [0.45, 0.09, 0.06] as V3, scattering: [0.006, 0.018, 0.016] as V3, foam: 0.5, waves: 0, ocean: 0 };

export function parseWaterLook(value: unknown): WaterLook | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const rgb = (v: unknown, hi: number) => (Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === "number" && Number.isFinite(c)) ? (v.map((c) => clamp(c, 0, hi)) as V3) : null);
  const a = rgb(raw.absorption, 20);
  if (a) out.absorption = a;
  const s = rgb(raw.scattering, 5);
  if (s) out.scattering = s;
  for (const [key, hi] of [["foam", 1], ["waves", 4], ["ocean", 1]] as const) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = clamp(v, 0, hi);
  }
  return Object.keys(out).length > 0 ? (out as WaterLook) : null;
}

export function resolveWaterLook(look: WaterLook | null | undefined): Required<WaterLook> {
  return { ...WATER_DEFAULTS, ...(look ?? {}) } as Required<WaterLook>;
}

// --- Through the water ------------------------------------------------------------

/** The share of light that crosses `metres` of water. */
export function waterTransmittance(metres: number, absorption: readonly number[], scattering: readonly number[]): V3 {
  return [0, 1, 2].map((c) => Math.exp(-(absorption[c]! + scattering[c]!) * Math.max(0, metres))) as V3;
}

/** The light the water scatters toward the eye over `metres`, lit by `light` (the sun and sky that reach into it). */
export function waterInscatter(metres: number, absorption: readonly number[], scattering: readonly number[], light: readonly number[]): V3 {
  return [0, 1, 2].map((c) => {
    const ext = Math.max(1e-6, absorption[c]! + scattering[c]!);
    return (scattering[c]! / ext) * (1 - Math.exp(-ext * Math.max(0, metres))) * light[c]!;
  }) as V3;
}

/** What is behind (or around, under water) seen through `metres` of water. */
export function throughWater(behind: readonly number[], metres: number, look: Required<WaterLook>, light: readonly number[]): V3 {
  const t = waterTransmittance(metres, look.absorption, look.scattering);
  const s = waterInscatter(metres, look.absorption, look.scattering, light);
  return [0, 1, 2].map((c) => behind[c]! * t[c]! + s[c]!) as V3;
}

/** A 2D value-noise hash, as the shader's. */
export function waterHash(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ 0x5bd1e995) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = waterHash(ix, iy), b = waterHash(ix + 1, iy), c = waterHash(ix, iy + 1), d = waterHash(ix + 1, iy + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** Foam over `metres` of water at (x, z), `time` seconds: thick at the waterline, broken by drifting noise, gone by half a metre deep. */
export function shoreFoam(metres: number, x: number, z: number, time: number, foam: number): number {
  if (foam <= 0) return 0;
  const edge = 1 - smoothstep(0, 0.5 * foam + 0.05, metres);
  if (edge <= 0) return 0;
  const n = noise(x * 3 + time * 0.3, z * 3 - time * 0.2) * 0.6 + noise(x * 7 - time * 0.5, z * 7) * 0.4;
  return clamp(edge * smoothstep(0.35, 0.65, n + edge * 0.4) * foam, 0, 1);
}

// --- Waves --------------------------------------------------------------------------

/** The four Gerstner waves (a lake's or a river's): each one's share of the height, wavelength (m), and turn off the flow (radians). */
export const GERSTNER_WAVES = [
  [0.45, 6.0, 0.0],
  [0.25, 3.1, 0.6],
  [0.18, 1.7, -0.9],
  [0.12, 0.9, 1.7],
] as const;

/** The slope (dh/dx, dh/dz) of a sum of Gerstner waves of height `height` along `flow` at (x, z), `time` seconds (deep-water dispersion). */
export function gerstnerSlope(x: number, z: number, time: number, height: number, flow: number): [number, number] {
  if (height <= 0) return [0, 0];
  let sx = 0;
  let sz = 0;
  for (const [share, wavelength, turn] of GERSTNER_WAVES) {
    const k = (2 * Math.PI) / wavelength;
    const omega = Math.sqrt(9.81 * k);
    const dx = Math.cos(flow + turn), dz = Math.sin(flow + turn);
    const a = (height * share) / 2;
    const phase = k * (dx * x + dz * z) - omega * time;
    const c = a * k * Math.cos(phase);
    sx += c * dx;
    sz += c * dz;
  }
  return [sx, sz];
}

// --- The FFT ocean ---------------------------------------------------------------

/** The ocean's grid edge and its patch's width (m). */
export const OCEAN_SIZE = 64;
export const OCEAN_PATCH = 40;

/** The Phillips spectrum at wave vector (kx, kz) for wind `wind` (m/s along x, z), with small waves under `l` m suppressed. */
export function phillips(kx: number, kz: number, wind: readonly [number, number], amplitude = 2e-4, l = 0.05): number {
  const k2 = kx * kx + kz * kz;
  if (k2 < 1e-12) return 0;
  const speed = Math.hypot(wind[0], wind[1]) || 1e-6;
  const L = (speed * speed) / 9.81;
  const kd = (kx * wind[0] + kz * wind[1]) / (Math.sqrt(k2) * speed);
  // Waves running against the wind are damped.
  const align = kd < 0 ? 0.07 * kd * kd : kd * kd;
  return (amplitude * Math.exp(-1 / (k2 * L * L)) * align * Math.exp(-k2 * l * l)) / (k2 * k2);
}

/** A Gaussian pair from two uniforms (Box–Muller). */
function gauss(u1: number, u2: number): [number, number] {
  const r = Math.sqrt(-2 * Math.log(Math.max(1e-12, u1)));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

/** In-place radix-2 FFT of `n` complex values (re, im), inverse when `inverse`. */
export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(angle), wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j += 1) {
        const a = i + j, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/**
 * An FFT ocean (Tessendorf): the initial spectrum h̃₀ on the grid, made once
 * for a wind, and the surface's slopes at any time from it.
 */
export class Ocean {
  private readonly h0re: Float64Array;
  private readonly h0im: Float64Array;
  private readonly omega: Float64Array;

  constructor(readonly wind: readonly [number, number], readonly patch = OCEAN_PATCH, readonly size = OCEAN_SIZE) {
    const n = size;
    this.h0re = new Float64Array(n * n);
    this.h0im = new Float64Array(n * n);
    this.omega = new Float64Array(n * n);
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const kx = (2 * Math.PI * (i - n / 2)) / patch;
        const kz = (2 * Math.PI * (j - n / 2)) / patch;
        const [g1, g2] = gauss(waterHash(i, j) + 1e-9, waterHash(i + 977, j + 131));
        const a = Math.sqrt(phillips(kx, kz, wind) / 2);
        this.h0re[j * n + i] = g1 * a;
        this.h0im[j * n + i] = g2 * a;
        this.omega[j * n + i] = Math.sqrt(9.81 * Math.hypot(kx, kz));
      }
    }
  }

  /**
   * The surface's slopes at `time` seconds, (dh/dx, dh/dz) per grid point,
   * row-major, x across: h̃(k, t) = h̃₀(k) e^{iωt} + conj(h̃₀(−k)) e^{−iωt},
   * the slope's spectrum i·k·h̃, inverse-transformed by rows then columns.
   */
  slopes(time: number, out: Float32Array<ArrayBuffer> = new Float32Array(this.size * this.size * 2)): Float32Array<ArrayBuffer> {
    const n = this.size;
    const sxRe = new Float64Array(n * n), sxIm = new Float64Array(n * n);
    const szRe = new Float64Array(n * n), szIm = new Float64Array(n * n);
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const idx = j * n + i;
        const mi = (n - i) % n, mj = (n - j) % n;
        const midx = mj * n + mi;
        const w = this.omega[idx]! * time;
        const c = Math.cos(w), s = Math.sin(w);
        // h0(k) e^{iwt} + conj(h0(-k)) e^{-iwt}
        const hr = this.h0re[idx]! * c - this.h0im[idx]! * s + (this.h0re[midx]! * c - this.h0im[midx]! * s);
        const hi = this.h0re[idx]! * s + this.h0im[idx]! * c - (this.h0re[midx]! * s + this.h0im[midx]! * c);
        const kx = (2 * Math.PI * (i - n / 2)) / this.patch;
        const kz = (2 * Math.PI * (j - n / 2)) / this.patch;
        // i·k·h
        sxRe[idx] = -kx * hi;
        sxIm[idx] = kx * hr;
        szRe[idx] = -kz * hi;
        szIm[idx] = kz * hr;
      }
    }
    const transform2d = (re: Float64Array, im: Float64Array) => {
      const rr = new Float64Array(n), ri = new Float64Array(n);
      for (let j = 0; j < n; j += 1) {
        for (let i = 0; i < n; i += 1) {
          // The grid is centred on k = 0: shift by n/2 (a sign flip in space).
          rr[i] = re[j * n + ((i + n / 2) % n)]!;
          ri[i] = im[j * n + ((i + n / 2) % n)]!;
        }
        fft(rr, ri, true);
        for (let i = 0; i < n; i += 1) {
          re[j * n + i] = rr[i]!;
          im[j * n + i] = ri[i]!;
        }
      }
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          rr[j] = re[((j + n / 2) % n) * n + i]!;
          ri[j] = im[((j + n / 2) % n) * n + i]!;
        }
        fft(rr, ri, true);
        for (let j = 0; j < n; j += 1) {
          re[j * n + i] = rr[j]!;
          im[j * n + i] = ri[j]!;
        }
      }
    };
    transform2d(sxRe, sxIm);
    transform2d(szRe, szIm);
    for (let p = 0; p < n * n; p += 1) {
      out[p * 2] = sxRe[p]!;
      out[p * 2 + 1] = szRe[p]!;
    }
    return out;
  }
}

/** Bilinear sample of a tiled slope grid (from {@link Ocean.slopes}) at world (x, z). */
export function sampleSlopes(slopes: Float32Array, x: number, z: number, patch = OCEAN_PATCH, size = OCEAN_SIZE): [number, number] {
  const gx = (x / patch) * size - 0.5, gz = (z / patch) * size - 0.5;
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const fx = gx - ix, fz = gz - iz;
  const at = (dx: number, dz: number, c: number) => slopes[((((iz + dz) % size) + size) % size * size + ((((ix + dx) % size) + size) % size)) * 2 + c]!;
  const lerp = (c: number) => (at(0, 0, c) * (1 - fx) + at(1, 0, c) * fx) * (1 - fz) + (at(0, 1, c) * (1 - fx) + at(1, 1, c) * fx) * fz;
  return [lerp(0), lerp(1)];
}

// --- Interactive ripples -----------------------------------------------------------

export const RIPPLE_SIZE = 64;
export const RIPPLE_CELL = 0.25;

/**
 * A wave-equation height grid that follows the eye, RIPPLE_SIZE² cells of
 * RIPPLE_CELL metres; what disturbs the water drops a ring in it.
 */
export class RippleField {
  heights = new Float32Array(RIPPLE_SIZE * RIPPLE_SIZE);
  private previous = new Float32Array(RIPPLE_SIZE * RIPPLE_SIZE);
  /** The grid's corner cell (world x and z over the cell), snapped so the field doesn't swim as the eye moves. */
  origin: [number, number] = [0, 0];
  private carry = 0;

  /** Keep the grid round (x, z), moving its contents when the corner moves a cell or more. */
  follow(x: number, z: number): void {
    const ox = Math.floor(x / RIPPLE_CELL) - RIPPLE_SIZE / 2;
    const oz = Math.floor(z / RIPPLE_CELL) - RIPPLE_SIZE / 2;
    const dx = ox - this.origin[0], dz = oz - this.origin[1];
    if (dx === 0 && dz === 0) return;
    const shift = (from: Float32Array) => {
      const to = new Float32Array(from.length);
      for (let j = 0; j < RIPPLE_SIZE; j += 1) {
        for (let i = 0; i < RIPPLE_SIZE; i += 1) {
          const si = i + dx, sj = j + dz;
          if (si >= 0 && sj >= 0 && si < RIPPLE_SIZE && sj < RIPPLE_SIZE) to[j * RIPPLE_SIZE + i] = from[sj * RIPPLE_SIZE + si]!;
        }
      }
      return to;
    };
    this.heights = shift(this.heights);
    this.previous = shift(this.previous);
    this.origin = [ox, oz];
  }

  /** Drop a ring at world (x, z): a dent `strength` metres deep, `radius` metres across. */
  impulse(x: number, z: number, strength = 0.05, radius = 0.4): void {
    const cx = x / RIPPLE_CELL - this.origin[0], cz = z / RIPPLE_CELL - this.origin[1];
    const r = radius / RIPPLE_CELL;
    for (let j = Math.floor(cz - r); j <= Math.ceil(cz + r); j += 1) {
      for (let i = Math.floor(cx - r); i <= Math.ceil(cx + r); i += 1) {
        if (i < 1 || j < 1 || i >= RIPPLE_SIZE - 1 || j >= RIPPLE_SIZE - 1) continue;
        const d = Math.hypot(i - cx, j - cz) / r;
        if (d < 1) this.heights[j * RIPPLE_SIZE + i] = this.heights[j * RIPPLE_SIZE + i]! - strength * 0.5 * (1 + Math.cos(Math.PI * d));
      }
    }
  }

  /** Step `dt` seconds (fixed 60 Hz substeps): the wave equation at about 1.2 m/s, damped, the edges held at rest. */
  step(dt: number): void {
    this.carry += dt;
    const sub = 1 / 60;
    const c2 = (1.2 * sub / RIPPLE_CELL) ** 2; // stable under 0.5
    while (this.carry >= sub) {
      this.carry -= sub;
      const h = this.heights, p = this.previous;
      const next = p; // written in place over the oldest
      for (let j = 1; j < RIPPLE_SIZE - 1; j += 1) {
        for (let i = 1; i < RIPPLE_SIZE - 1; i += 1) {
          const k = j * RIPPLE_SIZE + i;
          const lap = h[k - 1]! + h[k + 1]! + h[k - RIPPLE_SIZE]! + h[k + RIPPLE_SIZE]! - 4 * h[k]!;
          next[k] = (2 * h[k]! - p[k]! + c2 * lap) * 0.985;
        }
      }
      this.previous = h;
      this.heights = next;
    }
  }

  /** The slope (dh/dx, dh/dz) at world (x, z): central differences, bilinear between cells; flat outside the grid. */
  slope(x: number, z: number): [number, number] {
    const gx = x / RIPPLE_CELL - this.origin[0] - 0.5, gz = z / RIPPLE_CELL - this.origin[1] - 0.5;
    const at = (i: number, j: number) => (i < 0 || j < 0 || i >= RIPPLE_SIZE || j >= RIPPLE_SIZE ? 0 : this.heights[j * RIPPLE_SIZE + i]!);
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const sl = (i: number, j: number): [number, number] => [(at(i + 1, j) - at(i - 1, j)) / (2 * RIPPLE_CELL), (at(i, j + 1) - at(i, j - 1)) / (2 * RIPPLE_CELL)];
    const a = sl(ix, iz), b = sl(ix + 1, iz), c = sl(ix, iz + 1), d = sl(ix + 1, iz + 1);
    return [0, 1].map((k) => (a[k]! * (1 - fx) + b[k]! * fx) * (1 - fz) + (c[k]! * (1 - fx) + d[k]! * fx) * fz) as [number, number];
  }

  /** Whether anything is still moving (the shader skips a still field). */
  get active(): boolean {
    for (let k = 0; k < this.heights.length; k += 1) if (Math.abs(this.heights[k]!) > 1e-4) return true;
    return false;
  }
}

// --- Caustics -----------------------------------------------------------------------

/**
 * The sun focused through the waves onto a point `depth` metres under the
 * surface at (x, z): a moving web of light, 1 on average, brightest just under
 * the surface and evening out with depth (where the caustic's lines blur).
 */
export function caustics(x: number, z: number, time: number, depth: number): number {
  if (depth <= 0) return 1;
  // Two layers of cells, each bright along its edges (|n − ½| folded), multiplied: the web.
  const layer = (s: number, t: number, ox: number, oz: number) => {
    const n = noise(x * s + ox + t, z * s + oz - t * 0.7);
    return 1 - Math.abs(n * 2 - 1);
  };
  const web = layer(1.7, time * 0.35, 0, 0) * layer(2.3, -time * 0.28, 5.3, 1.9);
  const sharp = Math.pow(web, 4) * 4.5;
  const fade = Math.exp(-depth * 0.35);
  return 1 + (sharp - 0.55) * fade;
}

/** The height of the Gerstner sum at (x, z) (what {@link gerstnerSlope} is the slope of). */
export function gerstnerHeight(x: number, z: number, time: number, height: number, flow: number): number {
  let h = 0;
  for (const [share, wavelength, turn] of GERSTNER_WAVES) {
    const k = (2 * Math.PI) / wavelength;
    const omega = Math.sqrt(9.81 * k);
    const dx = Math.cos(flow + turn), dz = Math.sin(flow + turn);
    h += ((height * share) / 2) * Math.sin(k * (dx * x + dz * z) - omega * time);
  }
  return h;
}
