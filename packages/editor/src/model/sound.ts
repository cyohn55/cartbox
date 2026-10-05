/**
 * Audio (ENGINE_PARITY_ROADMAP.md EP12, HALO2_STYLE_ROADMAP.md H14): the
 * scene's sounds, its mixer, and the ambience placed in it.
 *
 * A sound comes from one of three places:
 * - an imported file (Ogg, MP3, WAV), stored as its bytes;
 * - a **synth** recipe — a few voices (noise or a waveform) with a pitch
 *   sweep, a filter sweep and an envelope, rendered to samples when the scene
 *   loads (a built-in one by name costs a few bytes: a whole game's gunfire,
 *   wind and explosions in under a kilobyte);
 * - **speech**, a line the browser's voice reads out (an announcer).
 *
 * Every sound plays through a **bus** (sfx, music, voice, ambience — or any
 * the scene adds), whose volume the mixer sets and the cart can change, and
 * all buses through the master. A sound with a range is positional: it pans
 * and fades with distance from the camera. **Emitters** play a looping sound
 * from the start — on an object (following it) or everywhere at once.
 *
 * Pure and DOM-free: the synthesiser renders to a Float32Array, so a sound is
 * checked sample by sample without a browser.
 */

/** One voice of a synth: a source (noise or a waveform), how its pitch and filter sweep, and its envelope. */
export interface SynthVoice {
  readonly wave: "noise" | "sine" | "square" | "saw" | "triangle";
  /** Pitch at the start and end (Hz), swept exponentially. Ignored for noise. */
  readonly freq?: readonly [number, number];
  /** Low-pass cutoff at the start and end (Hz), swept exponentially. Absent = unfiltered. */
  readonly cutoff?: readonly [number, number];
  /** Seconds to full level. */
  readonly attack: number;
  /** Seconds from full level to silence (−40 dB); absent = holds to the end. */
  readonly decay?: number;
  /** Seconds before this voice starts. */
  readonly delay?: number;
  readonly volume: number;
}

/** A synth recipe: its voices, length, and (for a loop) a slow wobble of the filter. */
export interface SynthSound {
  readonly duration: number;
  readonly voices: readonly SynthVoice[];
  /** Made to loop seamlessly (the end crossfades into the start). */
  readonly loop?: boolean;
  /** A slow wander of every voice's cutoff: its rate (Hz) and depth (0..1 of an octave either way, ×2). */
  readonly wobble?: { readonly rate: number; readonly depth: number };
  readonly seed?: number;
}

export type SoundSource =
  | { readonly kind: "file"; readonly mime: string; readonly data: string }
  | { readonly kind: "synth"; readonly synth: SynthSound | SynthPreset }
  | { readonly kind: "speech"; readonly text: string; readonly pitch?: number; readonly rate?: number };

export interface SceneSound {
  readonly name: string;
  readonly source: SoundSource;
  /** The bus it plays through (by name). */
  readonly bus: string;
  readonly volume: number;
  /** Positional: full volume within range[0], fading to silence by range[1] (world units). Absent = everywhere alike. */
  readonly range?: readonly [number, number];
  /** Loops until stopped. */
  readonly loop?: boolean;
}

export interface SoundBus {
  readonly name: string;
  readonly volume: number;
}

/** A sound playing from the start, looping: on an object (by id, following it) or everywhere. */
export interface SoundEmitter {
  readonly sound: string;
  readonly object?: string;
  readonly volume: number;
}

export interface SceneAudio {
  readonly sounds: readonly SceneSound[];
  readonly buses: readonly SoundBus[];
  readonly emitters: readonly SoundEmitter[];
}

export const DEFAULT_BUSES: readonly SoundBus[] = [
  { name: "sfx", volume: 1 },
  { name: "music", volume: 0.7 },
  { name: "voice", volume: 1 },
  { name: "ambience", volume: 0.6 },
];

export const MAX_SOUNDS = 64;
export const MAX_SOUND_BUSES = 8;
export const MAX_EMITTERS = 32;
/** An imported file's most bytes (base64 counts a third more). */
export const MAX_SOUND_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SYNTH_SECONDS = 12;

// --- Synth presets ------------------------------------------------------------

export type SynthPreset = "rifle" | "smg" | "shotgun" | "sniper" | "pistol" | "swing" | "explosion" | "wind" | "laser" | "pickup" | "click" | "jump";

