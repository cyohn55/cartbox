/**
 * The runtime side of decals (HALO2_STYLE_ROADMAP.md, H6; see decals.ts):
 * marks laid flat on surfaces, written into one live mesh — a primitive per
 * decal — that the scene draws with everything else, so walls in front hide
 * them on every backend. Each mark sits a hair off its surface (so it doesn't
 * fight it for depth) and turns a random amount about the normal so repeats
 * don't line up. A cart-laid mark fades over the last third of its life by
 * dissolving (the renderers draw opaque texels only); permanent marks stay.
 */

import type { MeshAsset, MeshMaterial, MeshPrimitive } from "../model/MeshAsset";
import { MAX_MARKS_PER_DECAL, type DecalDef, type DecalMark } from "../model/decals";
import { composeModelMatrix, type DecodedTexture, type MeshSceneInstance } from "./meshRasterizer";

type V3 = [number, number, number];

/** Frames in a decal's atlas: fresh, then dissolving away. */
export const DECAL_FRAMES = 8;
const SIZE = 32;
/** How far off its surface a mark sits, world units. */
export const DECAL_OFFSET = 0.012;

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** Tileable-enough hash noise in 0..1. */
function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function smoothNoise(x: number, y: number, cell: number, seed: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = hash(x0, y0, seed) + (hash(x0 + 1, y0, seed) - hash(x0, y0, seed)) * sx;
  const bottom = hash(x0, y0 + 1, seed) + (hash(x0 + 1, y0 + 1, seed) - hash(x0, y0 + 1, seed)) * sx;
  return top + (bottom - top) * sy;
}

/**
 * How much of a pattern covers a texel (0..1) and how bright it is there, at
 * u, v in −1..1 across the mark.
 */
function coverage(pattern: DecalDef["pattern"], u: number, v: number, px: number, py: number): [number, number] {
  const r = Math.hypot(u, v);
  const a = Math.atan2(v, u);
  switch (pattern) {
    case "pock": {
      // A dark crater, a pale rim, and a few radial cracks.
      const crack = Math.abs(Math.sin(a * 5 + 1.3)) > 0.93 && r < 0.95 ? 1 : 0;
      const crater = r < 0.45 ? 1 : r < 0.62 ? 0.8 : 0;
      return [Math.max(crater, crack * (1 - r)), r > 0.45 && r < 0.62 ? 1.6 : r < 0.3 ? 0.5 : 1];
    }
    case "scorch": {
      const n = smoothNoise(px, py, 5, 11);
      const blob = 1 - r + (n - 0.5) * 0.7;
      return [blob > 0.25 ? 1 : 0, 0.4 + blob];
    }
    case "burn": {
      // A soot star: long rays out from a black core, ragged at the edge.
      const n = smoothNoise(px, py, 4, 23);
      const rays = 0.55 + 0.45 * Math.pow(Math.abs(Math.cos(a * 4.5 + n * 2)), 3);
      const inside = r < rays * (0.75 + n * 0.3);
      return [inside ? 1 : 0, 1.2 - r];
    }
    case "glyph": {
      // A Forerunner-style glyph: a ring broken by bars, with a notched centre line.
      const ring = Math.abs(r - 0.7) < 0.09 && Math.abs(Math.sin(a * 3)) > 0.35;
      const bar = Math.abs(u) < 0.08 && Math.abs(v) < 0.55;
      const cross = Math.abs(v) < 0.06 && Math.abs(u) > 0.25 && Math.abs(u) < 0.5;
      const notch = Math.abs(v - 0.35) < 0.05 && Math.abs(u) < 0.25;
      return [ring || bar || cross || notch ? 1 : 0, 1];
    }
    case "frost": {
      // Wind-blown streaks, thickest at the top, thinning down the surface.
      const streak = smoothNoise(px * 3, py * 0.35, 3, 31);
      const edge = 1 - Math.max(Math.abs(u), 0) ** 4;
      const fall = 1 - (v + 1) / 2;
      return [streak * edge * (0.4 + fall) > 0.5 ? 1 : 0, 0.8 + streak * 0.3];
    }
  }
}

