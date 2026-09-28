/**
 * The runtime side of 3D particle effects (HALO2_STYLE_ROADMAP.md, H5; see
 * particleEffects.ts): bursts spawn particles, `step` moves them, and
 * `mesh` writes them into one live mesh of camera-facing billboards — a
 * primitive per effect — that the scene draws like any other object, so the
 * depth buffer hides them behind walls on every backend.
 *
 * A particle's look comes from its effect's sprite atlas: 16 frames across its
 * life, each a round sprite in that moment's colour, shrinking and breaking up
 * as it dies (the renderers draw opaque texels and drop transparent ones, so
 * the fade is a dissolve rather than a blend). Glowing effects are emissive, so
 * the post-effects' bloom makes them flare.
 */

import type { MeshAsset, MeshMaterial, MeshPrimitive } from "../model/MeshAsset";
import { MAX_PARTICLES_PER_EFFECT, type ParticleEffect } from "../model/particleEffects";
import { composeModelMatrix, type DecodedTexture, type MeshSceneInstance } from "./meshRasterizer";

type V3 = [number, number, number];

/** Frames in an effect's sprite atlas (across a particle's life), and their size in texels. */
export const PARTICLE_FRAMES = 16;
const FRAME = 16;

/** A 4×4 ordered-dither threshold (0..1), for the dissolving edge. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/**
 * An effect's sprite atlas: {@link PARTICLE_FRAMES} frames side by side, each a
 * round sprite in the colour of that point in its life, brightest at its core,
 * its edge dithered away as it dies.
 */
export function particleAtlas(effect: ParticleEffect): DecodedTexture {
  const width = PARTICLE_FRAMES * FRAME;
  const data = new Uint8ClampedArray(width * FRAME * 4);
  const half = FRAME / 2;
  for (let f = 0; f < PARTICLE_FRAMES; f += 1) {
    const t = f / (PARTICLE_FRAMES - 1);
    const c = [0, 1, 2].map((k) => effect.color[k]! + (effect.colorEnd[k]! - effect.color[k]!) * t);
    // Past 60% of its life the sprite thins out: fewer texels survive the dither.
    const keep = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
    for (let y = 0; y < FRAME; y += 1) {
      for (let x = 0; x < FRAME; x += 1) {
        const dx = (x + 0.5 - half) / (half - 1);
        const dy = (y + 0.5 - half) / (half - 1);
        const d = Math.hypot(dx, dy);
        const o = (y * width + f * FRAME + x) * 4;
        // Inside the disc, and — towards its rim and late in life — past the dither.
        const edge = Math.max(0, 1 - d) * 1.6 * keep;
        if (d >= 1 || edge < BAYER[(y % 4) * 4 + (x % 4)]!) continue;
        const core = 1 - 0.45 * d * d;
        data[o] = c[0]! * core * 255;
        data[o + 1] = c[1]! * core * 255;
        data[o + 2] = c[2]! * core * 255;
        data[o + 3] = 255;
      }
    }
  }
  return { width, height: FRAME, data };
}

/** A small deterministic generator (mulberry32), so a burst looks the same in a replay. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Pool {
  readonly effect: ParticleEffect;
  readonly capacity: number;
  /** Per particle: position (3), velocity (3), age, life. */
  readonly state: Float32Array;
  /** Live particles are the first `count`. */
  count: number;
  readonly primitive: MeshPrimitive;
  readonly atlas: DecodedTexture;
}

const STRIDE = 8;

