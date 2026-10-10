/**
 * Dynamic bounce light (HALO_INFINITE_STYLE_ROADMAP.md I17): light probes that
 * relight as lights move, so a time of day or a moving light still bounces.
 *
 * A baked probe face holds sky visibility and one bounce of the sun (see
 * lightProbes.ts and lightmap.ts). The sky part depends only on the scene;
 * the bounce depends on the lights. So the bounce is recomputed, from a
 * transfer found once:
 *
 * 1. **Surfels.** The still scene is sampled into small patches on a grid
 *    (position, normal, albedo), one per cell and facing.
 * 2. **Transfer.** From each probe face, rays go out over its hemisphere as
 *    the bake's did; each that lands on the scene credits the surfel there
 *    with its share. Found once, a slice at a time
 *    ({@link BounceTransferBuilder}), so loading is never held up.
 * 3. **Relight.** Whenever the lights change, each surfel's direct light is
 *    worked out — the sun with a shadow ray (cached per sun direction), point
 *    lights in range with theirs — and each probe face gathers its surfels'
 *    reflected light.
 *
 * The relit grid is the baked one plus the difference between the bounce now
 * and the bounce under the light it was baked with, so with the baked lights
 * it is exactly the bake, and anything the transfer misses stays as baked.
 * Light units are the bake's: a sun of colour (1, 1, 1) is the baked sun.
 * Pure and DOM-free; deterministic.
 */

import { buildBvh, hash01, trace, type Bvh, type Occluder } from "./lightmap";
import { PROBE_FACES, probePosition, type LightProbeGrid } from "./lightProbes";

type V3 = [number, number, number];

/** A probe value's ceiling (the light map's range). */
const RANGE = 1.5;

export interface BounceOptions {
  /** How far a probe's rays reach (the bake's `distance`; default 8). */
  readonly distance?: number;
  /** How strongly lit surfaces bounce (the bake's `bounce`; default 0.9). */
  readonly bounce?: number;
  /** Rays per probe face (default 16). */
  readonly rays?: number;
  /** Surfel grid spacing, world units (default 0.75). */
  readonly spacing?: number;
}

/** The lights a relight uses, in the bake's units. */
export interface BounceLights {
  /** The sun: toward it, and its colour relative to the baked sun ((1, 1, 1) = as baked); null for none. */
  readonly sun: { readonly direction: readonly [number, number, number]; readonly color: readonly [number, number, number] } | null;
  /** Point lights: their colour in the same units (the sun's at its brightest), and their reach. */
  readonly points: readonly { readonly position: readonly [number, number, number]; readonly color: readonly [number, number, number]; readonly range: number }[];
}

/** The still scene sampled into patches. */
export interface Surfels {
  readonly count: number;
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly albedo: Float32Array;
  /** Surfels by grid cell and facing, for finding the one a ray lands on. */
  readonly cells: ReadonlyMap<string, number>;
  readonly spacing: number;
}

/** Everything a relight needs, found once per scene. */
export interface BounceTransfer {
  readonly grid: LightProbeGrid;
  readonly surfels: Surfels;
  /** Probe face k's credits are entries `start[k]`..`start[k + 1]`: a surfel and its share. */
  readonly start: Int32Array;
  readonly surfel: Int32Array;
  readonly weight: Float32Array;
  readonly bounce: number;
  readonly bvh: Bvh;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
}

/** The dominant axis direction of a normal, 0..5 (as the probe faces: +X −X +Y −Y +Z −Z). */
function facing(n: readonly number[]): number {
  const ax = Math.abs(n[0]!), ay = Math.abs(n[1]!), az = Math.abs(n[2]!);
  if (ax >= ay && ax >= az) return n[0]! >= 0 ? 0 : 1;
  if (ay >= az) return n[1]! >= 0 ? 2 : 3;
  return n[2]! >= 0 ? 4 : 5;
}
const cellKey = (p: readonly number[], s: number, f: number) => `${Math.floor(p[0]! / s)},${Math.floor(p[1]! / s)},${Math.floor(p[2]! / s)},${f}`;

/**
 * Sample the occluders' surfaces into surfels: points spread over each
 * triangle about `spacing / 2` apart, merged per grid cell and facing into
 * one patch (their mean position, normal and albedo).
 */