/** A decal's atlas: {@link DECAL_FRAMES} frames side by side, fresh first, each later one dissolved further. */
export function decalAtlas(def: DecalDef): DecodedTexture {
  const width = DECAL_FRAMES * SIZE;
  const data = new Uint8ClampedArray(width * SIZE * 4);
  for (let f = 0; f < DECAL_FRAMES; f += 1) {
    const keep = 1 - f / DECAL_FRAMES;
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const u = ((x + 0.5) / SIZE) * 2 - 1;
        const v = ((y + 0.5) / SIZE) * 2 - 1;
        const [cover, bright] = coverage(def.pattern, u, v, x, y);
        if (cover <= 0 || keep < BAYER[(y % 4) * 4 + (x % 4)]! || Math.max(Math.abs(u), Math.abs(v)) > 0.97) continue;
        const o = (y * width + f * SIZE + x) * 4;
        data[o] = def.color[0] * bright * 255;
        data[o + 1] = def.color[1] * bright * 255;
        data[o + 2] = def.color[2] * bright * 255;
        data[o + 3] = 255;
      }
    }
  }
  return { width, height: SIZE, data };
}

interface Mark {
  at: V3;
  normal: V3;
  size: number;
  spin: number;
  age: number;
  permanent: boolean;
}

interface Pool {
  readonly def: DecalDef;
  readonly capacity: number;
  readonly marks: Mark[];
  readonly primitive: MeshPrimitive;
  readonly atlas: DecodedTexture;
  dirty: boolean;
}

export class DecalSystem {
  private readonly pools: Pool[];
  private readonly byName = new Map<string, number>();
  private readonly instance: MeshSceneInstance;
  private spinSeed = 1;

