/**
 * SoundBank — the editor-facing view of the cart's SFX samples.
 *
 * A sample is four per-tick envelopes, not one: the **volume** level, the
 * **waveform** it plays through, an **arpeggio** offset in semitones, and a
 * fine **pitch** offset. The four channels have always been in the cartridge —
 * `SFX_CHANNEL` has named them since the loops were added — but only volume and
 * a single cart-wide waveform were reachable, so carts authored here could not
 * express sounds a plain TIC-80 cart can.
 *
 * All four are editable now. What is still out of reach is the tail of the
 * packed sample — `speed`, `octave` and `reverse` — which sits past the region
 * the WASM shim exposes; reaching it needs a shim function and an engine
 * rebuild, not a change here.
 *
 * Pure, like the other models, so the UI and the tests drive it identically.
 */

import {
  CartEngine,
  SFX_COUNT,
  SFX_LOOP_CHANNELS,
  SFX_MAX_VALUE,
  SFX_TICKS,
  WAVEFORM_COUNT,
  WAVEFORM_MAX,
  WAVEFORM_STEPS,
} from "../engine/CartEngine";

/** SFX envelope loop channels, matching the sample's loops[] order. */
export const SFX_CHANNEL = { wave: 0, volume: 1, chord: 2, pitch: 3 } as const;

export interface SfxLoop {
  start: number;
  size: number;
}

/** The four per-tick envelopes, by name. */
export type SfxChannelName = keyof typeof SFX_CHANNEL;

/** How each envelope is displayed and bounded in the editor. */
export const SFX_CHANNEL_INFO: ReadonlyArray<{
  id: SfxChannelName;
  label: string;
  hint: string;
  min: number;
  max: number;
}> = [
  { id: "volume", label: "Volume", hint: "How loud the sound is at each tick.", min: 0, max: 15 },
  { id: "wave", label: "Wave", hint: "Which of the 16 waveforms plays at each tick.", min: 0, max: 15 },
  { id: "chord", label: "Arpeggio", hint: "Semitones above the played note — cycle these for a chord.", min: 0, max: 15 },
  { id: "pitch", label: "Pitch", hint: "Fine detune, in sixteenths of a semitone.", min: -8, max: 7 },
];

const ENVELOPE_READERS: Record<SfxChannelName, (bank: SoundBank, sample: number, tick: number) => number> = {
  volume: (bank, sample, tick) => bank.getVolume(sample, tick),
  wave: (bank, sample, tick) => bank.getWave(sample, tick),
  chord: (bank, sample, tick) => bank.getChord(sample, tick),
  pitch: (bank, sample, tick) => bank.getPitch(sample, tick),
};

const ENVELOPE_WRITERS: Record<SfxChannelName, (bank: SoundBank, sample: number, tick: number, value: number) => void> = {
  volume: (bank, sample, tick, value) => bank.setVolume(sample, tick, value),
  wave: (bank, sample, tick, value) => bank.setWave(sample, tick, value),
  chord: (bank, sample, tick, value) => bank.setChord(sample, tick, value),
  pitch: (bank, sample, tick, value) => bank.setPitch(sample, tick, value),
};

export class SoundBank {
  readonly sampleCount = SFX_COUNT;
  readonly ticks = SFX_TICKS;
  readonly maxValue = SFX_MAX_VALUE;
  readonly waveformCount = WAVEFORM_COUNT;
  readonly waveformSteps = WAVEFORM_STEPS;
  readonly waveformMax = WAVEFORM_MAX;
  readonly loopChannels = SFX_LOOP_CHANNELS;

  constructor(private readonly engine: CartEngine) {}

  /** The loop (start + size, 0..15) of one of a sample's envelope channels. */
  getLoop(sample: number, channel: number): SfxLoop {
    return {
      start: this.engine.getSfxLoopStart(sample, channel),
      size: this.engine.getSfxLoopSize(sample, channel),
    };
  }

