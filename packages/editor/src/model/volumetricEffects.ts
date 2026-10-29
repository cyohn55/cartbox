/**
 * Volumetric effects (AAA_FIDELITY_ROADMAP.md F8b): smoke, fire and
 * explosions as density in a 3D grid, raymarched by the linear-light renderer
 * (volumetricEffects.ts in @cartbox/player) and lighting its fog.
 *
 * - **The solver** is Stam's stable fluids on a small grid (16³–64³), each
 *   step: forces (buoyancy from temperature, the source's push), advection
 *   (semi-Lagrangian, trilinear, of velocity, density and temperature),
 *   projection (divergence, Jacobi iterations for the pressure, its gradient
 *   taken away, so the flow carries no net in or out), and dissipation. The
 *   GPU runs it in compute, cell for cell as the CPU does here.
 * - **Baked** effects are the solver run ahead (here, on the CPU) and its
 *   density and temperature kept per frame, played back like a flipbook.
 * - **Light.** A volume's fire glows by its temperature (a blackbody's
 *   colour) and lights the scene and the froxel fog round it as a point
 *   light at its centre, as bright as it burns.
 */

type V3 = [number, number, number];

export interface VolumeEffect {
  readonly name: string;
  readonly kind: "smoke" | "fire" | "explosion";
  /** The volume's edge, metres (a cube). */
  readonly size: number;
  /** Cells along each axis. */
  readonly resolution: number;
  /** Seconds it lasts, and whether it's the solver live or baked frames. */
  readonly duration: number;
  readonly source: "fluid" | "baked";
  /** How strongly heat rises, and how fast density and heat fade (per second). */
  readonly buoyancy: number;
  readonly dissipation: number;
  readonly cooling: number;
  /** Smoke's colour (linear), how dark it is (extinction per unit density, per metre). */
  readonly color: readonly [number, number, number];
  readonly absorption: number;
  /** Fire's light: its peak temperature (K) and how bright the glow and the light it casts are. */
  readonly temperature: number;
  readonly emission: number;
  readonly light: number;
}

export const MAX_VOLUME_RESOLUTION = 64;
/** The pressure solve's Jacobi iterations. */
export const PRESSURE_ITERATIONS = 20;