  constructor(defs: readonly DecalDef[], marks: readonly DecalMark[] = []) {
    const permanent = new Map<string, number>();
    for (const m of marks) permanent.set(m.decal, (permanent.get(m.decal) ?? 0) + 1);
    this.pools = defs.map((def, i) => {
      this.byName.set(def.name, i);
      const capacity = MAX_MARKS_PER_DECAL + (permanent.get(def.name) ?? 0);
      const indices = new Uint32Array(capacity * 6);
      for (let q = 0; q < capacity; q += 1) indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
      const glow = def.glow > 0;
      const material: MeshMaterial = {
        name: `decal:${def.name}`,
        baseColorFactor: glow ? [0.2, 0.2, 0.2, 1] : [1, 1, 1, 1],
        baseColorImage: null,
        metallicFactor: 0,
        roughnessFactor: 1,
        ...(glow ? { emissiveFactor: [def.glow, def.glow, def.glow] as [number, number, number] } : {}),
      };
      const primitive: MeshPrimitive = {
        positions: new Float32Array(capacity * 12),
        normals: new Float32Array(capacity * 12),
        uvs: new Float32Array(capacity * 8),
        indices,
        material,
        dynamic: { revision: 0 },
      };
      return { def, capacity, marks: [], primitive, atlas: decalAtlas(def), dirty: true };
    });
    for (const m of marks) {
      const i = this.byName.get(m.decal);
      if (i !== undefined) this.add(i, m.position, m.normal, m.size || this.pools[i]!.def.size, m.spin, true);
    }
    this.instance = {
      mesh: { name: "decals", primitives: this.pools.map((p) => p.primitive) } satisfies MeshAsset,
      model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]),
      textures: this.pools.map((p) => p.atlas),
      emissiveTextures: this.pools.map((p) => (p.def.glow > 0 ? p.atlas : null)),
    };
  }

  indexOf(name: string): number {
    return this.byName.get(name) ?? -1;
  }

  /** Marks on the surfaces now, across every decal. */
  get count(): number {
    return this.pools.reduce((n, p) => n + p.marks.length, 0);
  }

  /** Lay decal `index` at `at` on a surface facing `normal`; `scale` multiplies its size. */
  lay(index: number, at: readonly [number, number, number], normal: readonly [number, number, number], scale = 1): void {
    const pool = this.pools[index];
    if (!pool || !(scale > 0)) return;
    this.spinSeed = (Math.imul(this.spinSeed, 1103515245) + 12345) >>> 0;
    this.add(index, at, normal, pool.def.size * scale, (this.spinSeed / 4294967296) * 360, false);
  }

  private add(index: number, at: readonly [number, number, number], normal: readonly [number, number, number], size: number, spin: number, permanent: boolean): void {
    const pool = this.pools[index]!;
    const len = Math.hypot(normal[0], normal[1], normal[2]);
    if (len < 1e-6) return;
    const n: V3 = [normal[0] / len, normal[1] / len, normal[2] / len];
    if (!permanent && pool.marks.length >= pool.capacity) {
      // Recycle the oldest cart-laid mark.
      let oldest = -1;
      pool.marks.forEach((m, i) => {
        if (!m.permanent && (oldest < 0 || m.age > pool.marks[oldest]!.age)) oldest = i;
      });
      if (oldest < 0) return;
      pool.marks.splice(oldest, 1);
    }
    pool.marks.push({ at: [at[0], at[1], at[2]], normal: n, size, spin, age: 0, permanent });
    pool.dirty = true;
  }

  /** Age cart-laid marks by `dt` seconds; a faded one is taken away. */
  step(dt: number): void {
    for (const pool of this.pools) {
      const life = pool.def.life;
      if (life <= 0) continue;
      const before = pool.marks.length;
      for (const m of pool.marks) if (!m.permanent) m.age += dt;
      for (let i = pool.marks.length - 1; i >= 0; i -= 1) if (!pool.marks[i]!.permanent && pool.marks[i]!.age >= life) pool.marks.splice(i, 1);
      // A fading mark changes frame over its last third.
      if (pool.marks.length !== before || pool.marks.some((m) => !m.permanent && m.age > life * 0.66)) pool.dirty = true;
    }
  }

  /** The scene instance to draw (rewritten when marks changed), or null when there are none. */
  sceneInstance(): MeshSceneInstance | null {
    if (this.count === 0) return null;
    let anchor: V3 | null = null;
    for (const pool of this.pools) if (!anchor && pool.marks.length > 0) anchor = pool.marks[0]!.at;
    for (const pool of this.pools) {
      if (!pool.dirty) continue;
      pool.dirty = false;
      this.write(pool, anchor!);
      pool.primitive.dynamic!.revision += 1;
    }
    return this.instance;
  }

  private write(pool: Pool, anchor: V3): void {
    const { positions, normals, uvs } = pool.primitive as { positions: Float32Array; normals: Float32Array; uvs: Float32Array };
    const life = pool.def.life;
    for (let q = 0; q < pool.capacity; q += 1) {
      const p = q * 12;
      const m = pool.marks[q];
      if (!m) {
        for (let k = 0; k < 12; k += 3) positions.set(anchor, p + k);
        continue;
      }
      // A tangent frame on the surface, turned by the mark's spin.
      const n = m.normal;
      const helper: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let t = cross(helper, n);
      const tl = Math.hypot(t[0], t[1], t[2]);
      t = [t[0] / tl, t[1] / tl, t[2] / tl];
      const b = cross(n, t);
      const rad = (m.spin * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      const h = m.size / 2;
      const ax: V3 = [(t[0] * c + b[0] * s) * h, (t[1] * c + b[1] * s) * h, (t[2] * c + b[2] * s) * h];
      const ay: V3 = [(b[0] * c - t[0] * s) * h, (b[1] * c - t[1] * s) * h, (b[2] * c - t[2] * s) * h];
      const o: V3 = [m.at[0] + n[0] * DECAL_OFFSET, m.at[1] + n[1] * DECAL_OFFSET, m.at[2] + n[2] * DECAL_OFFSET];
      const corners = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ] as const;
      corners.forEach(([sx, sy], k) => {
        positions[p + k * 3] = o[0] + ax[0] * sx + ay[0] * sy;
        positions[p + k * 3 + 1] = o[1] + ax[1] * sx + ay[1] * sy;
        positions[p + k * 3 + 2] = o[2] + ax[2] * sx + ay[2] * sy;
        normals.set(n, p + k * 3);
      });
      // Fresh until two thirds of its life, then dissolving frame by frame.
      const fade = m.permanent || life <= 0 ? 0 : Math.max(0, (m.age / life - 0.66) / 0.34);
      const frame = Math.min(DECAL_FRAMES - 1, Math.floor(fade * DECAL_FRAMES));
      const u0 = (frame + 0.5 / SIZE) / DECAL_FRAMES;
      const u1 = (frame + 1 - 0.5 / SIZE) / DECAL_FRAMES;
      uvs.set([u0, 0, u1, 0, u1, 1, u0, 1], q * 8);
    }
  }
}

function cross(a: readonly [number, number, number], b: readonly [number, number, number]): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
