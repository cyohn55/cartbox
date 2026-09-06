/**
 * SFX synthesiser tests (packages/editor/src/audio/sfxSynth.ts).
 *
 * The SFX and Music editors had no playback of any kind: a creator drew a
 * volume envelope, chose a waveform, and could only find out what it sounded
 * like by pressing Run and triggering the sound inside the game.
 *
 * The synthesiser that closed that gap is pure by design, so this suite drives
 * it directly — no AudioContext, no DOM. Assertions are about the properties a
 * preview must have (silence is silent, a louder envelope is louder, a higher
 * note crosses zero more often), never about hard-coded sample values, which
 * would break on any harmless change to the rendering.
 */

import { describe, expect, it } from "vitest";
import { noteFrequency, renderPattern, renderSfx, SFX_TICK_HZ } from "@cartbox/editor";

const RATE = 8000;
/** A square-ish 32-step wavetable, like the cart's default waveform 0. */
const SQUARE = Array.from({ length: 32 }, (_unused, step) => (step < 16 ? 15 : 0));
const WAVEFORMS = [SQUARE, ...Array.from({ length: 15 }, () => SQUARE)];

function flat(value: number, ticks = 10): number[] {
  return Array.from({ length: ticks }, () => value);
}

/** How many times the signal crosses zero — a proxy for pitch. */
function zeroCrossings(samples: Float32Array): number {
  let count = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1] ?? 0;
    const current = samples[index] ?? 0;
    if (previous <= 0 && current > 0) count += 1;
  }
  return count;
}

function peak(samples: Float32Array): number {
  let highest = 0;
  for (const sample of samples) highest = Math.max(highest, Math.abs(sample));
  return highest;
}

describe("renderSfx", () => {
  it("renders one console frame per envelope tick", () => {
    const ticks = 12;
    const samples = renderSfx({
      volume: flat(15, ticks),
      wave: flat(0, ticks),
      waveforms: WAVEFORMS,
      sampleRate: RATE,
    });
    expect(samples.length).toBe(ticks * Math.round(RATE / SFX_TICK_HZ));
  });

  it("is silent when the volume envelope is silent", () => {
    const samples = renderSfx({
      volume: flat(0),
      wave: flat(0),
      waveforms: WAVEFORMS,
      sampleRate: RATE,
    });
    expect(peak(samples)).toBe(0);
  });

  it("gets louder as the volume envelope rises", () => {
    const quiet = renderSfx({ volume: flat(4), wave: flat(0), waveforms: WAVEFORMS, sampleRate: RATE });
    const loud = renderSfx({ volume: flat(15), wave: flat(0), waveforms: WAVEFORMS, sampleRate: RATE });
    expect(peak(loud)).toBeGreaterThan(peak(quiet));
  });

  it("stays inside the -1..1 range a buffer can hold", () => {
    const samples = renderSfx({ volume: flat(15), wave: flat(0), waveforms: WAVEFORMS, sampleRate: RATE });
    expect(peak(samples)).toBeLessThanOrEqual(1);
  });

  it("plays a higher octave at a higher pitch", () => {
    const low = renderSfx({ volume: flat(15), wave: flat(0), waveforms: WAVEFORMS, octave: 3, sampleRate: RATE });
    const high = renderSfx({ volume: flat(15), wave: flat(0), waveforms: WAVEFORMS, octave: 5, sampleRate: RATE });
    expect(zeroCrossings(high)).toBeGreaterThan(zeroCrossings(low));
  });

  it("raises the pitch when the arpeggio channel offsets the note", () => {
    const plain = renderSfx({ volume: flat(15), wave: flat(0), waveforms: WAVEFORMS, sampleRate: RATE });
    const arpeggiated = renderSfx({
      volume: flat(15),
      wave: flat(0),
      chord: flat(12), // one octave of semitones
      waveforms: WAVEFORMS,
      sampleRate: RATE,
    });
    expect(zeroCrossings(arpeggiated)).toBeGreaterThan(zeroCrossings(plain));
  });

  it("fades the edges, so a preview does not click", () => {
    const samples = renderSfx({ volume: flat(15), wave: flat(0), waveforms: WAVEFORMS, sampleRate: RATE });
    expect(Math.abs(samples[0] ?? 0)).toBeLessThan(peak(samples));
    expect(Math.abs(samples[samples.length - 1] ?? 0)).toBeLessThan(peak(samples));
  });

  it("renders nothing for an empty envelope", () => {
    const samples = renderSfx({ volume: [], wave: [], waveforms: WAVEFORMS, sampleRate: RATE });
    expect(samples.length).toBe(0);
  });
});

describe("noteFrequency", () => {
  it("tunes A4 to 440 Hz", () => {
    // A is note 9 within the octave.
    expect(noteFrequency(9, 4)).toBeCloseTo(440, 5);
  });

  it("doubles across an octave", () => {
    expect(noteFrequency(0, 5)).toBeCloseTo(noteFrequency(0, 4) * 2, 5);
  });

  it("moves a semitone by the twelfth root of two", () => {
    expect(noteFrequency(1, 4) / noteFrequency(0, 4)).toBeCloseTo(Math.pow(2, 1 / 12), 6);
  });

  it("applies a fine offset in sixteenths of a semitone", () => {
    const detuned = noteFrequency(0, 4, 0, 8);
    expect(detuned).toBeGreaterThan(noteFrequency(0, 4));
    expect(detuned).toBeLessThan(noteFrequency(1, 4));
  });
});

describe("renderPattern", () => {
  const sample = () => ({ volume: flat(6), wave: flat(0), waveforms: WAVEFORMS });

  it("lays each row a fixed number of ticks apart", () => {
    const rows = [
      { note: 0, octave: 4, sfx: 0 },
      { note: 4, octave: 4, sfx: 0 },
    ];
    const samples = renderPattern({ rows, sample, ticksPerRow: 6, sampleRate: RATE });
    const perRow = 6 * Math.round(RATE / SFX_TICK_HZ);
    // Two rows of spacing, plus the tail of the last sample ringing out.
    expect(samples.length).toBeGreaterThan(rows.length * perRow);
  });

  it("is silent for a pattern of rests", () => {
    const rows = [
      { note: null, octave: 4, sfx: 0 },
      { note: null, octave: 4, sfx: 0 },
    ];
    expect(peak(renderPattern({ rows, sample, sampleRate: RATE }))).toBe(0);
  });

  it("sounds a pattern that has notes in it", () => {
    const rows = [{ note: 7, octave: 4, sfx: 0 }];
    expect(peak(renderPattern({ rows, sample, sampleRate: RATE }))).toBeGreaterThan(0);
  });

  it("keeps overlapping rows inside the buffer range", () => {
    // Rows one tick apart guarantee their samples overlap and sum.
    const rows = Array.from({ length: 8 }, () => ({ note: 0, octave: 4, sfx: 0 }));
    const samples = renderPattern({ rows, sample, ticksPerRow: 1, sampleRate: RATE });
    expect(peak(samples)).toBeLessThanOrEqual(1);
  });
});