export const SYNTH_PRESETS: Readonly<Record<SynthPreset, SynthSound>> = {
  // A crack of filtered noise over a low thump.
  rifle: {
    duration: 0.45,
    voices: [
      { wave: "noise", cutoff: [9000, 900], attack: 0.001, decay: 0.22, volume: 0.9 },
      { wave: "sine", freq: [160, 45], attack: 0.002, decay: 0.18, volume: 0.8 },
    ],
  },
  smg: {
    duration: 0.25,
    voices: [
      { wave: "noise", cutoff: [7000, 1200], attack: 0.001, decay: 0.12, volume: 0.8 },
      { wave: "square", freq: [220, 70], cutoff: [2000, 400], attack: 0.001, decay: 0.08, volume: 0.35 },
    ],
  },
  shotgun: {
    duration: 0.9,
    voices: [
      { wave: "noise", cutoff: [6000, 300], attack: 0.002, decay: 0.55, volume: 1 },
      { wave: "sine", freq: [110, 35], attack: 0.003, decay: 0.4, volume: 0.9 },
    ],
  },
  sniper: {
    duration: 1.4,
    voices: [
      { wave: "noise", cutoff: [12000, 600], attack: 0.0005, decay: 0.35, volume: 1 },
      { wave: "sine", freq: [90, 30], attack: 0.002, decay: 0.6, volume: 0.9 },
      // The report rolling off the gorge walls.
      { wave: "noise", cutoff: [1500, 300], attack: 0.05, decay: 0.8, delay: 0.25, volume: 0.35 },
    ],
  },
  pistol: {
    duration: 0.5,
    voices: [
      { wave: "noise", cutoff: [8000, 1000], attack: 0.001, decay: 0.2, volume: 0.85 },
      { wave: "sine", freq: [200, 60], attack: 0.002, decay: 0.15, volume: 0.6 },
    ],
  },
  // A rising whoosh of air.
  swing: {
    duration: 0.35,
    voices: [{ wave: "noise", cutoff: [600, 4500], attack: 0.12, decay: 0.2, volume: 0.6 }],
  },
  explosion: {
    duration: 2.2,
    voices: [
      { wave: "noise", cutoff: [5000, 150], attack: 0.003, decay: 1.6, volume: 1 },
      { wave: "sine", freq: [70, 22], attack: 0.004, decay: 1.2, volume: 1 },
    ],
  },
  // Gusting wind: low-passed noise whose cutoff wanders, made to loop.
  wind: {
    duration: 6,
    loop: true,
    wobble: { rate: 0.23, depth: 0.9 },
    voices: [
      { wave: "noise", cutoff: [500, 500], attack: 0.01, volume: 0.7 },
      { wave: "noise", cutoff: [1800, 1800], attack: 0.01, volume: 0.15 },
    ],
  },
  laser: {
    duration: 0.3,
    voices: [{ wave: "square", freq: [1400, 180], cutoff: [6000, 1500], attack: 0.002, decay: 0.25, volume: 0.5 }],
  },
  pickup: {
    duration: 0.3,
    voices: [
      { wave: "triangle", freq: [660, 660], attack: 0.003, decay: 0.12, volume: 0.6 },
      { wave: "triangle", freq: [990, 990], attack: 0.003, decay: 0.16, delay: 0.08, volume: 0.6 },
    ],
  },
  click: {
    duration: 0.08,
    voices: [{ wave: "noise", cutoff: [5000, 2000], attack: 0.0005, decay: 0.03, volume: 0.6 }],
  },
  jump: {
    duration: 0.3,
    voices: [{ wave: "square", freq: [180, 520], cutoff: [3000, 3000], attack: 0.003, decay: 0.25, volume: 0.35 }],
  },
};

/** A synth source's recipe: a preset by name, or the recipe itself. Null for an unknown preset. */
export function resolveSynth(synth: SynthSound | string): SynthSound | null {
  if (typeof synth === "string") return (SYNTH_PRESETS as Record<string, SynthSound>)[synth] ?? null;
  return synth;
}

// --- Synthesis ----------------------------------------------------------------

/** A seeded random stream in −1..1 (mulberry32). */
function noise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Exponential sweep from a to b as f goes 0 → 1. */
const sweep = (range: readonly [number, number], f: number) => range[0] * Math.pow(Math.max(1e-6, range[1]) / Math.max(1e-6, range[0]), f);

/**
 * Render a synth recipe to mono samples at `sampleRate` (peaks within ±1). The
 * same recipe and seed always give the same samples.
 */