export function buildSurfels(occluders: readonly Occluder[], spacing = 0.75): Surfels {
  const sums = new Map<string, number[]>(); // px py pz nx ny nz r g b count
  const transform = (m: ArrayLike<number>, x: number, y: number, z: number): V3 => [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
  const step = spacing / 2;
  for (const o of occluders) {
    o.mesh.primitives.forEach((p, pi) => {
      const f = p.material.baseColorFactor;
      const textured = p.material.baseColorImage ? 0.55 : 1;
      const col = o.albedo?.[pi] ?? [f[0] * textured, f[1] * textured, f[2] * textured];
      for (let t = 0; t < p.indices.length; t += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => {
          const v = p.indices[t + k]!;
          return transform(o.model, p.positions[v * 3]!, p.positions[v * 3 + 1]!, p.positions[v * 3 + 2]!);
        }) as [V3, V3, V3];
        const cr = cross(sub(b, a), sub(c, a));
        const area = Math.hypot(cr[0], cr[1], cr[2]) / 2;
        if (area < 1e-9) continue;
        const n = normalize(cr);
        // Points on a barycentric lattice fine enough for the spacing (at least the centroid).
        const k = Math.max(1, Math.ceil(Math.sqrt(area) / step));
        for (let i = 0; i < k; i += 1) {
          for (let j = 0; i + j < k; j += 1) {
            const u = (i + 1 / 3) / k, v = (j + 1 / 3) / k;
            const w = 1 - u - v;
            const q: V3 = [a[0] * w + b[0] * u + c[0] * v, a[1] * w + b[1] * u + c[1] * v, a[2] * w + b[2] * u + c[2] * v];
            // Both sides can bounce (renderers draw both faces): file it under the side a probe would see — each side gets its own patch.
            for (const sign of [1, -1]) {
              const nn: V3 = [n[0] * sign, n[1] * sign, n[2] * sign];
              const key = cellKey(q, spacing, facing(nn));
              let s = sums.get(key);
              if (!s) sums.set(key, (s = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
              s[0]! += q[0]; s[1]! += q[1]; s[2]! += q[2];
              s[3]! += nn[0]; s[4]! += nn[1]; s[5]! += nn[2];
              s[6]! += col[0]!; s[7]! += col[1]!; s[8]! += col[2]!;
              s[9]! += 1;
            }
          }
        }
      }
    });
  }
  const count = sums.size;
  const position = new Float32Array(count * 3), normal = new Float32Array(count * 3), albedo = new Float32Array(count * 3);
  const cells = new Map<string, number>();
  let i = 0;
  for (const [key, s] of sums) {
    const m = s[9]!;
    position.set([s[0]! / m, s[1]! / m, s[2]! / m], i * 3);
    normal.set(normalize([s[3]!, s[4]!, s[5]!]), i * 3);
    albedo.set([s[6]! / m, s[7]! / m, s[8]! / m], i * 3);
    cells.set(key, i);
    i += 1;
  }
  return { count, position, normal, albedo, cells, spacing };
}

/** The surfel a hit lands on: its cell and facing, else the nearest neighbouring cell's. */
function surfelAt(s: Surfels, p: V3, n: V3): number {
  const f = facing(n);
  const exact = s.cells.get(cellKey(p, s.spacing, f));
  if (exact !== undefined) return exact;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
    const near = s.cells.get(cellKey([p[0] + dx * s.spacing, p[1] + dy * s.spacing, p[2] + dz * s.spacing], s.spacing, f));
    if (near !== undefined) return near;
  }
  return -1;
}

/**
 * The occluders' triangles that touch the box `min`–`max`, in world space (one
 * mesh per occluder, its primitives' materials kept): a far range of mountains
 * adds nothing to a probe's bounce, and would cost surfels and BVH nodes.
 */
export function clipOccluders(occluders: readonly Occluder[], min: readonly number[], max: readonly number[]): Occluder[] {
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const out: Occluder[] = [];
  for (const o of occluders) {
    const m = o.model;
    const primitives = o.mesh.primitives.flatMap((p) => {
      const positions: number[] = [];
      for (let t = 0; t < p.indices.length; t += 3) {
        const v = [0, 1, 2].map((k) => {
          const i = p.indices[t + k]! * 3;
          const x = p.positions[i]!, y = p.positions[i + 1]!, z = p.positions[i + 2]!;
          return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
        });
        const touches = [0, 1, 2].every((a) => Math.max(v[0]![a]!, v[1]![a]!, v[2]![a]!) >= min[a]! && Math.min(v[0]![a]!, v[1]![a]!, v[2]![a]!) <= max[a]!);
        if (touches) for (const q of v) positions.push(...q);
      }
      if (positions.length === 0) return [];
      return [{ positions: Float32Array.from(positions), normals: null, uvs: null, indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i), material: p.material }];
    });
    if (primitives.length > 0) out.push({ mesh: { name: o.mesh.name, primitives }, model: IDENTITY });
  }
  return out;
}

/**
 * Finds a grid's transfer a slice at a time: `step(n)` traces the next `n`
 * probe faces and says whether it is done; `result()` is the transfer once it
 * is (null before).
 */
