/**
 * Audio output. Owns the AudioContext lifecycle and streams engine-generated
 * PCM samples to the speakers.
 *
 * Mobile browsers block audio until a user gesture, so the context starts
 * suspended and is resumed via {@link AudioController.resume} from the same
 * gesture that starts playback.
 */

/**
 * Int16 PCM at the context sample rate, interleaved stereo (left, right, left,
 * ...) — the format TIC-80 emits (TIC80_SAMPLE_CHANNELS is 2), and so the
 * dedicated Modern core too. One 60 Hz frame is sampleRate / 60 pairs.
 */
export class AudioController {
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private nextStartTime = 0;

  constructor(
    sampleRate: number,
    /** Interleaved channels per sample frame. */
    private readonly channels = 2,
  ) {
    this.context = new AudioContext({ sampleRate });
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
  }

  /** Resumes the context. Call from within a user-gesture handler. */
  async resume(): Promise<void> {
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  /** Suspends output so a paused player makes no sound. */
  async pause(): Promise<void> {
    if (this.context.state === "running") {
      await this.context.suspend();
    }
  }

  /**
   * Queues one frame's worth of samples for gapless playback.
   *
   * Each buffer is scheduled to begin exactly where the previous one ended,
   * which avoids clicks between frames. If the scheduler falls behind (e.g. a
   * background tab), it resyncs to the context clock.
   */
  enqueue(samples: Int16Array): void {
    const frames = Math.floor(samples.length / this.channels);
    if (frames === 0) {
      return;
    }

    // Split the interleaved samples into one buffer channel each. (Played as
    // one mono run they would last twice as long: half speed, an octave low,
    // and further behind every frame.)
    const buffer = this.context.createBuffer(this.channels, frames, this.context.sampleRate);
    for (let c = 0; c < this.channels; c++) {
      const channel = buffer.getChannelData(c);
      for (let i = 0; i < frames; i++) {
        // Convert signed 16-bit PCM to the Web Audio [-1, 1] float range.
        channel[i] = (samples[i * this.channels + c] ?? 0) / 0x8000;
      }
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const now = this.context.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  /** The context, for other sound (the scene's sounds, EP12) to play on. */
  get audioContext(): AudioContext {
    return this.context;
  }

  /** Where other sound joins the chip's: through the master volume, so it and pause cover everything. */
  get output(): AudioNode {
    return this.gain;
  }

  /** Master volume, 0 (silent) .. 1 (full). */
  setVolume(volume: number): void {
    this.gain.gain.value = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));
  }

  destroy(): void {
    this.gain.disconnect();
    void this.context.close();
  }
}