export function synthesizeSound(recipe: SynthSound, sampleRate: number): Float32Array {
  const duration = Math.max(0.01, Math.min(MAX_SYNTH_SECONDS, recipe.duration));
  const n = Math.max(1, Math.round(duration * sampleRate));
  const out = new Float32Array(n);
  recipe.voices.slice(0, 8).forEach((voice, k) => {
    const random = noise((recipe.seed ?? 1) * 7919 + k * 104729);
    const start = Math.max(0, Math.round((voice.delay ?? 0) * sampleRate));
    const attack = Math.max(1e-4, voice.attack);
    let phase = 0;
    // Two-pole low-pass (a biquad), coefficients refreshed every 32 samples.
    let b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const filter = (cutoff: number) => {
      const w = (2 * Math.PI * Math.min(cutoff, sampleRate * 0.45)) / sampleRate;
      const alpha = Math.sin(w) / (2 * 0.707);
      const cos = Math.cos(w);
      const a0 = 1 + alpha;
      b0 = (1 - cos) / 2 / a0;
      b1 = (1 - cos) / a0;
      b2 = b0;
      a1 = (-2 * cos) / a0;
      a2 = (1 - alpha) / a0;
    };
    for (let i = start; i < n; i += 1) {
      const t = (i - start) / sampleRate;
      const f = (i - start) / Math.max(1, n - start);
      let env = t < attack ? t / attack : 1;
      if (voice.decay !== undefined && t >= attack) env = Math.pow(0.01, (t - attack) / Math.max(1e-4, voice.decay));
      if (env < 1e-5 && t > attack) break;
      let s: number;
      if (voice.wave === "noise") s = random();
      else {
        const hz = voice.freq ? sweep(voice.freq, f) : 440;
        phase = (phase + hz / sampleRate) % 1;
        s = voice.wave === "sine" ? Math.sin(phase * Math.PI * 2) : voice.wave === "square" ? (phase < 0.5 ? 1 : -1) : voice.wave === "saw" ? phase * 2 - 1 : 1 - 4 * Math.abs(phase - 0.5);
      }
      if (voice.cutoff) {
        if ((i - start) % 32 === 0) {
          let cutoff = sweep(voice.cutoff, f);
          if (recipe.wobble) {
            // A slow wander: two incommensurate sines, so it never sounds regular.
            const wob = Math.sin(t * recipe.wobble.rate * Math.PI * 2) * 0.6 + Math.sin(t * recipe.wobble.rate * 2.71 * Math.PI * 2 + 1.3) * 0.4;
            cutoff *= Math.pow(2, wob * recipe.wobble.depth);
          }
          filter(cutoff);
        }
        const y = b0 * s + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = s; y2 = y1; y1 = y;
        s = y;
      }
      out[i] = out[i]! + s * env * voice.volume;
    }
  });
  // A loop's end crossfades into its start, so it repeats without a seam.
  if (recipe.loop) {
    const fade = Math.min(Math.round(sampleRate * 0.5), Math.floor(n / 3));
    for (let i = 0; i < fade; i += 1) {
      const w = i / fade;
      out[i] = out[i]! * w + out[n - fade + i]! * (1 - w);
    }
    return normalise(out.subarray(0, n - fade).slice());
  }
  return normalise(out);
}

/** Scale down to peak at 0.95 if louder (quieter stays as it is). */
function normalise(samples: Float32Array): Float32Array {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak > 0.95) for (let i = 0; i < samples.length; i += 1) samples[i] = (samples[i]! / peak) * 0.95;
  return samples;
}

// --- Reading and storage ------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const pair = (v: unknown): [number, number] | undefined => (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : undefined);
const WAVES = new Set(["noise", "sine", "square", "saw", "triangle"]);

function readVoice(value: unknown): SynthVoice | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.wave !== "string" || !WAVES.has(v.wave)) return null;
  const freq = pair(v.freq);
  const cutoff = pair(v.cutoff);
  return {
    wave: v.wave as SynthVoice["wave"],
    ...(freq ? { freq: [clamp(freq[0], 10, 20000), clamp(freq[1], 10, 20000)] as [number, number] } : {}),
    ...(cutoff ? { cutoff: [clamp(cutoff[0], 20, 20000), clamp(cutoff[1], 20, 20000)] as [number, number] } : {}),
    attack: finite(v.attack) ? clamp(v.attack, 0, MAX_SYNTH_SECONDS) : 0.005,
    ...(finite(v.decay) ? { decay: clamp(v.decay, 0.001, MAX_SYNTH_SECONDS) } : {}),
    ...(finite(v.delay) ? { delay: clamp(v.delay, 0, MAX_SYNTH_SECONDS) } : {}),
    volume: finite(v.volume) ? clamp(v.volume, 0, 2) : 0.5,
  };
}