export class BounceTransferBuilder {
  private readonly bvh: Bvh;
  private readonly surfels: Surfels;
  private readonly faces: number;
  private next = 0;
  private readonly start: number[] = [0];
  private readonly surfel: number[] = [];
  private readonly weight: number[] = [];
  private readonly distance: number;
  private readonly rays: number;
  private readonly bounce: number;
  private done: BounceTransfer | null = null;

  constructor(
    private readonly grid: LightProbeGrid,
    occluders: readonly Occluder[],
    options: BounceOptions = {},
  ) {
    this.distance = options.distance ?? 8;
    // Only what a probe's rays can reach bounces into it: the scene clipped to the grid's box grown by their reach.
    const near = clipOccluders(occluders, grid.min.map((v) => v - this.distance), grid.max.map((v) => v + this.distance));
    this.bvh = buildBvh(near);
    this.surfels = buildSurfels(near, options.spacing ?? 0.75);
    this.faces = grid.counts[0] * grid.counts[1] * grid.counts[2] * 6;
    this.rays = Math.max(4, Math.round(options.rays ?? 16));
    this.bounce = options.bounce ?? 0.9;
  }

  /** Trace up to `n` more probe faces; true once every face is done. */
  step(n: number): boolean {
    if (this.done) return true;
    const [nx, ny] = this.grid.counts;
    const hit = new Float64Array(2);
    const sq = Math.ceil(Math.sqrt(this.rays));
    for (let k = 0; k < n && this.next < this.faces; k += 1, this.next += 1) {
      const face = this.next % 6;
      const probe = (this.next - face) / 6;
      const x = probe % nx, y = Math.floor(probe / nx) % ny, z = Math.floor(probe / (nx * ny));
      const pos = probePosition(this.grid, x, y, z);
      const d = PROBE_FACES[face]! as V3;
      const ref: V3 = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const tx = normalize(cross(ref, d));
      const ty = cross(d, tx);
      const origin: V3 = [pos[0] + d[0] * 0.01, pos[1] + d[1] * 0.01, pos[2] + d[2] * 0.01];
      const credit = new Map<number, number>();
      for (let r = 0; r < this.rays; r += 1) {
        // Stratified cosine-weighted, as the bake's.
        const su = ((r % sq) + hash01(this.next * 31 + r)) / sq;
        const sv = (Math.floor(r / sq) + hash01(this.next * 17 + r * 7)) / sq;
        const phi = 2 * Math.PI * su;
        const rad = Math.sqrt(Math.min(1, sv));
        const lx = Math.cos(phi) * rad, ly = Math.sin(phi) * rad, lz = Math.sqrt(Math.max(0, 1 - sv));
        const dir: V3 = [tx[0] * lx + ty[0] * ly + d[0] * lz, tx[1] * lx + ty[1] * ly + d[1] * lz, tx[2] * lx + ty[2] * ly + d[2] * lz];
        const t = trace(this.bvh, origin, dir, this.distance, hit, false);
        if (t < 0) continue;
        const hn: V3 = [this.bvh.nrm[t * 3]!, this.bvh.nrm[t * 3 + 1]!, this.bvh.nrm[t * 3 + 2]!];
        const toward: V3 = dot(hn, dir) < 0 ? hn : [-hn[0], -hn[1], -hn[2]];
        const at: V3 = [origin[0] + dir[0] * hit[0]!, origin[1] + dir[1] * hit[0]!, origin[2] + dir[2] * hit[0]!];
        const s = surfelAt(this.surfels, at, toward);
        if (s >= 0) credit.set(s, (credit.get(s) ?? 0) + 1 / this.rays);
      }
      for (const [s, w] of credit) {
        this.surfel.push(s);
        this.weight.push(w);
      }
      this.start.push(this.surfel.length);
    }
    if (this.next >= this.faces) {
      this.done = {
        grid: this.grid,
        surfels: this.surfels,
        start: Int32Array.from(this.start),
        surfel: Int32Array.from(this.surfel),
        weight: Float32Array.from(this.weight),
        bounce: this.bounce,
        bvh: this.bvh,
      };
    }
    return this.done !== null;
  }

  /** The share of probe faces traced so far, 0..1. */
  progress(): number {
    return this.faces === 0 ? 1 : this.next / this.faces;
  }

  result(): BounceTransfer | null {
    return this.done;
  }
}

/** Find a grid's whole transfer at once (tests, tools; the player builds it a slice at a time). */
export function buildBounceTransfer(grid: LightProbeGrid, occluders: readonly Occluder[], options: BounceOptions = {}): BounceTransfer {
  const builder = new BounceTransferBuilder(grid, occluders, options);
  builder.step(Infinity);
  return builder.result()!;
}

