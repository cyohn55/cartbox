/**
 * SFX channel tests (packages/editor/src/model/SoundBank.ts and the engine's
 * per-tick accessors).
 *
 * A TIC-80 sample carries four per-tick envelopes — volume, waveform, arpeggio
 * and fine pitch. `SFX_CHANNEL` has named all four since the envelope loops
 * were added, but only volume and a single cart-wide waveform could actually be
 * written, so carts authored in this editor could not express sounds a plain
 * TIC-80 cart can.
 *
 * These tests drive the four through the stub engine, which is the same
 * interface the WASM engine implements.
 */

import { describe, expect, it } from "vitest";
import { SFX_CHANNEL, SFX_CHANNEL_INFO, SoundBank, StubCartEngine } from "@cartbox/editor";

function bankOf(): SoundBank {
  return new SoundBank(new StubCartEngine());
}

describe("the four SFX envelopes", () => {
  it("names all four, in the order the cartridge stores their loops", () => {
    expect(Object.keys(SFX_CHANNEL)).toEqual(["wave", "volume", "chord", "pitch"]);
  });

  it("describes each one for the editor, with its own bounds", () => {
    expect(SFX_CHANNEL_INFO.map((entry) => entry.id).sort()).toEqual(["chord", "pitch", "volume", "wave"]);
    for (const entry of SFX_CHANNEL_INFO) {
      expect(entry.label, entry.id).toBeTruthy();
      expect(entry.hint, entry.id).toBeTruthy();
      expect(entry.max, entry.id).toBeGreaterThan(entry.min);
    }
  });

  it("round-trips a volume through the generic reader and writer", () => {
    const bank = bankOf();
    bank.setEnvelope(3, "volume", 5, 12);
    expect(bank.envelopeValue(3, "volume", 5)).toBe(12);
    expect(bank.getVolume(3, 5)).toBe(12);
  });

  it("round-trips an arpeggio offset, which had no setter at all", () => {
    const bank = bankOf();
    bank.setChord(2, 4, 7);
    expect(bank.getChord(2, 4)).toBe(7);
    expect(bank.envelope(2, "chord")[4]).toBe(7);
  });

  it("round-trips a negative fine pitch", () => {
    // Pitch is a signed 4-bit field; -8..7 must survive the nibble packing.
    const bank = bankOf();
    bank.setPitch(1, 0, -8);
    bank.setPitch(1, 1, -1);
    bank.setPitch(1, 2, 7);
    expect(bank.getPitch(1, 0)).toBe(-8);
    expect(bank.getPitch(1, 1)).toBe(-1);
    expect(bank.getPitch(1, 2)).toBe(7);
  });

  it("sets a waveform at one tick, so a sound can change timbre mid-envelope", () => {
    const bank = bankOf();
    bank.setWaveAll(0, 3);
    bank.setWave(0, 10, 9);
    expect(bank.getWave(0, 0)).toBe(3);
    expect(bank.getWave(0, 10)).toBe(9);
  });

  it("keeps the four channels independent of one another", () => {
    const bank = bankOf();
    bank.setVolume(5, 2, 15);
    bank.setWave(5, 2, 4);
    bank.setChord(5, 2, 6);
    bank.setPitch(5, 2, -3);
    expect(bank.getVolume(5, 2)).toBe(15);
    expect(bank.getWave(5, 2)).toBe(4);
    expect(bank.getChord(5, 2)).toBe(6);
    expect(bank.getPitch(5, 2)).toBe(-3);
  });

  it("reads a whole envelope as one array per channel", () => {
    const bank = bankOf();
    bank.setChord(0, 0, 1);
    bank.setChord(0, 1, 2);
    const chord = bank.envelope(0, "chord");
    expect(chord).toHaveLength(bank.ticks);
    expect(chord.slice(0, 3)).toEqual([1, 2, 0]);
  });

  it("ignores a tick outside the sample rather than corrupting a neighbour", () => {
    const bank = bankOf();
    bank.setChord(0, 999, 5);
    expect(bank.getChord(0, 999)).toBe(0);
    expect(bank.envelope(0, "chord").every((value) => value === 0)).toBe(true);
  });

  it("assembles everything the preview synthesiser voices a sample with", () => {
    const bank = bankOf();
    bank.setVolume(0, 0, 15);
    bank.setChord(0, 0, 4);
    const spec = bank.renderSpec(0);
    expect(spec.volume).toHaveLength(bank.ticks);
    expect(spec.wave).toHaveLength(bank.ticks);
    expect(spec.chord[0]).toBe(4);
    expect(spec.pitch).toHaveLength(bank.ticks);
    expect(spec.waveforms).toHaveLength(bank.waveformCount);
    expect(spec.waveforms[0]).toHaveLength(bank.waveformSteps);
  });
});

describe("the signed-nibble packing pitch uses", () => {
  it("survives a round trip through the WASM engine's helpers", async () => {
    const { fromSignedNibble, toSignedNibble } = await import(
      "../packages/editor/src/engine/WasmCartEngine.ts"
    );
    for (let value = -8; value <= 7; value += 1) {
      expect(fromSignedNibble(toSignedNibble(value)), String(value)).toBe(value);
    }
  });

  it("clamps a value outside the field's range", async () => {
    const { fromSignedNibble, toSignedNibble } = await import(
      "../packages/editor/src/engine/WasmCartEngine.ts"
    );
    expect(fromSignedNibble(toSignedNibble(99))).toBe(7);
    expect(fromSignedNibble(toSignedNibble(-99))).toBe(-8);
  });
});
