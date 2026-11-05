/**
 * The audio track's pure parts (AAA_PRODUCTION_ROADMAP.md U1–U5), shared by the
 * player's sound system and the tests: the reverb a zone makes, how much of
 * each zone the listener is in, sidechain ducking, snapshot blending, the
 * occlusion filter, which variant a sound plays, and when a music change lands
 * on the beat.
 *
 * All deterministic: the same inputs give the same sound in every replay.
 */

export type Vec3 = readonly [number, number, number];

// --- U1: reverb zones --------------------------------------------------------------------------

/** A box of space with its own reverb. */
export interface ReverbZone {
  readonly name: string;
  readonly min: Vec3;
  readonly max: Vec3;
  /** Seconds for the reverb to fall 60 dB (RT60). */
  readonly decay: number;
  /** 0..1: how much the walls soak up the highs (soft furnishings high, stone low). */
  readonly damping: number;
  /** How loud the reverb is against the dry sound, 0..1. */
  readonly wet: number;
  /** Metres over which it fades in at the box's edges. */
  readonly fade: number;
}

/**
 * A zone's decay from its size and what it's made of, by Sabine's formula
 * (RT60 = 0.161 V / (S α)): a big hard hall rings for seconds, a small soft
 * room for a fraction of one.
 */
export function sabineDecay(size: Vec3, absorption: number): number {
  const [x, y, z] = size.map((v) => Math.max(0.1, Math.abs(v))) as unknown as [number, number, number];
  const volume = x * y * z;
  const surface = 2 * (x * y + y * z + x * z);
  return Math.max(0.05, Math.min(12, (0.161 * volume) / (surface * Math.max(0.01, Math.min(1, absorption)))));
}

/**
 * A stereo impulse response for a decay and damping: exponentially decaying
 * noise (−60 dB at `decay`), its highs damped faster by a one-pole low-pass
 * whose cutoff falls over the tail, each channel its own noise for width.
 * Seeded, so every machine makes the same reverb.
 */
export function reverbImpulse(sampleRate: number, decay: number, damping: number, seed = 1): [Float32Array, Float32Array] {
  const length = Math.max(1, Math.round(sampleRate * Math.min(12, Math.max(0.05, decay))));
  const out: [Float32Array, Float32Array] = [new Float32Array(length), new Float32Array(length)];
  for (let ch = 0; ch < 2; ch += 1) {
    let s = (seed * 2654435761 + ch * 40503) >>> 0 || 1;
    let lp = 0;
    const data = out[ch]!;
    for (let i = 0; i < length; i += 1) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      const noise = (s / 4294967296) * 2 - 1;
      const t = i / sampleRate;
      const envelope = Math.pow(10, (-3 * t) / decay); // −60 dB at decay
      // The low-pass closes as the tail ages, faster with more damping.
      const k = Math.max(0.02, 1 - damping * Math.min(1, t / decay) * 0.95);
      lp += k * (noise - lp);
      data[i] = lp * envelope;
    }
  }
  return out;
}

/** How far inside a zone a point is, 0 (outside) to 1 (deeper than its fade). */
export function zoneWeight(zone: ReverbZone, at: Vec3): number {
  let inside = Infinity;
  for (let k = 0; k < 3; k += 1) {
    const lo = Math.min(zone.min[k]!, zone.max[k]!);
    const hi = Math.max(zone.min[k]!, zone.max[k]!);
    const d = Math.min(at[k]! - lo, hi - at[k]!);
    if (d < 0) return 0;
    inside = Math.min(inside, d);
  }
  return zone.fade > 0 ? Math.min(1, inside / zone.fade) : 1;
}

/** Each zone's send level for a listener at `at`: weights normalised so overlapping zones crossfade, times each one's wet. */
export function reverbSends(zones: readonly ReverbZone[], at: Vec3): number[] {
  const w = zones.map((z) => zoneWeight(z, at));
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x, i) => (total > 1 ? x / total : x) * zones[i]!.wet);
}

// --- U2: occlusion ------------------------------------------------------------------------------

/** How occluded (0 clear .. 1 behind solid walls) becomes a filter: the low-pass cutoff (Hz) and a gain. */
export function occlusionFilter(occlusion: number, strength = 1): { cutoff: number; gain: number } {
  const o = Math.max(0, Math.min(1, occlusion)) * Math.max(0, Math.min(1, strength));
  // From open (20 kHz) to muffled (500 Hz), exponentially, and up to 12 dB quieter.
  return { cutoff: 20000 * Math.pow(500 / 20000, o), gain: Math.pow(10, (-12 * o) / 20) };
}

