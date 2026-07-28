/**
 * SFX model tests. They drive the real SoundBank over the real StubCartEngine
 * and assert on observable outputs: envelope reads/writes, 4-bit clamping,
 * bounds, the base-waveform setter, and the seeded demo sample.
 */

import { describe, expect, it } from "vitest";
import { SFX_CHANNEL, SoundBank, StubCartEngine } from "@cartbox/editor";

function newBank(): SoundBank {
  return new SoundBank(new StubCartEngine());
}

describe("SoundBank volume envelope", () => {
  it("round-trips a volume level", () => {
    const bank = newBank();
    bank.setVolume(3, 5, 12);
    expect(bank.getVolume(3, 5)).toBe(12);
  });

  it("clamps volume into the 0..15 range", () => {
    const bank = newBank();
    bank.setVolume(1, 0, 99);
    expect(bank.getVolume(1, 0)).toBe(bank.maxValue);
  });

  it("ignores writes outside the sample/tick bounds", () => {
    const bank = newBank();
    expect(() => bank.setVolume(bank.sampleCount, bank.ticks, 5)).not.toThrow();
    expect(bank.getVolume(bank.sampleCount, bank.ticks)).toBe(0);
  });

  it("reports a full envelope, one level per tick", () => {
    const bank = newBank();
    bank.setVolume(2, 0, 15);
    bank.setVolume(2, 1, 8);
    const envelope = bank.volumeEnvelope(2);
    expect(envelope).toHaveLength(bank.ticks);
    expect(envelope[0]).toBe(15);
    expect(envelope[1]).toBe(8);
  });
});

describe("SoundBank waveform", () => {
  it("sets one base waveform across every tick", () => {
    const bank = newBank();
    bank.setWaveAll(4, 9);
    expect(bank.getWave(4, 0)).toBe(9);
    expect(bank.getWave(4, bank.ticks - 1)).toBe(9);
  });
});

describe("SoundBank waveforms", () => {
  it("round-trips a waveform step and clamps to 0..15", () => {
    const bank = newBank();
    bank.setWaveform(3, 10, 9);
    expect(bank.getWaveform(3, 10)).toBe(9);
    bank.setWaveform(3, 10, 99);
    expect(bank.getWaveform(3, 10)).toBe(bank.waveformMax);
  });

  it("reports a full waveform curve, one level per step", () => {
    const bank = newBank();
    const curve = bank.waveformCurve(2);
    expect(curve).toHaveLength(bank.waveformSteps);
  });

  it("opens with a non-flat seeded waveform 0 (a sine)", () => {
    const bank = newBank();
    const curve = bank.waveformCurve(0);
    expect(new Set(curve).size).toBeGreaterThan(1);
  });
});

describe("SoundBank envelope loops", () => {
  it("round-trips a loop's start and size", () => {
    const bank = newBank();
    bank.setLoopStart(4, SFX_CHANNEL.volume, 3);
    bank.setLoopSize(4, SFX_CHANNEL.volume, 6);
    expect(bank.getLoop(4, SFX_CHANNEL.volume)).toEqual({ start: 3, size: 6 });
  });

  it("keeps each envelope channel's loop independent", () => {
    const bank = newBank();
    bank.setLoopSize(4, SFX_CHANNEL.volume, 6);
    bank.setLoopSize(4, SFX_CHANNEL.pitch, 2);
    expect(bank.getLoop(4, SFX_CHANNEL.volume).size).toBe(6);
    expect(bank.getLoop(4, SFX_CHANNEL.pitch).size).toBe(2);
    expect(bank.getLoop(4, SFX_CHANNEL.wave).size).toBe(0);
  });
});

describe("SoundBank silence", () => {
  it("treats an all-zero sample as silent", () => {
    const bank = newBank();
    expect(bank.isSilent(20)).toBe(true);
    bank.setVolume(20, 10, 1);
    expect(bank.isSilent(20)).toBe(false);
  });

  it("opens with a non-silent seeded sample 0", () => {
    const bank = newBank();
    expect(bank.isSilent(0)).toBe(false);
    expect(bank.getVolume(0, 0)).toBe(bank.maxValue);
  });
});