/** A volume effect from a preset. */
export function volumePreset(kind: VolumeEffect["kind"], name: string = kind): VolumeEffect {
  const base = { name, kind, resolution: 32, source: "fluid" as const, color: [0.5, 0.5, 0.52] as [number, number, number] };
  switch (kind) {
    case "smoke":
      return { ...base, size: 4, duration: 8, buoyancy: 1.5, dissipation: 0.15, cooling: 0.8, absorption: 2.5, temperature: 0, emission: 0, light: 0 };
    case "fire":
      return { ...base, size: 2, duration: 6, buoyancy: 4, dissipation: 0.4, cooling: 1.5, absorption: 1.2, temperature: 1600, emission: 4, light: 600 };
    case "explosion":
      return { ...base, size: 6, duration: 4, buoyancy: 3, dissipation: 0.35, cooling: 1.2, absorption: 2, temperature: 2200, emission: 8, light: 4000 };
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Read stored volume effects defensively. */
export function parseVolumeEffects(value: unknown): VolumeEffect[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap((raw: Record<string, unknown>) => {
    if (!raw || typeof raw.name !== "string" || !["smoke", "fire", "explosion"].includes(raw.kind as string)) return [];
    const preset = volumePreset(raw.kind as VolumeEffect["kind"], raw.name.slice(0, 64));
    const num = (key: keyof VolumeEffect, lo: number, hi: number) => (finite(raw[key]) ? clamp(raw[key] as number, lo, hi) : (preset[key] as number));
    const color = Array.isArray(raw.color) && raw.color.length === 3 && raw.color.every(finite) ? (raw.color.map((c: number) => clamp(c, 0, 1)) as [number, number, number]) : preset.color;
    return [{
      ...preset,
      size: num("size", 0.1, 100),
      resolution: Math.round(num("resolution", 8, MAX_VOLUME_RESOLUTION)),
      duration: num("duration", 0.1, 120),
      source: raw.source === "baked" ? "baked" : "fluid",
      buoyancy: num("buoyancy", 0, 50),
      dissipation: num("dissipation", 0, 10),
      cooling: num("cooling", 0, 10),
      color,
      absorption: num("absorption", 0, 100),
      temperature: num("temperature", 0, 10000),
      emission: num("emission", 0, 1000),
      light: num("light", 0, 1e6),
    }];
  });
}

// --- The solver ---------------------------------------------------------------

/** A fluid grid: n³ cells of velocity (3), density and temperature, cell-centred, edges solid (the box's walls). */
export class FluidGrid {
  readonly n: number;
  velocity: Float32Array;
  density: Float32Array;
  temperature: Float32Array;
  constructor(n: number) {
    this.n = n;
    this.velocity = new Float32Array(n * n * n * 3);
    this.density = new Float32Array(n * n * n);
    this.temperature = new Float32Array(n * n * n);
  }

  index(x: number, y: number, z: number): number {
    return (z * this.n + y) * this.n + x;
  }

  /** The total density (for conservation). */
  get mass(): number {
    return this.density.reduce((a, b) => a + b, 0);
  }
}

/** A field's value at a cell-space point, trilinear, clamped to the grid (as the GPU's textureLoad-based sampler). */
export function sampleField(field: Float32Array, n: number, components: number, x: number, y: number, z: number, c = 0): number {
  const cx = clamp(x - 0.5, 0, n - 1);
  const cy = clamp(y - 0.5, 0, n - 1);
  const cz = clamp(z - 0.5, 0, n - 1);
  const x0 = Math.min(n - 2, Math.floor(cx));
  const y0 = Math.min(n - 2, Math.floor(cy));
  const z0 = Math.min(n - 2, Math.floor(cz));
  const fx = cx - x0;
  const fy = cy - y0;
  const fz = cz - z0;
  const at = (i: number, j: number, k: number) => field[((k * n + j) * n + i) * components + c]!;
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(at(x0, y0, z0), at(x0 + 1, y0, z0), fx), l(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), fx), fy),
    l(l(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), fx), l(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), fx), fy),
    fz,
  );
}

/** A source: density and heat added in a ball (cell space), pushed with a velocity. */
export interface FluidSource {
  readonly center: V3;
  readonly radius: number;
  readonly density: number;
  readonly temperature: number;
  readonly velocity: V3;
}

/**
 * One step of the solver (seconds `dt`, cells a second for velocity): the
 * sources and buoyancy, advection, projection, dissipation. `cellSize` turns
 * the effect's metres into cells.
 */
export function stepFluid(grid: FluidGrid, effect: Pick<VolumeEffect, "buoyancy" | "dissipation" | "cooling">, sources: readonly FluidSource[], dt: number, iterations = PRESSURE_ITERATIONS): void {
  const n = grid.n;
  const cells = n * n * n;
  // Forces: the sources, and heat rising.
  for (let z = 0; z < n; z += 1)
    for (let y = 0; y < n; y += 1)
      for (let x = 0; x < n; x += 1) {
        const i = grid.index(x, y, z);
        for (const s of sources) {
          const d = Math.hypot(x + 0.5 - s.center[0], y + 0.5 - s.center[1], z + 0.5 - s.center[2]);
          if (d >= s.radius) continue;
          const w = 1 - d / s.radius;
          grid.density[i] = grid.density[i]! + s.density * w * dt;
          grid.temperature[i] = grid.temperature[i]! + s.temperature * w * dt;
          for (let k = 0; k < 3; k += 1) grid.velocity[i * 3 + k] = grid.velocity[i * 3 + k]! + s.velocity[k]! * w * dt;
        }
        grid.velocity[i * 3 + 1] = grid.velocity[i * 3 + 1]! + effect.buoyancy * grid.temperature[i]! * dt;
      }
  // Advection: each cell takes what was a step upstream.
  const velocity = new Float32Array(cells * 3);
  const density = new Float32Array(cells);
  const temperature = new Float32Array(cells);
  for (let z = 0; z < n; z += 1)
    for (let y = 0; y < n; y += 1)
      for (let x = 0; x < n; x += 1) {
        const i = grid.index(x, y, z);
        const px = x + 0.5 - grid.velocity[i * 3]! * dt;
        const py = y + 0.5 - grid.velocity[i * 3 + 1]! * dt;
        const pz = z + 0.5 - grid.velocity[i * 3 + 2]! * dt;
        for (let k = 0; k < 3; k += 1) velocity[i * 3 + k] = sampleField(grid.velocity, n, 3, px, py, pz, k);
        density[i] = sampleField(grid.density, n, 1, px, py, pz);
        temperature[i] = sampleField(grid.temperature, n, 1, px, py, pz);
      }
  grid.velocity = velocity;
  grid.density = density;
  grid.temperature = temperature;
  project(grid, iterations);
  // Dissipation, and the walls: no flow through them.
  const keepDensity = Math.exp(-effect.dissipation * dt);
  const keepHeat = Math.exp(-effect.cooling * dt);
  for (let i = 0; i < cells; i += 1) {
    grid.density[i] = grid.density[i]! * keepDensity;
    grid.temperature[i] = grid.temperature[i]! * keepHeat;
  }
}

