/**
 * Audio output. Owns the AudioContext lifecycle and streams engine-generated
 * PCM samples to the speakers.
 *
 * Mobile browsers block audio until a user gesture, so the context starts
 * suspended and is resumed via {@link AudioController.resume} from the same
 * gesture that starts playback.
 */

/** Int16 PCM, mono, at the context sample rate — the format TIC-80 emits. */
export class AudioController {
  private readonly context: AudioContext;
  private readonly gain: GainNode;
  private nextStartTime = 0;

  constructor(sampleRate: number) {
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
    if (samples.length === 0) {
      return;
    }

    const buffer = this.context.createBuffer(1, samples.length, this.context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      // Convert signed 16-bit PCM to the Web Audio [-1, 1] float range.
      channel[i] = (samples[i] ?? 0) / 0x8000;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const now = this.context.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  destroy(): void {
    this.gain.disconnect();
    void this.context.close();
  }
}