  setLoopStart(sample: number, channel: number, value: number): void {
    this.engine.setSfxLoopStart(sample, channel, value);
  }

  setLoopSize(sample: number, channel: number, value: number): void {
    this.engine.setSfxLoopSize(sample, channel, value);
  }

  getWaveform(waveform: number, step: number): number {
    return this.engine.getWaveformSample(waveform, step);
  }

  setWaveform(waveform: number, step: number, value: number): void {
    this.engine.setWaveformSample(waveform, step, value);
  }

  /** A waveform's amplitude curve as an array, step order. */
  waveformCurve(waveform: number): number[] {
    return Array.from({ length: WAVEFORM_STEPS }, (_unused, step) => this.engine.getWaveformSample(waveform, step));
  }

  getVolume(sample: number, tick: number): number {
    return this.engine.getSfxVolume(sample, tick);
  }

  setVolume(sample: number, tick: number, value: number): void {
    this.engine.setSfxVolume(sample, tick, value);
  }

  getWave(sample: number, tick: number): number {
    return this.engine.getSfxWave(sample, tick);
  }

  /** Set the waveform at one tick, so a sound can change timbre mid-envelope. */
  setWave(sample: number, tick: number, wave: number): void {
    this.engine.setSfxWave(sample, tick, wave);
  }

  /** Set one sample's waveform across every tick (a single base waveform). */
  setWaveAll(sample: number, wave: number): void {
    for (let tick = 0; tick < SFX_TICKS; tick += 1) {
      this.engine.setSfxWave(sample, tick, wave);
    }
  }

  /** Arpeggio offset (0..15 semitones above the played note) at one tick. */
  getChord(sample: number, tick: number): number {
    return this.engine.getSfxChord(sample, tick);
  }

  setChord(sample: number, tick: number, value: number): void {
    this.engine.setSfxChord(sample, tick, value);
  }

  /** Fine pitch offset (-8..7 sixteenths of a semitone) at one tick. */
  getPitch(sample: number, tick: number): number {
    return this.engine.getSfxPitch(sample, tick);
  }

  setPitch(sample: number, tick: number, value: number): void {
    this.engine.setSfxPitch(sample, tick, value);
  }

  /** The sample's volume envelope as an array of levels, tick order. */
  volumeEnvelope(sample: number): number[] {
    return this.envelope(sample, "volume");
  }

  /** Any one of the sample's four envelopes as an array, tick order. */
  envelope(sample: number, channel: SfxChannelName): number[] {
    return Array.from({ length: SFX_TICKS }, (_unused, tick) => this.envelopeValue(sample, channel, tick));
  }

  /** One tick of any envelope, so a canvas needs one reader, not four. */
  envelopeValue(sample: number, channel: SfxChannelName, tick: number): number {
    return ENVELOPE_READERS[channel](this, sample, tick);
  }

  /** Set one tick of any envelope, so the editor needs one handler, not four. */
  setEnvelope(sample: number, channel: SfxChannelName, tick: number, value: number): void {
    ENVELOPE_WRITERS[channel](this, sample, tick, value);
  }

  /**
   * Everything the preview synthesiser needs to voice this sample: the four
   * envelopes plus the cart's own wavetables. Assembled here so the audio code
   * never reaches into the engine itself.
   */
  renderSpec(sample: number): {
    volume: number[];
    wave: number[];
    chord: number[];
    pitch: number[];
    waveforms: number[][];
  } {
    return {
      volume: this.envelope(sample, "volume"),
      wave: this.envelope(sample, "wave"),
      chord: this.envelope(sample, "chord"),
      pitch: this.envelope(sample, "pitch"),
      waveforms: Array.from({ length: WAVEFORM_COUNT }, (_unused, index) => this.waveformCurve(index)),
    };
  }

  /** True when every tick of the sample is silent (volume 0). */
  isSilent(sample: number): boolean {
    return this.volumeEnvelope(sample).every((level) => level === 0);
  }
}