/** The velocity's divergence at a cell (central differences; the walls' neighbours mirror it, so no flow crosses them). */
export function divergence(grid: FluidGrid, x: number, y: number, z: number): number {
  const n = grid.n;
  const v = (i: number, j: number, k: number, c: number) => {
    // Beyond a wall the normal component is the cell's own, negated: a solid boundary.
    let sign = 1;
    let ii = i, jj = j, kk = k;
    if (i < 0 || i >= n) { ii = Math.max(0, Math.min(n - 1, i)); if (c === 0) sign = -1; }
    if (j < 0 || j >= n) { jj = Math.max(0, Math.min(n - 1, j)); if (c === 1) sign = -1; }
    if (k < 0 || k >= n) { kk = Math.max(0, Math.min(n - 1, k)); if (c === 2) sign = -1; }
    return sign * grid.velocity[grid.index(ii, jj, kk) * 3 + c]!;
  };
  return 0.5 * (v(x + 1, y, z, 0) - v(x - 1, y, z, 0) + v(x, y + 1, z, 1) - v(x, y - 1, z, 1) + v(x, y, z + 1, 2) - v(x, y, z - 1, 2));
}

/** Projection: the pressure by Jacobi iterations, then its gradient taken from the velocity (Jacobi, as the GPU runs it). */
export function project(grid: FluidGrid, iterations = PRESSURE_ITERATIONS): void {
  const n = grid.n;
  const cells = n * n * n;
  const div = new Float32Array(cells);
  for (let z = 0; z < n; z += 1) for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) div[grid.index(x, y, z)] = divergence(grid, x, y, z);
  let p = new Float32Array(cells);
  let next = new Float32Array(cells);
  const at = (f: Float32Array, i: number, j: number, k: number) => f[grid.index(Math.max(0, Math.min(n - 1, i)), Math.max(0, Math.min(n - 1, j)), Math.max(0, Math.min(n - 1, k)))]!;
  for (let it = 0; it < iterations; it += 1) {
    for (let z = 0; z < n; z += 1)
      for (let y = 0; y < n; y += 1)
        for (let x = 0; x < n; x += 1) {
          const sum = at(p, x - 1, y, z) + at(p, x + 1, y, z) + at(p, x, y - 1, z) + at(p, x, y + 1, z) + at(p, x, y, z - 1) + at(p, x, y, z + 1);
          next[grid.index(x, y, z)] = (sum - div[grid.index(x, y, z)]!) / 6;
        }
    [p, next] = [next, p];
  }
  for (let z = 0; z < n; z += 1)
    for (let y = 0; y < n; y += 1)
      for (let x = 0; x < n; x += 1) {
        const i = grid.index(x, y, z);
        grid.velocity[i * 3] = grid.velocity[i * 3]! - 0.5 * (at(p, x + 1, y, z) - at(p, x - 1, y, z));
        grid.velocity[i * 3 + 1] = grid.velocity[i * 3 + 1]! - 0.5 * (at(p, x, y + 1, z) - at(p, x, y - 1, z));
        grid.velocity[i * 3 + 2] = grid.velocity[i * 3 + 2]! - 0.5 * (at(p, x, y, z + 1) - at(p, x, y, z - 1));
      }
}

