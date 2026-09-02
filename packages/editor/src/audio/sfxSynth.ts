/**
 * Rendering a cart's SFX to audio samples, so the editor can play a sound back.
 *
 * The SFX and Music editors had no playback at all. A creator drew a volume
 * envelope, chose a waveform, and could only find out what it sounded like by
 * pressing Run and triggering the sound inside the game. That is the single
 * largest gap in the editor, and it does not need the engine to close: an SFX
 * sample is a short envelope over a 32-step wavetable, which is a few dozen
 * lines of arithmetic.
 *
 * This module is that arithmetic, kept pure — it takes plain arrays and returns
 * a Float32Array — so it runs in a unit test with no AudioContext, no DOM and
 * no WASM. The browser half (`useAudioPreview`) only has to hand the result to
 * Web Audio.
 *
 * **This is a preview, not the core's mixer.** It reproduces what the editor's
 * own controls express — per-tick volume, waveform, arpeggio and fine pitch,
 * over the cart's real 4-bit wavetables — at TIC-80's tick rate. It does not
 * reproduce the core's channel mixing, its envelope loop hardware, or the
 * `speed`/`reverse` fields, which live past the region the WASM shim exposes.
 * Close enough to answer "does this laser sound right"; not a substitute for
 * hearing the cart run.
 */

/** SFX envelopes advance one step per console frame. */
export const SFX_TICK_HZ = 60;

/** MIDI note number of TIC-80's note 0, octave 0 (C-0). */
const MIDI_C0 = 12;

/** A4 = 440 Hz at MIDI 69, the tuning every other note is derived from. */
const A4_HZ = 440;
const A4_MIDI = 69;

export interface SfxRenderRequest {
  /** Per-tick volume, 0..15. Its length sets the sound's length. */
  readonly volume: readonly number[];
  /** Per-tick waveform index, 0..15. */
  readonly wave: readonly number[];
  /** Per-tick arpeggio offset in semitones, 0..15. */
  readonly chord?: readonly number[];
  /** Per-tick fine pitch offset, -8..7 (sixteenths of a semitone). */
  readonly pitch?: readonly number[];
  /** The 16 shared wavetables, each 32 steps of 0..15. */
  readonly waveforms: readonly (readonly number[])[];
  /** Note within the octave, 0..11 (0 = C). */
  readonly note?: number;
  /** Octave, 0..7. */
  readonly octave?: number;
  /** Output sample rate. */
  readonly sampleRate: number;
}

/** Frequency in Hz of a note/octave pair, plus semitone and fine offsets. */
export function noteFrequency(note: number, octave: number, semitones = 0, sixteenths = 0): number {
  const midi = MIDI_C0 + octave * 12 + note + semitones + sixteenths / 16;
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/**
 * Render one SFX sample to mono PCM in -1..1.
 *
 * The wavetable is read by phase rather than resampled per tick, so a pitch
 * that changes mid-envelope stays continuous instead of clicking at every tick
 * boundary — which is what a naive "one buffer per tick" renderer produces and
 * what makes a preview sound broken even when the data is right.
 */
export function renderSfx(request: SfxRenderRequest): Float32Array {
  const { volume, wave, chord, pitch, waveforms, sampleRate } = request;
  const note = request.note ?? 0;
  const octave = request.octave ?? 4;

  const ticks = volume.length;
  const samplesPerTick = Math.max(1, Math.round(sampleRate / SFX_TICK_HZ));
  const output = new Float32Array(ticks * samplesPerTick);
  if (ticks === 0) return output;

  const steps = waveforms[0]?.length ?? 32;
  // Phase in wavetable steps, carried across ticks so the waveform never jumps.
  let phase = 0;

  for (let tick = 0; tick < ticks; tick += 1) {
    const level = clamp(volume[tick] ?? 0, 0, 15) / 15;
    const table = waveforms[clamp(wave[tick] ?? 0, 0, waveforms.length - 1)] ?? [];
    const frequency = noteFrequency(note, octave, chord?.[tick] ?? 0, pitch?.[tick] ?? 0);
    // How far through the table one output sample advances.
    const phaseStep = (frequency * steps) / sampleRate;

    for (let index = 0; index < samplesPerTick; index += 1) {
      const step = Math.floor(phase) % steps;
      // 4-bit unsigned wavetable, centred to -1..1.
      const raw = ((table[step] ?? 0) - 7.5) / 7.5;
      output[tick * samplesPerTick + index] = raw * level;
      phase += phaseStep;
      if (phase >= steps) phase -= steps;
    }
  }

  return applyEdgeFade(output, sampleRate);
}

/**
 * A few milliseconds of fade at each end.
 *
 * A sample that starts or stops mid-waveform steps the speaker cone, which is
 * audible as a click on every single preview. The fade is short enough not to
 * change what the creator hears in the sound itself.
 */
function applyEdgeFade(buffer: Float32Array, sampleRate: number): Float32Array {
  const fade = Math.min(Math.floor(sampleRate * 0.003), Math.floor(buffer.length / 2));
  for (let index = 0; index < fade; index += 1) {
    const gain = index / fade;
    buffer[index] = (buffer[index] ?? 0) * gain;
    const tail = buffer.length - 1 - index;
    buffer[tail] = (buffer[tail] ?? 0) * gain;
  }
  return buffer;
}

/** One row of a pattern, as the preview needs it. */
export interface PatternStep {
  /** Note within the octave, 0..11, or null for a rest or a note-off. */
  readonly note: number | null;
  readonly octave: number;
  /** Which SFX sample voices it. */
  readonly sfx: number;
}

export interface PatternRenderRequest {
  readonly rows: readonly PatternStep[];
  /** Resolve one sample's envelopes, so the caller owns the SoundBank. */
  readonly sample: (index: number) => Omit<SfxRenderRequest, "note" | "octave" | "sampleRate">;
  /** Console frames each row lasts. TIC-80's default tempo is six. */
  readonly ticksPerRow?: number;
  readonly sampleRate: number;
}

/**
 * Render a music pattern by laying each row's sample onto one buffer.
 *
 * Rows overlap when a sample outlasts its row, which is what a tracker actually
 * sounds like; summing and then clipping to -1..1 keeps that honest without a
 * mixer.
 */
export function renderPattern(request: PatternRenderRequest): Float32Array {
  const { rows, sample, sampleRate } = request;
  const ticksPerRow = request.ticksPerRow ?? 6;
  const samplesPerTick = Math.max(1, Math.round(sampleRate / SFX_TICK_HZ));
  const samplesPerRow = samplesPerTick * ticksPerRow;

  // Long enough for the last row's sample to ring out rather than being cut.
  const voices = rows.map((row) =>
    row.note === null
      ? null
      : renderSfx({ ...sample(row.sfx), note: row.note, octave: row.octave, sampleRate }),
  );
  const tail = voices.reduce((longest, voice) => Math.max(longest, voice?.length ?? 0), 0);
  const output = new Float32Array(rows.length * samplesPerRow + tail);

  voices.forEach((voice, row) => {
    if (!voice) return;
    const start = row * samplesPerRow;
    for (let index = 0; index < voice.length; index += 1) {
      const at = start + index;
      output[at] = clamp((output[at] ?? 0) + (voice[index] ?? 0), -1, 1);
    }
  });

  return output;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
