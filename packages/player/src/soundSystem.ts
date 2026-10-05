/**
 * The scene's sound (ENGINE_PARITY_ROADMAP.md EP12): its sounds decoded or
 * synthesised into buffers, a gain per mixer bus into a master, one-shots and
 * looping slots the cart starts with cartbox.sound / cartbox.loop, positional
 * sounds panned and faded from the camera, and the emitters that loop from
 * the start (following their objects).
 *
 * It plays on the console's own AudioContext, into the same output the chip's
 * sound goes through, so the player's volume and pause cover both. Built on a
 * narrow slice of Web Audio ({@link SoundContext}) so it runs, and is tested,
 * with a stand-in context.
 */

import { base64ToBytes, synthesizeSound, resolveSynth, type SceneAudio, type SceneSound } from "@cartbox/editor";

/** The slice of an AudioContext the sound system uses. */
export interface SoundContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly listener: AudioListener;
  createGain(): GainNode;
  createBufferSource(): AudioBufferSourceNode;
  createPanner(): PannerNode;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

/** Reads a line aloud (the browser's speech), or null where there's none. */
export type Speaker = ((text: string, options: { volume: number; pitch: number; rate: number }) => void) | null;

/** The browser's speech synthesis, when it has one. */
export function browserSpeaker(): Speaker {
  const synth = typeof globalThis !== "undefined" ? (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis : undefined;
  const Utterance = typeof globalThis !== "undefined" ? (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance : undefined;
  if (!synth || !Utterance) return null;
  return (text, { volume, pitch, rate }) => {
    const u = new Utterance(text);
    u.volume = Math.max(0, Math.min(1, volume));
    u.pitch = pitch;
    u.rate = rate;
    synth.cancel(); // an announcer talks over himself, he doesn't queue
    synth.speak(u);
  };
}

/** One-shots playing at once at most; the oldest is cut for a new one. */
export const MAX_VOICES = 24;
/** Looping slots a cart can hold. */
export const LOOP_SLOTS = 16;

type Vec3 = readonly [number, number, number];

interface Voice {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly panner: PannerNode | null;
}

export class SoundSystem {
  private readonly master: GainNode;
  private readonly buses: GainNode[];
  private readonly buffers: (AudioBuffer | null)[];
  private readonly voices: Voice[] = [];
  private readonly loops = new Map<number, Voice & { sound: number }>();
  /** Emitters: their voice, and the object (scene instance index) each follows, or -1. */
  private readonly emitters: (Voice & { object: number })[] = [];
  private disposed = false;

  private constructor(
    private readonly context: SoundContext,
    readonly audio: SceneAudio,
    output: AudioNode,
    private readonly speak: Speaker,
  ) {
    this.master = context.createGain();
    this.master.connect(output);
    this.buses = audio.buses.map((bus) => {
      const g = context.createGain();
      g.gain.value = bus.volume;
      g.connect(this.master);
      return g;
    });
    this.buffers = audio.sounds.map(() => null);
  }

  /**
   * Build the scene's sound: every sound decoded or synthesised (a file that
   * won't decode is left silent), then the emitters started. `objectIndex`
   * finds an emitter's object (by id) among the scene's instances.
   */
  static async create(context: SoundContext, audio: SceneAudio, output: AudioNode, objectIndex: (id: string) => number, speak: Speaker = browserSpeaker()): Promise<SoundSystem> {
    const system = new SoundSystem(context, audio, output, speak);
    await Promise.all(
      audio.sounds.map(async (sound, i) => {
        system.buffers[i] = await bufferFor(context, sound);
      }),
    );
    for (const emitter of audio.emitters) {
      const sound = audio.sounds.findIndex((s) => s.name === emitter.sound);
      if (sound < 0) continue;
      const object = emitter.object ? objectIndex(emitter.object) : -1;
      const voice = system.start(sound, emitter.volume, 1, null, true, object >= 0);
      if (voice) system.emitters.push({ ...voice, object });
    }
    return system;
  }

  /** Start a sound (a buffer source through its gain, panner if positional, into its bus). */
  private start(sound: number, volume: number, pitch: number, at: Vec3 | null, loop: boolean, positional = at !== null): Voice | null {
    const def = this.audio.sounds[sound];
    const buffer = this.buffers[sound];
    if (!def || this.disposed) return null;
    if (def.source.kind === "speech") {
      const bus = this.audio.buses.findIndex((b) => b.name === def.bus);
      const level = def.volume * volume * (this.buses[bus]?.gain.value ?? 1) * this.master.gain.value;
      this.speak?.(def.source.text, { volume: level, pitch: def.source.pitch ?? 0.6, rate: def.source.rate ?? 0.9 });
      return null;
    }
    if (!buffer) return null;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop || Boolean(def.loop);
    source.playbackRate.value = Math.max(0.1, Math.min(4, pitch));
    const gain = this.context.createGain();
    gain.gain.value = def.volume * volume;
    source.connect(gain);
    let panner: PannerNode | null = null;
    // A sound with a range pans and fades with distance; one without plays everywhere alike.
    if (positional && def.range) {
      panner = this.context.createPanner();
      panner.panningModel = "equalpower";
      panner.distanceModel = "linear";
      panner.refDistance = def.range[0];
      panner.maxDistance = def.range[1];
      panner.rolloffFactor = 1;
      if (at) place(panner, at);
      gain.connect(panner);
    }
    const bus = Math.max(0, this.audio.buses.findIndex((b) => b.name === def.bus));
    (panner ?? gain).connect(this.buses[bus] ?? this.master);
    source.start(this.context.currentTime);
    return { source, gain, panner };
  }

  /** Play a sound once (cartbox.sound). */
  play(sound: number, volume = 1, pitch = 1, at: Vec3 | null = null): void {
    const voice = this.start(sound, volume, pitch, at, false);
    if (!voice) return;
    this.voices.push(voice);
    voice.source.onended = () => {
      const k = this.voices.indexOf(voice);
      if (k >= 0) this.voices.splice(k, 1);
      voice.gain.disconnect();
      voice.panner?.disconnect();
    };
    if (this.voices.length > MAX_VOICES) stop(this.voices.shift()!);
  }

  /** Start, move, fade or (sound < 0) stop a looping slot (cartbox.loop). */
  loop(slot: number, sound: number, volume = 1, at: Vec3 | null = null): void {
    if (slot < 0 || slot >= LOOP_SLOTS) return;
    const held = this.loops.get(slot);
    if (held && held.sound === sound && sound >= 0) {
      // The same sound: just move it and set its level.
      held.gain.gain.value = (this.audio.sounds[sound]?.volume ?? 1) * volume;
      if (held.panner && at) place(held.panner, at);
      return;
    }
    if (held) {
      stop(held);
      this.loops.delete(slot);
    }
    if (sound < 0) return;
    const voice = this.start(sound, volume, 1, at, true);
    if (voice) this.loops.set(slot, { ...voice, sound });
  }

  /** Set a mixer bus's volume (cartbox.mix). */
  mix(bus: number, volume: number): void {
    const g = this.buses[bus];
    if (g) g.gain.value = Math.max(0, Math.min(2, volume));
  }

  /** The level a bus is at. */
  busVolume(bus: number): number {
    return this.buses[bus]?.gain.value ?? 0;
  }

  /** Put the listener where the camera is, facing where it looks. */
  listen(eye: Vec3, forward: Vec3, up: Vec3): void {
    const l = this.context.listener;
    if (l.positionX) {
      l.positionX.value = eye[0];
      l.positionY.value = eye[1];
      l.positionZ.value = eye[2];
      l.forwardX.value = forward[0];
      l.forwardY.value = forward[1];
      l.forwardZ.value = forward[2];
      l.upX.value = up[0];
      l.upY.value = up[1];
      l.upZ.value = up[2];
    } else {
      // Older browsers: the deprecated setters.
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(eye[0], eye[1], eye[2]);
      (l as unknown as { setOrientation(...v: number[]): void }).setOrientation(forward[0], forward[1], forward[2], up[0], up[1], up[2]);
    }
  }

  /** Move each emitter that follows an object to where the object is (its world matrices, null = hidden). */
  follow(placements: readonly (ArrayLike<number> | null)[]): void {
    for (const e of this.emitters) {
      if (e.object < 0 || !e.panner) continue;
      const m = placements[e.object];
      if (m) place(e.panner, [m[12]!, m[13]!, m[14]!]);
    }
  }

  /** How many one-shots are playing (for tests and tooling). */
  playing(): number {
    return this.voices.length;
  }

  /** Which slots hold a loop, and which sound. */
  loopingSlots(): Map<number, number> {
    return new Map([...this.loops].map(([slot, v]) => [slot, v.sound]));
  }

  dispose(): void {
    this.disposed = true;
    for (const v of [...this.voices, ...this.loops.values(), ...this.emitters]) stop(v);
    this.voices.length = 0;
    this.loops.clear();
    this.emitters.length = 0;
    this.master.disconnect();
  }
}

function place(panner: PannerNode, at: Vec3): void {
  if (panner.positionX) {
    panner.positionX.value = at[0];
    panner.positionY.value = at[1];
    panner.positionZ.value = at[2];
  } else (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(at[0], at[1], at[2]);
}

function stop(v: Voice): void {
  try {
    v.source.stop();
  } catch {
    // Already stopped.
  }
  v.gain.disconnect();
  v.panner?.disconnect();
}

/** A sound's samples as a buffer: a synth rendered, a file decoded (null when it won't). Speech has none. */
async function bufferFor(context: SoundContext, sound: SceneSound): Promise<AudioBuffer | null> {
  if (sound.source.kind === "synth") {
    const recipe = resolveSynth(sound.source.synth);
    if (!recipe) return null;
    const samples = synthesizeSound(recipe, context.sampleRate);
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    return buffer;
  }
  if (sound.source.kind === "file") {
    try {
      const bytes = base64ToBytes(sound.source.data);
      return await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    } catch {
      return null;
    }
  }
  return null;
}