/** The source an effect puts at the bottom centre of its grid, for its first seconds (an explosion's a burst at the middle). */
export function effectSources(effect: VolumeEffect, n: number, t: number): FluidSource[] {
  if (effect.kind === "explosion") {
    if (t > 0.25) return [];
    return [{ center: [n / 2, n * 0.35, n / 2], radius: n * 0.18, density: 40, temperature: 30, velocity: [0, n * 2, 0] }];
  }
  if (t > effect.duration * 0.7) return [];
  const heat = effect.kind === "fire" ? 12 : 3;
  return [{ center: [n / 2, n * 0.12, n / 2], radius: n * 0.12, density: effect.kind === "fire" ? 6 : 10, temperature: heat, velocity: [0, n * 0.5, 0] }];
}

/** A baked effect: its density and temperature at each frame (rate fps), as 8-bit (density / 4, temperature / 8 of the range). */
export interface BakedVolume {
  readonly n: number;
  readonly rate: number;
  readonly frames: readonly { readonly density: Uint8Array; readonly temperature: Uint8Array }[];
}

/** Bake an effect: the solver run on the CPU at `rate` frames a second for its duration. */
export function bakeVolume(effect: VolumeEffect, rate = 15, n = Math.min(effect.resolution, 24)): BakedVolume {
  const grid = new FluidGrid(n);
  const frames: { density: Uint8Array; temperature: Uint8Array }[] = [];
  const steps = Math.ceil(effect.duration * rate);
  for (let s = 0; s < steps; s += 1) {
    stepFluid(grid, effect, effectSources(effect, n, s / rate), 1 / rate, 12);
    frames.push({
      density: Uint8Array.from(grid.density, (d) => Math.round(clamp(d / 4, 0, 1) * 255)),
      temperature: Uint8Array.from(grid.temperature, (t) => Math.round(clamp(t / 8, 0, 1) * 255)),
    });
  }
  return { n, rate, frames };
}

// --- Light --------------------------------------------------------------------

/**
 * A blackbody's colour at `kelvin` (Tanner Helland's fit, linearised), with
 * its brightness rising as T⁴ relative to 1500 K, black below 500 K.
 */
export function blackbody(kelvin: number): V3 {
  if (kelvin < 500) return [0, 0, 0];
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const lin = (c: number) => {
    const v = clamp(c, 0, 255) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const power = (kelvin / 1500) ** 4;
  return [lin(r) * power, lin(g) * power, lin(b) * power];
}

/** How brightly a volume burns `t` seconds in (0..1): up fast, then fading over its life (an explosion's flash, a fire's steady burn). */
export function burn(effect: VolumeEffect, t: number): number {
  if (effect.temperature <= 0 || t < 0 || t > effect.duration) return 0;
  if (effect.kind === "explosion") return Math.min(1, t / 0.05) * Math.exp(-3 * t / effect.duration);
  return Math.min(1, t / 0.3) * Math.min(1, (effect.duration - t) / (effect.duration * 0.3));
}

/** The point light a burning volume casts at time `t`, centred in its lower half (where it burns), or null. */
export function volumeLight(effect: VolumeEffect, at: readonly number[], t: number): { position: V3; color: V3; intensity: number; range: number } | null {
  const b = burn(effect, t);
  if (b <= 0 || effect.light <= 0) return null;
  const c = blackbody(effect.temperature);
  const m = Math.max(c[0], c[1], c[2]) || 1;
  return { position: [at[0]!, at[1]! + effect.size * 0.3, at[2]!], color: [c[0] / m, c[1] / m, c[2] / m], intensity: effect.light * b, range: effect.size * 6 };
}