function readSynth(value: unknown): SynthSound | SynthPreset | null {
  if (typeof value === "string") return value in SYNTH_PRESETS ? (value as SynthPreset) : null;
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  const voices = Array.isArray(s.voices) ? s.voices.map(readVoice).filter((v): v is SynthVoice => v !== null).slice(0, 8) : [];
  if (voices.length === 0) return null;
  const wobble = s.wobble && typeof s.wobble === "object" ? (s.wobble as Record<string, unknown>) : null;
  return {
    duration: finite(s.duration) ? clamp(s.duration, 0.01, MAX_SYNTH_SECONDS) : 1,
    voices,
    ...(s.loop === true ? { loop: true } : {}),
    ...(wobble && finite(wobble.rate) && finite(wobble.depth) ? { wobble: { rate: clamp(wobble.rate, 0, 20), depth: clamp(wobble.depth, 0, 4) } } : {}),
    ...(finite(s.seed) ? { seed: Math.floor(s.seed) } : {}),
  };
}

function readSource(value: unknown): SoundSource | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (s.kind === "file") {
    if (typeof s.mime !== "string" || !/^audio\//.test(s.mime) || typeof s.data !== "string" || s.data.length === 0) return null;
    if ((s.data.length * 3) / 4 > MAX_SOUND_FILE_BYTES) return null;
    return { kind: "file", mime: s.mime, data: s.data };
  }
  if (s.kind === "synth") {
    const synth = readSynth(s.synth);
    return synth ? { kind: "synth", synth } : null;
  }
  if (s.kind === "speech") {
    if (typeof s.text !== "string" || s.text.trim() === "") return null;
    return {
      kind: "speech",
      text: s.text.slice(0, 200),
      ...(finite(s.pitch) ? { pitch: clamp(s.pitch, 0, 2) } : {}),
      ...(finite(s.rate) ? { rate: clamp(s.rate, 0.1, 4) } : {}),
    };
  }
  return null;
}

/** Read a scene's audio defensively: malformed sounds, buses and emitters are dropped, names kept unique. */
export function parseSceneAudio(value: unknown): SceneAudio | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  const buses: SoundBus[] = [];
  const busNames = new Set<string>();
  for (const raw of Array.isArray(a.buses) ? a.buses : DEFAULT_BUSES) {
    const b = raw as Record<string, unknown> | null;
    if (!b || typeof b.name !== "string" || !b.name || busNames.has(b.name) || buses.length >= MAX_SOUND_BUSES) continue;
    busNames.add(b.name);
    buses.push({ name: b.name, volume: finite(b.volume) ? clamp(b.volume, 0, 2) : 1 });
  }
  const sounds: SceneSound[] = [];
  const names = new Set<string>();
  for (const raw of Array.isArray(a.sounds) ? a.sounds : []) {
    const s = raw as Record<string, unknown> | null;
    if (!s || typeof s.name !== "string" || !s.name || names.has(s.name) || sounds.length >= MAX_SOUNDS) continue;
    const source = readSource(s.source);
    if (!source) continue;
    const range = pair(s.range);
    names.add(s.name);
    sounds.push({
      name: s.name,
      source,
      bus: typeof s.bus === "string" && busNames.has(s.bus) ? s.bus : (buses[0]?.name ?? "sfx"),
      volume: finite(s.volume) ? clamp(s.volume, 0, 2) : 1,
      ...(range && range[1] > 0 ? { range: [Math.max(0.01, Math.min(range[0], range[1])), Math.max(range[0], range[1])] as [number, number] } : {}),
      ...(s.loop === true ? { loop: true } : {}),
    });
  }
  const emitters: SoundEmitter[] = [];
  for (const raw of Array.isArray(a.emitters) ? a.emitters : []) {
    const e = raw as Record<string, unknown> | null;
    if (!e || typeof e.sound !== "string" || !names.has(e.sound) || emitters.length >= MAX_EMITTERS) continue;
    emitters.push({ sound: e.sound, ...(typeof e.object === "string" && e.object ? { object: e.object } : {}), volume: finite(e.volume) ? clamp(e.volume, 0, 2) : 1 });
  }
  if (sounds.length === 0) return null;
  return { sounds, buses, emitters };
}

/** A sound's synth recipe, if it's a synth (preset resolved), else null. */
export function soundRecipe(sound: SceneSound): SynthSound | null {
  return sound.source.kind === "synth" ? resolveSynth(sound.source.synth) : null;
}
