/**
 * SoundBank — the editor-facing view of the cart's SFX samples. Each sample is
 * a volume envelope (one 0..15 level per tick) plus a per-tick waveform. Pure,
 * like the other models, so the UI and the tests drive it identically.
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

  /** Set one sample's waveform across every tick (a single base waveform). */
  setWaveAll(sample: number, wave: number): void {
    for (let tick = 0; tick < SFX_TICKS; tick += 1) {
      this.engine.setSfxWave(sample, tick, wave);
    }
  }

  /** The sample's volume envelope as an array of levels, tick order. */
  volumeEnvelope(sample: number): number[] {
    return Array.from({ length: SFX_TICKS }, (_unused, tick) => this.engine.getSfxVolume(sample, tick));
  }

  /** True when every tick of the sample is silent (volume 0). */
  isSilent(sample: number): boolean {
    return this.volumeEnvelope(sample).every((level) => level === 0);
  }
}
