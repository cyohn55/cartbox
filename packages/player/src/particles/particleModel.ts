/**
 * The particle sidecar data model + its defensive parser — cinematic gap #6
 * (weather and atmosphere: rain, snow, drifting embers, rolling fog). Kept DOM-free
 * so the save API validates with the same code the runtime and editor consume, the
 * way the scene and anim sidecars are.
 *
 * A cart declares a small set of emitters; the runtime {@link ./particleField.ts}
 * turns each into a deterministic, host-played particle field and the
 * {@link ./ParticleOverlaySurface.ts} composites them over the frame. Emitters
 * carry only the handful of knobs that read differently per weather — count,
 * colour, opacity, size, fall/rise speed, wind — while the per-kind *motion*
 * (streaking, sway, flicker) is baked into the field, so the sidecar stays small
 * and an author picks a preset and nudges a few sliders.
 */

/** The weather an emitter produces; also selects how the field draws and moves it. */
export type ParticleKind = "rain" | "snow" | "embers" | "fog";

/** Every kind, in a stable order (used by the editor's kind picker). */
export const PARTICLE_KINDS: readonly ParticleKind[] = ["rain", "snow", "embers", "fog"];

/** At most this many emitters per cart — a full weather system needs only a few. */
export const MAX_EMITTERS = 6;

/** Per-emitter particle-count ceiling, bounding worst-case per-frame draw cost. */
export const MAX_PARTICLES_PER_EMITTER = 600;

/** One weather layer. */
export interface ParticleEmitter {
  /** Weather kind — chooses draw style and motion. */
  kind: ParticleKind;
  /** How many particles this layer maintains, 1..{@link MAX_PARTICLES_PER_EMITTER}. */
  count: number;
  /** Particle colour, each channel 0..255. */
  color: readonly [number, number, number];
  /** Base opacity of each particle, 0..1. */
  opacity: number;
  /** Particle size in pixels, 1..8. */
  size: number;
  /** Speed along the kind's axis (fall or rise), in pixels/frame, 0..12. */
  speed: number;
  /** Horizontal drift in pixels/frame, signed, -6..6. */
  wind: number;
  /** Integer seed so the field is reproducible across reloads and replays. */
  seed: number;
}

/** A cart's declared weather: an ordered list of emitters. */
export interface ParticleSpec {
  emitters: ParticleEmitter[];
}

/** Per-kind defaults an author starts from; also the parser's fallbacks. */
const PRESETS: Record<ParticleKind, Omit<ParticleEmitter, "kind" | "seed">> = {
  rain: { count: 220, color: [180, 205, 235], opacity: 0.35, size: 1, speed: 9, wind: -1.2 },
  snow: { count: 140, color: [235, 240, 255], opacity: 0.75, size: 2, speed: 1.4, wind: 0.3 },
  embers: { count: 60, color: [255, 150, 60], opacity: 0.9, size: 1, speed: 0.7, wind: 0.4 },
  fog: { count: 18, color: [150, 160, 180], opacity: 0.12, size: 7, speed: 0.25, wind: 0.5 },
};

/** A ready-to-use emitter for a kind, at that kind's preset with the given seed. */
export function emitterPreset(kind: ParticleKind, seed: number): ParticleEmitter {
  return { kind, seed, ...PRESETS[kind] };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Read a finite number, clamped into range, or a fallback when absent/invalid. */
function readNumber(raw: unknown, min: number, max: number, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? clamp(raw, min, max) : fallback;
}

/** Validate an RGB triplet (each channel 0..255), or return the fallback. */
function readColor(
  raw: unknown,
  fallback: readonly [number, number, number],
): [number, number, number] {
  if (!Array.isArray(raw) || raw.length !== 3) return [...fallback];
  const channels = raw.map((c) => (typeof c === "number" && Number.isFinite(c) ? clamp(Math.round(c), 0, 255) : null));
  if (channels.some((c) => c === null)) return [...fallback];
  return channels as [number, number, number];
}

/** Parse one emitter, or null when its kind is missing/unknown. */
function parseEmitter(raw: unknown): ParticleEmitter | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !PARTICLE_KINDS.includes(kind as ParticleKind)) return null;
  const preset = PRESETS[kind as ParticleKind];
  return {
    kind: kind as ParticleKind,
    count: Math.round(readNumber(record.count, 1, MAX_PARTICLES_PER_EMITTER, preset.count)),
    color: readColor(record.color, preset.color),
    opacity: readNumber(record.opacity, 0, 1, preset.opacity),
    size: readNumber(record.size, 1, 8, preset.size),
    speed: readNumber(record.speed, 0, 12, preset.speed),
    wind: readNumber(record.wind, -6, 6, preset.wind),
    seed: Math.round(readNumber(record.seed, 0, 0xffffffff, 1)),
  };
}

/**
 * Validate untrusted JSON (a PUT body or a jsonb column) into a {@link ParticleSpec},
 * or null when nothing usable is present. Lenient about shape — malformed emitters
 * are dropped and missing fields take their kind's preset — but strict about kind
 * and ranges. Caps at {@link MAX_EMITTERS}. Returns null for an emitter-less result,
 * the same null-on-empty contract the scene and anim routes rely on so an empty
 * declaration clears the column rather than storing a no-op.
 */
export function parseParticles(raw: unknown): ParticleSpec | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rawEmitters = (raw as Record<string, unknown>).emitters;
  if (!Array.isArray(rawEmitters)) return null;

  const emitters: ParticleEmitter[] = [];
  for (const entry of rawEmitters) {
    if (emitters.length >= MAX_EMITTERS) break;
    const emitter = parseEmitter(entry);
    if (emitter) emitters.push(emitter);
  }
  return emitters.length > 0 ? { emitters } : null;
}