export class ParticleSystem {
  private readonly pools: Pool[];
  private readonly byName = new Map<string, number>();
  private readonly random: () => number;
  private readonly mesh: MeshAsset;
  private readonly instance: MeshSceneInstance;
  private readonly identity = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);

  constructor(effects: readonly ParticleEffect[], seed = 1) {
    this.random = rng(seed);
    this.pools = effects.map((effect, i) => {
      this.byName.set(effect.name, i);
      const capacity = Math.min(MAX_PARTICLES_PER_EFFECT, Math.max(effect.count * 6, 16));
      const indices = new Uint32Array(capacity * 6);
      const uvs = new Float32Array(capacity * 8);
      for (let q = 0; q < capacity; q += 1) indices.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
      const glow = effect.glow > 0;
      const material: MeshMaterial = {
        name: `particles:${effect.name}`,
        // Glowing sprites are black and emit their colour; others are lit, rough and matte.
        baseColorFactor: glow ? [0, 0, 0, 1] : [1, 1, 1, 1],
        baseColorImage: null,
        metallicFactor: 0,
        roughnessFactor: 1,
        ...(glow ? { emissiveFactor: [effect.glow, effect.glow, effect.glow] as [number, number, number] } : {}),
      };
      const primitive: MeshPrimitive = {
        positions: new Float32Array(capacity * 12),
        normals: new Float32Array(capacity * 12),
        uvs,
        indices,
        material,
        dynamic: { revision: 0 },
      };
      return { effect, capacity, state: new Float32Array(capacity * STRIDE), count: 0, primitive, atlas: particleAtlas(effect) };
    });
    this.mesh = { name: "particles", primitives: this.pools.map((p) => p.primitive) };
    this.instance = {
      mesh: this.mesh,
      model: this.identity,
      textures: this.pools.map((p) => p.atlas),
      emissiveTextures: this.pools.map((p) => (p.effect.glow > 0 ? p.atlas : null)),
    };
  }

  /** The index of an effect by name, or -1. */
  indexOf(name: string): number {
    return this.byName.get(name) ?? -1;
  }

  /** Particles alive, across every effect. */
  get alive(): number {
    return this.pools.reduce((n, p) => n + p.count, 0);
  }

  /**
   * Fire effect `index` at `at`. A burst throws its particles along `dir`
   * (zero = every way); a trail lays them along the segment from `at` to
   * `at + dir`. `scale` multiplies the count, size and speed.
   */
  burst(index: number, at: readonly [number, number, number], dir: readonly [number, number, number] = [0, 0, 0], scale = 1): void {
    const pool = this.pools[index];
    if (!pool || !(scale > 0)) return;
    const e = pool.effect;
    const n = Math.max(1, Math.round(e.count * Math.min(scale, 4)));
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    const axis: V3 = len > 1e-6 ? [dir[0] / len, dir[1] / len, dir[2] / len] : [0, 1, 0];
    const spread = len > 1e-6 ? e.spread : 1;
    for (let k = 0; k < n; k += 1) {
      // A full pool recycles its oldest particle.
      let slot = pool.count;
      if (slot >= pool.capacity) {
        slot = 0;
        for (let i = 1; i < pool.count; i += 1) if (pool.state[i * STRIDE + 6]! > pool.state[slot * STRIDE + 6]!) slot = i;
      } else pool.count += 1;
      const s = slot * STRIDE;
      // Direction: the axis, bent by up to `spread` of a hemisphere (1 = a full sphere).
      const [rx, ry, rz] = randomUnit(this.random);
      const bend = spread * (spread >= 1 ? 1 : this.random());
      let vx = axis[0] * (1 - bend) + rx * bend;
      let vy = axis[1] * (1 - bend) + ry * bend;
      let vz = axis[2] * (1 - bend) + rz * bend;
      const vl = Math.hypot(vx, vy, vz) || 1;
      const speed = e.speed * scale * (1 + e.speedJitter * (this.random() * 2 - 1));
      vx = (vx / vl) * speed;
      vy = (vy / vl) * speed;
      vz = (vz / vl) * speed;
      const along = e.shape === "trail" ? this.random() : 0;
      pool.state[s] = at[0] + dir[0] * along;
      pool.state[s + 1] = at[1] + dir[1] * along;
      pool.state[s + 2] = at[2] + dir[2] * along;
      pool.state[s + 3] = vx;
      pool.state[s + 4] = vy;
      pool.state[s + 5] = vz;
      pool.state[s + 6] = 0;
      pool.state[s + 7] = Math.max(0.02, e.life * (1 + e.lifeJitter * (this.random() * 2 - 1)));
    }
  }

  /** Advance every particle by `dt` seconds; the dead are dropped. */
  step(dt: number): void {
    for (const pool of this.pools) {
      const e = pool.effect;
      const damp = Math.exp(-e.drag * dt);
      let i = 0;
      while (i < pool.count) {
        const s = i * STRIDE;
        const age = pool.state[s + 6]! + dt;
        if (age >= pool.state[s + 7]!) {
          // Swap the last live particle into this slot.
          pool.count -= 1;
          pool.state.copyWithin(s, pool.count * STRIDE, pool.count * STRIDE + STRIDE);
          continue;
        }
        pool.state[s + 6] = age;
        pool.state[s + 4] = pool.state[s + 4]! - e.gravity * dt;
        for (let k = 3; k < 6; k += 1) pool.state[s + k] = pool.state[s + k]! * damp;
        for (let k = 0; k < 3; k += 1) pool.state[s + k] = pool.state[s + k]! + pool.state[s + 3 + k]! * dt;
        i += 1;
      }
    }
  }

  /**
   * Write the live particles as billboards facing a camera looking along
   * `forward` with `up` roughly up (world space), and return the scene
   * instance to draw — or null when nothing is alive.
   */
  instanceFor(forward: readonly [number, number, number], up: readonly [number, number, number] = [0, 1, 0]): MeshSceneInstance | null {
    if (this.alive === 0) return null;
    const f = normalize(forward);
    let right = normalize(cross(f, up));
    if (!Number.isFinite(right[0])) right = [1, 0, 0];
    const camUp = cross(right, f);
    // Anchor where the dead quads collapse (inside the live ones' bounds, so culling stays right).
    let anchor: V3 | null = null;
    for (const pool of this.pools) {
      if (pool.count > 0 && !anchor) anchor = [pool.state[0]!, pool.state[1]!, pool.state[2]!];
    }
    for (const pool of this.pools) {
      const e = pool.effect;
      const { positions, normals, uvs } = pool.primitive as { positions: Float32Array; normals: Float32Array; uvs: Float32Array };
      for (let q = 0; q < pool.capacity; q += 1) {
        const p = q * 12;
        if (q >= pool.count) {
          for (let k = 0; k < 12; k += 3) positions.set(anchor!, p + k);
          continue;
        }
        const s = q * STRIDE;
        const t = pool.state[s + 6]! / pool.state[s + 7]!;
        const size = (e.size + (e.sizeEnd - e.size) * t) / 2;
        const c: V3 = [pool.state[s]!, pool.state[s + 1]!, pool.state[s + 2]!];
        let ax: V3 = [right[0] * size, right[1] * size, right[2] * size];
        let ay: V3 = [camUp[0] * size, camUp[1] * size, camUp[2] * size];
        if (e.stretch > 0) {
          // Streak along the velocity as the camera sees it.
          const v: V3 = [pool.state[s + 3]!, pool.state[s + 4]!, pool.state[s + 5]!];
          const vd = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
          const vs: V3 = [v[0] - f[0] * vd, v[1] - f[1] * vd, v[2] - f[2] * vd];
          const vl = Math.hypot(vs[0], vs[1], vs[2]);
          if (vl > 1e-4) {
            const dirA: V3 = [vs[0] / vl, vs[1] / vl, vs[2] / vl];
            const dirB = cross(dirA, f);
            const long = size + vl * e.stretch * 0.1;
            ax = [dirA[0] * long, dirA[1] * long, dirA[2] * long];
            ay = [dirB[0] * size, dirB[1] * size, dirB[2] * size];
          }
        }
        const corners = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ] as const;
        corners.forEach(([sx, sy], k) => {
          positions[p + k * 3] = c[0] + ax[0] * sx + ay[0] * sy;
          positions[p + k * 3 + 1] = c[1] + ax[1] * sx + ay[1] * sy;
          positions[p + k * 3 + 2] = c[2] + ax[2] * sx + ay[2] * sy;
          normals[p + k * 3] = -f[0];
          normals[p + k * 3 + 1] = -f[1];
          normals[p + k * 3 + 2] = -f[2];
        });
        // This moment of its life in the atlas (a frame's texel centres, so filtering never bleeds).
        const frame = Math.min(PARTICLE_FRAMES - 1, Math.floor(t * PARTICLE_FRAMES));
        const u0 = (frame + 0.5 / FRAME) / PARTICLE_FRAMES;
        const u1 = (frame + 1 - 0.5 / FRAME) / PARTICLE_FRAMES;
        uvs.set([u0, 0, u1, 0, u1, 1, u0, 1], q * 8);
      }
      pool.primitive.dynamic!.revision += 1;
    }
    return this.instance;
  }
}

function randomUnit(random: () => number): V3 {
  const z = random() * 2 - 1;
  const a = random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), z, r * Math.sin(a)];
}
function normalize(v: readonly [number, number, number]): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a: readonly [number, number, number], b: readonly [number, number, number]): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
