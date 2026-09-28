/**
 * 3D particle effects (HALO2_STYLE_ROADMAP.md, H5): named bursts a cart fires
 * in the world (`cartbox.burst`) — sparks off a wall, a plasma splash, a
 * grenade's blast, a puff of snow, a sword's glowing trail. Each effect is a
 * handful of numbers on the mesh sidecar; the runtime (particleSystem.ts)
 * simulates the particles and draws them as camera-facing billboards in the
 * scene, so walls hide them and bloom makes the glowing ones flare.
 *
 * The existing screen-space weather (the particle sidecar) is separate and
 * unchanged.
 */

type Rgb = readonly [number, number, number];

/** A starting point for an effect; the fields can then be tuned. */
export type ParticlePreset = "sparks" | "plasma" | "explosion" | "smoke" | "snow" | "trail";
export const PARTICLE_PRESETS: readonly ParticlePreset[] = ["sparks", "plasma", "explosion", "smoke", "snow", "trail"];

export interface ParticleEffect {
  readonly name: string;
  /**
   * `burst` throws particles out from the point (along the direction, widening
   * with `spread`); `trail` lays them along the segment from the point to the
   * point plus the direction, drifting slowly (a sword's arc, a tracer).
   */
  readonly shape: "burst" | "trail";
  /** Particles per burst (scaled by the burst's scale). */
  readonly count: number;
  /** Seconds a particle lives, ± `lifeJitter` (a fraction). */
  readonly life: number;
  readonly lifeJitter: number;
  /** Launch speed (units/s), ± `speedJitter` (a fraction). */
  readonly speed: number;
  readonly speedJitter: number;
  /** 0 = straight along the direction, 1 = every way. */
  readonly spread: number;
  /** Downward pull, units/s² (negative rises: smoke). */
  readonly gravity: number;
  /** Air drag, fraction of speed lost per second. */
  readonly drag: number;
  /** Billboard size at birth and at death, world units. */
  readonly size: number;
  readonly sizeEnd: number;
  /** Colour at birth and at death (0..1). */
  readonly color: Rgb;
  readonly colorEnd: Rgb;
  /** Glow strength: above 0 the particle emits light (and blooms) instead of being lit. */
  readonly glow: number;
  /** Streak along the velocity: 0 = round, 1 ≈ a streak as long as a tenth of a second's travel. */
  readonly stretch: number;
}

/** Most effects a scene may define, and most particles alive at once per effect. */
export const MAX_PARTICLE_EFFECTS = 24;
export const MAX_PARTICLES_PER_EFFECT = 512;

/** An effect from a preset, named `name`. */
export function particlePreset(preset: ParticlePreset, name: string = preset): ParticleEffect {
  const base = { name, shape: "burst" as const, lifeJitter: 0.3, speedJitter: 0.4, drag: 0.5, stretch: 0 };
  switch (preset) {
    case "sparks":
      return { ...base, count: 14, life: 0.35, speed: 7, spread: 0.55, gravity: 12, drag: 1.5, size: 0.05, sizeEnd: 0.02, color: [1, 0.85, 0.5], colorEnd: [1, 0.35, 0.05], glow: 3, stretch: 0.8 };
    case "plasma":
      return { ...base, count: 18, life: 0.5, speed: 3, spread: 0.8, gravity: 0, drag: 3, size: 0.12, sizeEnd: 0.04, color: [0.6, 0.95, 1], colorEnd: [0.1, 0.4, 1], glow: 3.5, stretch: 0.2 };
    case "explosion":
      return { ...base, count: 60, life: 0.7, speed: 9, spread: 1, gravity: 3, drag: 2.5, size: 0.45, sizeEnd: 0.1, color: [1, 0.9, 0.55], colorEnd: [0.9, 0.2, 0.02], glow: 2.5, stretch: 0.15 };
    case "smoke":
      return { ...base, count: 16, life: 1.8, speed: 1.2, spread: 1, gravity: -0.6, drag: 1.2, size: 0.3, sizeEnd: 1.1, color: [0.42, 0.42, 0.44], colorEnd: [0.62, 0.63, 0.66], glow: 0, stretch: 0 };
    case "snow":
      return { ...base, count: 24, life: 1.6, speed: 1.4, spread: 0.9, gravity: 1.2, drag: 1.8, size: 0.07, sizeEnd: 0.04, color: [0.95, 0.97, 1], colorEnd: [0.85, 0.9, 0.98], glow: 0, stretch: 0 };
    case "trail":
      return { ...base, shape: "trail", count: 24, life: 0.25, lifeJitter: 0.2, speed: 0.3, speedJitter: 0.5, spread: 1, gravity: 0, drag: 4, size: 0.09, sizeEnd: 0.02, color: [0.7, 0.9, 1], colorEnd: [0.2, 0.5, 1], glow: 3, stretch: 0 };
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const num = (v: unknown, fallback: number, lo: number, hi: number) => (finite(v) ? clamp(v, lo, hi) : fallback);
const rgb = (v: unknown, fallback: Rgb): Rgb =>
  Array.isArray(v) && v.length === 3 && v.every(finite) ? [clamp(v[0] as number, 0, 1), clamp(v[1] as number, 0, 1), clamp(v[2] as number, 0, 1)] : fallback;

/** Read stored effects defensively: each field clamped, a missing one taken from the sparks preset, names made unique. */
export function parseParticleEffects(value: unknown): ParticleEffect[] {
  if (!Array.isArray(value)) return [];
  const out: ParticleEffect[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    if (out.length >= MAX_PARTICLE_EFFECTS) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    let name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 32) : `effect${out.length + 1}`;
    while (names.has(name)) name = `${name}_`;
    names.add(name);
    const d = particlePreset("sparks", name);
    out.push({
      name,
      shape: r.shape === "trail" ? "trail" : "burst",
      count: Math.round(num(r.count, d.count, 1, 128)),
      life: num(r.life, d.life, 0.02, 10),
      lifeJitter: num(r.lifeJitter, d.lifeJitter, 0, 1),
      speed: num(r.speed, d.speed, 0, 100),
      speedJitter: num(r.speedJitter, d.speedJitter, 0, 1),
      spread: num(r.spread, d.spread, 0, 1),
      gravity: num(r.gravity, d.gravity, -50, 50),
      drag: num(r.drag, d.drag, 0, 20),
      size: num(r.size, d.size, 0.005, 10),
      sizeEnd: num(r.sizeEnd, d.sizeEnd, 0, 10),
      color: rgb(r.color, d.color),
      colorEnd: rgb(r.colorEnd, d.colorEnd),
      glow: num(r.glow, d.glow, 0, 10),
      stretch: num(r.stretch, d.stretch, 0, 4),
    });
  }
  return out;
}
