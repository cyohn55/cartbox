/**
 * Multi-bank tests. A cart carries several banks, each with its own tiles,
 * palette, map, SFX, and music; the editor edits one at a time via setBank.
 * These assert that banks are fully isolated and that the current bank clamps.
 */

import { describe, expect, it } from "vitest";
import { BANK_COUNT, StubCartEngine } from "@cartbox/editor";

describe("bank selection", () => {
  it("defaults to bank 0 and ignores out-of-range switches", () => {
    const engine = new StubCartEngine();
    expect(engine.getBank()).toBe(0);
    engine.setBank(3);
    expect(engine.getBank()).toBe(3);
    engine.setBank(BANK_COUNT); // too high
    engine.setBank(-1); // too low
    expect(engine.getBank()).toBe(3);
  });
});

describe("bank isolation", () => {
  it("keeps tile pixels separate per bank", () => {
    const engine = new StubCartEngine();
    engine.setBank(0);
    engine.setPixel(0, 5, 1, 1, 7);
    engine.setBank(1);
    expect(engine.getPixel(0, 5, 1, 1)).toBe(0);
    engine.setPixel(0, 5, 1, 1, 3);

    engine.setBank(0);
    expect(engine.getPixel(0, 5, 1, 1)).toBe(7);
    engine.setBank(1);
    expect(engine.getPixel(0, 5, 1, 1)).toBe(3);
  });

  it("keeps palette, map, SFX, and music separate per bank", () => {
    const engine = new StubCartEngine();
    engine.setBank(2);
    engine.setPaletteColor(1, 10, 20, 30);
    engine.setMapCell(3, 3, 9);
    engine.setSfxVolume(1, 0, 12);
    engine.setMusicNoteField(0, 0, 8);

    engine.setBank(3);
    expect(Array.from(engine.getPalette().slice(3, 6))).not.toEqual([10, 20, 30]);
    expect(engine.getMapCell(3, 3)).toBe(0);
    expect(engine.getSfxVolume(1, 0)).toBe(0);
    expect(engine.getMusicNoteField(0, 0)).toBe(0);

    engine.setBank(2);
    expect(Array.from(engine.getPalette().slice(3, 6))).toEqual([10, 20, 30]);
    expect(engine.getMapCell(3, 3)).toBe(9);
    expect(engine.getSfxVolume(1, 0)).toBe(12);
    expect(engine.getMusicNoteField(0, 0)).toBe(8);
  });
});
