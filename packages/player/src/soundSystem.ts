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

import {
  base64ToBytes,
  blendSnapshot,
  chooseVariant,
  duckGain,
  nextBeat,
  occlusionFilter,
  resolveSynth,
  reverbImpulse,
  reverbSends,
  seededRandom,
  smoothToward,
  synthesizeSound,
  type MixSnapshot,
  type SceneAudio,
  type SceneSound,
} from "@cartbox/editor";

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
  /** The audio track's nodes (U1–U4); a context without one leaves that feature out. */
  createBiquadFilter?(): BiquadFilterNode;
  createConvolver?(): ConvolverNode;
  createDynamicsCompressor?(): DynamicsCompressorNode;
  createMediaElementSource?(element: HTMLMediaElement): MediaElementAudioSourceNode;
}

/** How blocked the line from the listener to a sound is: 0 clear, 1 behind a wall (U2). */
export type Occluder = (from: Vec3, to: Vec3) => number;

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
  /** The bus it plays into (for ducking). */
  readonly bus?: number;
  /** Occlusion (U2): its filter and gain, where it is, and how occluded it is now. */
  readonly filter?: BiquadFilterNode | null;
  readonly occGain?: GainNode | null;
  at?: Vec3 | null;
  occ?: number;
}

/** A music track playing (U4): when it started, its layers' voices and gains, and changes waiting for the bar. */
interface Playing {
  readonly start: number;
  readonly layers: (Voice | null)[];
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
  /** Each bus's own level (what cartbox.mix and snapshots set) and its duck now (U3). */
  private readonly levels: number[];
  private readonly ducks: number[];
  private snapshotBlend: { from: Record<string, number>; to: MixSnapshot; t: number; seconds: number } | null = null;
  /** Reverb (U1): each zone's send. */
  private readonly zoneSends: GainNode[] = [];
  private listener: Vec3 = [0, 0, 0];
  private occluder: Occluder | null = null;
  /** Variation (U5): seeded, so a replay varies the same. */
  private readonly random = seededRandom(1);
  private readonly variation = { last: new Map<string, number>(), switches: new Map<string, string>() };
  private readonly music = new Map<number, Playing>();
  private readonly pending: { when: number; apply: () => void }[] = [];

