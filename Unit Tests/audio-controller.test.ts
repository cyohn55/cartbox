/**
 * The player's audio output (packages/player/src/audio.ts). The cores emit
 * interleaved stereo, sampleRate / 60 left/right pairs a frame; it used to be
 * queued as one mono run of twice the length, so the chip's sound played at
 * half speed, an octave low, falling further behind every frame.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioController } from "../packages/player/src/audio";

interface FakeBuffer {
  numberOfChannels: number;
  length: number;
  duration: number;
  data: Float32Array[];
  getChannelData(c: number): Float32Array;
}

const started: { buffer: FakeBuffer; at: number }[] = [];
let now = 0;

class FakeAudioContext {
  readonly sampleRate: number;
  readonly destination = {};
  state = "running";
  constructor(options: { sampleRate: number }) {
    this.sampleRate = options.sampleRate;
  }
  get currentTime() {
    return now;
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} };
  }
  createBuffer(channels: number, length: number, rate: number): FakeBuffer {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, duration: length / rate, data, getChannelData: (c) => data[c]! };
  }
  createBufferSource() {
    const source = {
      buffer: null as FakeBuffer | null,
      connect() {},
      start(at: number) {
        started.push({ buffer: source.buffer!, at });
      },
    };
    return source;
  }
  close() {
    return Promise.resolve();
  }
}

describe("AudioController", () => {
  beforeEach(() => {
    started.length = 0;
    now = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("plays a frame of interleaved stereo as left and right channels, 1/60 s long", () => {
    const audio = new AudioController(44100);
    const frame = new Int16Array(1470); // 735 pairs: what the cores emit a frame at 44.1 kHz
    for (let i = 0; i < 735; i += 1) {
      frame[i * 2] = 0x4000; // left: +0.5
      frame[i * 2 + 1] = -0x8000; // right: -1
    }
    audio.enqueue(frame);
    const { buffer } = started[0]!;
    expect(buffer.numberOfChannels).toBe(2);
    expect(buffer.length).toBe(735);
    expect(buffer.duration).toBeCloseTo(1 / 60, 6);
    expect(buffer.data[0]!.every((v) => v === 0.5)).toBe(true);
    expect(buffer.data[1]!.every((v) => v === -1)).toBe(true);
  });

  it("keeps up: sixty frames queue back to back and last one second, not two", () => {
    const audio = new AudioController(48000);
    for (let i = 0; i < 60; i += 1) audio.enqueue(new Int16Array(1600));
    const last = started[59]!;
    expect(last.at + last.buffer.duration).toBeCloseTo(1, 6);
    started.slice(1).forEach((s, i) => expect(s.at).toBeCloseTo(started[i]!.at + started[i]!.buffer.duration, 9));
  });

  it("ignores an empty frame, and mono output still works when asked for", () => {
    const stereo = new AudioController(44100);
    stereo.enqueue(new Int16Array(0));
    stereo.enqueue(new Int16Array(1));
    expect(started).toHaveLength(0);
    const mono = new AudioController(44100, 1);
    mono.enqueue(Int16Array.from([0x4000, -0x4000]));
    expect(started[0]!.buffer.numberOfChannels).toBe(1);
    expect(Array.from(started[0]!.buffer.data[0]!)).toEqual([0.5, -0.5]);
  });
});