/** Move `current` toward `target` over a time constant (seconds): occlusion eases, it doesn't snap. */
export function smoothToward(current: number, target: number, dt: number, seconds: number): number {
  if (seconds <= 0) return target;
  return target + (current - target) * Math.exp(-dt / seconds);
}

// --- U3: the mixer -----------------------------------------------------------------------------

/** A bus ducked by another while it plays: its gain multiplied by `amount` (0..1), eased in over `attack`, out over `release`. */
export interface Duck {
  readonly by: string;
  readonly amount: number;
  readonly attack: number;
  readonly release: number;
}

/** A duck's gain this frame, from last frame's and whether the ducking bus is playing. */
export function duckGain(current: number, duck: Duck, active: boolean, dt: number): number {
  const target = active ? duck.amount : 1;
  return smoothToward(current, target, dt, active ? duck.attack : duck.release);
}

/** A mixer snapshot: bus volumes by name. */
export interface MixSnapshot {
  readonly name: string;
  readonly buses: Readonly<Record<string, number>>;
}

/** Bus volumes partway (0..1) from one set to a snapshot; buses it doesn't name keep theirs. */
export function blendSnapshot(from: Readonly<Record<string, number>>, to: MixSnapshot, t: number): Record<string, number> {
  const k = Math.max(0, Math.min(1, t));
  const out: Record<string, number> = { ...from };
  for (const [bus, v] of Object.entries(to.buses)) out[bus] = (from[bus] ?? v) + (v - (from[bus] ?? v)) * k;
  return out;
}

// --- U4: music on the beat ----------------------------------------------------------------------

/** When a change asked for at `now` lands: the next beat (or bar) of music that started at `start`. */
export function nextBeat(now: number, start: number, bpm: number, beatsPerUnit = 1): number {
  const unit = (60 / Math.max(1, bpm)) * Math.max(1, beatsPerUnit);
  if (now <= start) return start;
  const n = Math.ceil((now - start) / unit - 1e-9);
  return start + n * unit;
}

/** A track of layers that play in sync (each a looping sound), switched in and out on the beat, with stingers on top. */
export interface MusicTrack {
  readonly name: string;
  readonly bpm: number;
  /** Beats a bar: layers switch on bars, stingers on beats. */
  readonly beats: number;
  readonly layers: readonly string[];
}

// --- U5: variation ------------------------------------------------------------------------------

export type VariationChoice = "random" | "sequence" | "switch";

/** A sound's variation: which sounds it may play instead, how it picks, and how much it varies pitch and volume. */
export interface SoundVariation {
  readonly variants: readonly string[];
  readonly choose: VariationChoice;
  /** For `switch`: the switch's name, and which variant each of its values plays. */
  readonly switchName?: string;
  readonly cases?: Readonly<Record<string, string>>;
  /** ± fraction of pitch and volume, chosen per play. */
  readonly pitch: number;
  readonly volume: number;
}

/** A small seeded generator (mulberry32): deterministic variation. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which sound a play of `name` with `variation` makes, and its pitch and
 * volume multipliers. `random` never repeats the last pick when it has a
 * choice; `sequence` goes round in order; `switch` plays the case for the
 * switch's current value (the sound itself when there's none).
 */
export function chooseVariant(
  name: string,
  variation: SoundVariation,
  state: { last: Map<string, number>; switches: ReadonlyMap<string, string> },
  random: () => number,
): { sound: string; pitch: number; volume: number } {
  const pool = [name, ...variation.variants];
  let sound: string;
  if (variation.choose === "switch") {
    const value = variation.switchName ? state.switches.get(variation.switchName) : undefined;
    sound = (value !== undefined && variation.cases?.[value]) || name;
  } else if (variation.choose === "sequence") {
    const k = ((state.last.get(name) ?? -1) + 1) % pool.length;
    state.last.set(name, k);
    sound = pool[k]!;
  } else {
    const last = state.last.get(name) ?? -1;
    let k = Math.floor(random() * pool.length) % pool.length;
    if (pool.length > 1 && k === last) k = (k + 1 + Math.floor(random() * (pool.length - 1))) % pool.length;
    state.last.set(name, k);
    sound = pool[k]!;
  }
  const jitter = (amount: number) => 1 + (random() * 2 - 1) * Math.max(0, Math.min(0.9, amount));
  return { sound, pitch: jitter(variation.pitch), volume: jitter(variation.volume) };
}