  private constructor(
    private readonly context: SoundContext,
    readonly audio: SceneAudio,
    output: AudioNode,
    private readonly speak: Speaker,
  ) {
    this.master = context.createGain();
    // A limiter on the master (U3), so a pile of loud sounds can't clip.
    const limiter = context.createDynamicsCompressor?.();
    if (limiter) {
      limiter.threshold.value = audio.limiter ?? -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.1;
      this.master.connect(limiter);
      limiter.connect(output);
    } else this.master.connect(output);
    this.buses = audio.buses.map((bus) => {
      const g = context.createGain();
      g.gain.value = bus.volume;
      return g;
    });
    // Each bus into its parent (U3), or the master.
    audio.buses.forEach((bus, i) => {
      const parent = bus.parent ? audio.buses.findIndex((b) => b.name === bus.parent) : -1;
      this.buses[i]!.connect(parent >= 0 ? this.buses[parent]! : this.master);
    });
    this.levels = audio.buses.map((b) => b.volume);
    this.ducks = audio.buses.map(() => 1);
    // Reverb zones (U1): every bus sends to a convolver per zone, at the level the listener's place gives.
    const zones = audio.reverbZones ?? [];
    if (zones.length > 0 && context.createConvolver) {
      const send = context.createGain();
      audio.buses.forEach((bus, i) => {
        const amount = context.createGain();
        amount.gain.value = bus.reverb ?? 1;
        this.buses[i]!.connect(amount);
        amount.connect(send);
      });
      zones.forEach((zone, z) => {
        const level = context.createGain();
        level.gain.value = 0;
        const convolver = context.createConvolver!();
        const [left, right] = reverbImpulse(context.sampleRate, zone.decay, zone.damping, z + 1);
        const ir = context.createBuffer(2, left.length, context.sampleRate);
        ir.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
        ir.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
        convolver.buffer = ir;
        send.connect(level);
        level.connect(convolver);
        convolver.connect(this.master);
        this.zoneSends.push(level);
      });
    }
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
        // A streamed sound (U4) is decoded only where it can't stream.
        if (sound.stream && context.createMediaElementSource && (globalThis as { Audio?: unknown }).Audio) return;
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
  private start(sound: number, volume: number, pitch: number, at: Vec3 | null, loop: boolean, positional = at !== null, when = 0): Voice | null {
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
    let filter: BiquadFilterNode | null = null;
    let occGain: GainNode | null = null;
    // A sound with a range pans and fades with distance; one without plays everywhere alike.
    if (positional && def.range) {
      panner = this.context.createPanner();
      panner.panningModel = "equalpower";
      panner.distanceModel = "linear";
      panner.refDistance = def.range[0];
      panner.maxDistance = def.range[1];
      panner.rolloffFactor = 1;
      if (at) place(panner, at);
      // Occlusion (U2): a low-pass and a gain the walls between set, before the panner.
      if (this.audio.occlusion && this.context.createBiquadFilter) {
        filter = this.context.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 20000;
        occGain = this.context.createGain();
        gain.connect(filter);
        filter.connect(occGain);
        occGain.connect(panner);
      } else gain.connect(panner);
    }
    const bus = Math.max(0, this.audio.buses.findIndex((b) => b.name === def.bus));
    (panner ?? gain).connect(this.buses[bus] ?? this.master);
    source.start(Math.max(this.context.currentTime, when));
    return { source, gain, panner, bus, filter, occGain, at, occ: 0 };
  }

  /** Play a sound once (cartbox.sound). */
  play(sound: number, volume = 1, pitch = 1, at: Vec3 | null = null, when = 0): void {
    // Variation (U5): another sound in its place, its pitch and volume spread.
    const variation = this.audio.sounds[sound]?.variation;
    if (variation) {
      const pick = chooseVariant(this.audio.sounds[sound]!.name, variation, this.variation, this.random);
      const k = this.audio.sounds.findIndex((s) => s.name === pick.sound);
      if (k >= 0) sound = k;
      pitch *= pick.pitch;
      volume *= pick.volume;
    }
    const voice = this.start(sound, volume, pitch, at, false, at !== null, when);
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
      if (held.panner && at) {
        place(held.panner, at);
        held.at = at;
      }
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
    if (bus < 0 || bus >= this.buses.length) return;
    this.levels[bus] = Math.max(0, Math.min(2, volume));
    this.buses[bus]!.gain.value = this.levels[bus]! * this.ducks[bus]!;
  }

  /** Blend the buses to a snapshot over `seconds` (U3; cartbox.snapshot). */
  snapshot(index: number, seconds: number): void {
    const to = this.audio.snapshots?.[index];
    if (!to) return;
    const from = Object.fromEntries(this.audio.buses.map((b, i) => [b.name, this.levels[i]!]));
    this.snapshotBlend = { from, to, t: 0, seconds: Math.max(0, seconds) };
    if (seconds <= 0) this.advanceSnapshot(0);
  }

  private advanceSnapshot(dt: number): void {
    const s = this.snapshotBlend;
    if (!s) return;
    s.t = s.seconds > 0 ? Math.min(1, s.t + dt / s.seconds) : 1;
    const levels = blendSnapshot(s.from, s.to, s.t);
    this.audio.buses.forEach((b, i) => this.mix(i, levels[b.name] ?? this.levels[i]!));
    if (s.t >= 1) this.snapshotBlend = null;
  }

  /** Set a switch's value (U5; cartbox.switch): what a switch container plays. */
  setSwitch(name: string, value: string): void {
    this.variation.switches.set(name, value);
  }

  /** Where walls are, for occlusion (U2): the host's line test. */
  setOccluder(occluder: Occluder | null): void {
    this.occluder = occluder;
  }

  /** Start or stop a music track (U4; cartbox.music): its layers in sync, the first one up. */
  playMusic(track: number, on: boolean): void {
    const def = this.audio.music?.[track];
    if (!def) return;
    const playing = this.music.get(track);
    if (!on) {
      if (playing) for (const v of playing.layers) if (v) stop(v);
      this.music.delete(track);
      return;
    }
    if (playing) return;
    const start = this.context.currentTime;
    const layers = def.layers.map((name, i) => {
      const sound = this.audio.sounds.findIndex((s) => s.name === name);
      if (sound < 0) return null;
      return this.streamed(sound, i === 0 ? 1 : 0) ?? this.start(sound, i === 0 ? 1 : 0, 1, null, true, false, start);
    });
    this.music.set(track, { start, layers });
  }

  /**
   * A long file played as it streams (U4), through a media element rather than
   * decoded whole first: null where the context or the page can't (the sound
   * is then decoded as usual).
   */
  private streamed(sound: number, volume: number): Voice | null {
    const def = this.audio.sounds[sound];
    const Audio = (globalThis as { Audio?: new (src?: string) => HTMLAudioElement }).Audio;
    if (!def?.stream || def.source.kind !== "file" || !this.context.createMediaElementSource || !Audio || typeof URL === "undefined" || !URL.createObjectURL) return null;
    const bytes = base64ToBytes(def.source.data);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: def.source.mime }));
    const element = new Audio(url);
    element.loop = true;
    const node = this.context.createMediaElementSource(element);
    const gain = this.context.createGain();
    gain.gain.value = def.volume * volume;
    node.connect(gain);
    const bus = Math.max(0, this.audio.buses.findIndex((b) => b.name === def.bus));
    gain.connect(this.buses[bus] ?? this.master);
    void element.play().catch(() => {});
    const source = { stop: () => { element.pause(); URL.revokeObjectURL(url); }, disconnect: () => node.disconnect() } as unknown as AudioBufferSourceNode;
    return { source, gain, panner: null, bus };
  }

  /** Bring a layer in or out, on the next bar (U4; cartbox.layer). */
  musicLayer(track: number, layer: number, on: boolean): void {
    const def = this.audio.music?.[track];
    const playing = this.music.get(track);
    const voice = playing?.layers[layer];
    if (!def || !playing || !voice) return;
    const when = nextBeat(this.context.currentTime, playing.start, def.bpm, def.beats);
    const level = (this.audio.sounds.find((s) => s.name === def.layers[layer])?.volume ?? 1) * (on ? 1 : 0);
    this.pending.push({ when, apply: () => (voice.gain.gain.value = level) });
  }

  /** A stinger over the music, on its next beat (U4; cartbox.stinger); at once with no music playing. */
  stinger(sound: number): void {
    let when = this.context.currentTime;
    for (const [track, playing] of this.music) {
      const def = this.audio.music![track]!;
      when = nextBeat(this.context.currentTime, playing.start, def.bpm, 1);
      break;
    }
    this.play(sound, 1, 1, null, when);
  }

  /**
   * The audio track's frame (U1–U4): the listener's reverb zones, ducking,
   * snapshot blends, occlusion eased toward the line tests, and music changes
   * that have reached their bar.
   */
  update(dt: number): void {
    if (this.disposed) return;
    const sends = reverbSends(this.audio.reverbZones ?? [], this.listener);
    this.zoneSends.forEach((g, i) => (g.gain.value = sends[i] ?? 0));
    this.advanceSnapshot(dt);
    // A bus is "playing" while a voice into it (or a bus under it) is.
    const active = new Set<number>();
    for (const v of [...this.voices, ...this.loops.values(), ...this.emitters]) if (v.bus !== undefined) active.add(v.bus);
    this.audio.buses.forEach((bus, i) => {
      if (!bus.duck) return;
      const by = this.audio.buses.findIndex((b) => b.name === bus.duck!.by);
      this.ducks[i] = duckGain(this.ducks[i]!, bus.duck, active.has(by), dt);
      this.buses[i]!.gain.value = this.levels[i]! * this.ducks[i]!;
    });
    if (this.occluder && this.audio.occlusion) {
      const { strength, smoothing } = this.audio.occlusion;
      for (const v of [...this.voices, ...this.loops.values(), ...this.emitters]) {
        if (!v.filter || !v.occGain || !v.at) continue;
        v.occ = smoothToward(v.occ ?? 0, this.occluder(this.listener, v.at), dt, smoothing);
        const f = occlusionFilter(v.occ, strength);
        v.filter.frequency.value = f.cutoff;
        v.occGain.gain.value = f.gain;
      }
    }
    const now = this.context.currentTime;
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i]!.when <= now + 1e-6) {
        this.pending[i]!.apply();
        this.pending.splice(i, 1);
      }
    }
  }

  /** A bus's duck now (1 = none), for tests and the mixer view. */
  duckLevel(bus: number): number {
    return this.ducks[bus] ?? 1;
  }

  /** A bus's index by name (-1 when the scene has none of that name). */
  busIndex(name: string): number {
    return this.audio.buses.findIndex((b) => b.name === name);
  }

  /** The level a bus is at. */
  busVolume(bus: number): number {
    return this.buses[bus]?.gain.value ?? 0;
  }

  /** Put the listener where the camera is, facing where it looks. */
  listen(eye: Vec3, forward: Vec3, up: Vec3): void {
    this.listener = eye;
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
      if (m) {
        e.at = [m[12]!, m[13]!, m[14]!];
        place(e.panner, e.at);
      }
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
    for (const p of this.music.values()) for (const v of p.layers) if (v) stop(v);
    this.music.clear();
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
  v.filter?.disconnect();
  v.occGain?.disconnect();
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