const sunVisibility = new WeakMap<BounceTransfer, Map<string, Uint8Array>>();

/** Each surfel's reflected light under `lights` (RGB, the bake's units): its albedo times the light reaching it. */
export function surfelLight(t: BounceTransfer, lights: BounceLights): Float32Array {
  const s = t.surfels;
  const out = new Float32Array(s.count * 3);
  const hit = new Float64Array(2);
  if (lights.sun) {
    const dir = normalize([...lights.sun.direction] as V3);
    // Which surfels see the sun, traced once per direction (to a tenth of a degree or so).
    const key = dir.map((v) => v.toFixed(3)).join(",");
    let byDir = sunVisibility.get(t);
    if (!byDir) sunVisibility.set(t, (byDir = new Map()));
    let lit = byDir.get(key);
    if (!lit) {
      lit = new Uint8Array(s.count);
      for (let i = 0; i < s.count; i += 1) {
        const n = [s.normal[i * 3]!, s.normal[i * 3 + 1]!, s.normal[i * 3 + 2]!];
        if (dot(n, dir) <= 0) continue;
        const o: V3 = [s.position[i * 3]! + n[0]! * 0.02, s.position[i * 3 + 1]! + n[1]! * 0.02, s.position[i * 3 + 2]! + n[2]! * 0.02];
        lit[i] = trace(t.bvh, o, dir, 200, hit, true) >= 0 ? 0 : 1;
      }
      if (byDir.size > 64) byDir.clear();
      byDir.set(key, lit);
    }
    const c = lights.sun.color;
    for (let i = 0; i < s.count; i += 1) {
      if (!lit[i]) continue;
      const ndl = s.normal[i * 3]! * dir[0] + s.normal[i * 3 + 1]! * dir[1] + s.normal[i * 3 + 2]! * dir[2];
      for (let k = 0; k < 3; k += 1) out[i * 3 + k] = out[i * 3 + k]! + s.albedo[i * 3 + k]! * c[k]! * ndl;
    }
  }
  for (const light of lights.points) {
    const r = Math.max(1e-3, light.range);
    for (let i = 0; i < s.count; i += 1) {
      const to: V3 = [light.position[0] - s.position[i * 3]!, light.position[1] - s.position[i * 3 + 1]!, light.position[2] - s.position[i * 3 + 2]!];
      const d = Math.hypot(to[0], to[1], to[2]);
      if (d >= r || d < 1e-6) continue;
      const l: V3 = [to[0] / d, to[1] / d, to[2] / d];
      const ndl = s.normal[i * 3]! * l[0] + s.normal[i * 3 + 1]! * l[1] + s.normal[i * 3 + 2]! * l[2];
      if (ndl <= 0) continue;
      // A wall between the light and the patch keeps its light from bouncing.
      const o: V3 = [s.position[i * 3]! + s.normal[i * 3]! * 0.02, s.position[i * 3 + 1]! + s.normal[i * 3 + 1]! * 0.02, s.position[i * 3 + 2]! + s.normal[i * 3 + 2]! * 0.02];
      if (trace(t.bvh, o, l, d - 0.05, hit, true) >= 0) continue;
      const fall = (1 - d / r) ** 2;
      for (let k = 0; k < 3; k += 1) out[i * 3 + k] = out[i * 3 + k]! + s.albedo[i * 3 + k]! * light.color[k]! * ndl * fall;
    }
  }
  return out;
}

/** Each probe face's bounce (RGB) from the surfels' reflected light. */
export function probeBounce(t: BounceTransfer, light: Float32Array): Float32Array {
  const faces = t.start.length - 1;
  const out = new Float32Array(faces * 3);
  for (let f = 0; f < faces; f += 1) {
    let r = 0, g = 0, b = 0;
    for (let e = t.start[f]!; e < t.start[f + 1]!; e += 1) {
      const s = t.surfel[e]! * 3;
      const w = t.weight[e]!;
      r += light[s]! * w;
      g += light[s + 1]! * w;
      b += light[s + 2]! * w;
    }
    out[f * 3] = r * t.bounce;
    out[f * 3 + 1] = g * t.bounce;
    out[f * 3 + 2] = b * t.bounce;
  }
  return out;
}

/** The baked grid relit: its values plus the bounce now, less the bounce it was baked with. */
export function relightProbes(t: BounceTransfer, now: Float32Array, baked: Float32Array): LightProbeGrid {
  const values = new Float32Array(t.grid.values.length);
  for (let i = 0; i < values.length; i += 1) values[i] = Math.min(RANGE, Math.max(0, t.grid.values[i]! + (now[i] ?? 0) - (baked[i] ?? 0)));
  return { ...t.grid, values };
}
