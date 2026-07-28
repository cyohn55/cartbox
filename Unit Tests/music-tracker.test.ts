/**
 * Music tracker model tests. They drive the real MusicTracker over the real
 * StubCartEngine and assert on observable cells: note placement, note-off,
 * clearing, pitch wrap, labels, and the seeded demo pattern.
 */

import { describe, expect, it } from "vitest";
import { MusicTracker, StubCartEngine } from "@cartbox/editor";

function newTracker(): MusicTracker {
  return new MusicTracker(new StubCartEngine());
}

describe("MusicTracker note placement", () => {
  it("round-trips a note with its octave and SFX", () => {
    const tracker = newTracker();
    tracker.setNote(3, 10, 4, 5, 21); // E, octave 5, sfx 21
    expect(tracker.getCell(3, 10)).toEqual({ kind: "note", note: 4, octave: 5, sfx: 21 });
  });

  it("places a note-off and clears back to empty", () => {
    const tracker = newTracker();
    tracker.setNote(0, 2, 0, 4, 0);
    tracker.setStop(0, 2);
    expect(tracker.getCell(0, 2).kind).toBe("stop");
    tracker.clear(0, 2);
    expect(tracker.getCell(0, 2).kind).toBe("empty");
  });

  it("wraps pitches into a single octave", () => {
    const tracker = newTracker();
    tracker.setNote(1, 0, 12, 4, 0); // 12 wraps to 0 (C)
    expect(tracker.getCell(1, 0).note).toBe(0);
  });
});

describe("MusicTracker effects", () => {
  it("round-trips a command and parameter", () => {
    const tracker = newTracker();
    tracker.setCommand(2, 5, 6); // vibrato
    tracker.setParam(2, 5, 0x37);
    const effect = tracker.getEffect(2, 5);
    expect(effect.command).toBe(6);
    expect(effect.param).toBe(0x37);
  });

  it("labels effects and formats an empty command as dots", () => {
    const tracker = newTracker();
    expect(tracker.effectLabel(tracker.getEffect(0, 0))).toBe("···");
    tracker.setCommand(0, 0, 6);
    tracker.setParam(0, 0, 0x37);
    expect(tracker.effectLabel(tracker.getEffect(0, 0))).toBe("V37");
  });

  it("does not disturb the note when setting an effect", () => {
    const tracker = newTracker();
    tracker.setNote(1, 0, 4, 5, 21);
    tracker.setCommand(1, 0, 4);
    tracker.setParam(1, 0, 0xab);
    expect(tracker.getCell(1, 0)).toEqual({ kind: "note", note: 4, octave: 5, sfx: 21 });
  });
});

describe("MusicTracker labels", () => {
  const tracker = newTracker();

  it("formats notes, stops, and empties as fixed-width labels", () => {
    expect(tracker.label({ kind: "empty" })).toBe("---");
    expect(tracker.label({ kind: "stop" })).toBe("===");
    expect(tracker.label({ kind: "note", note: 0, octave: 4, sfx: 0 })).toBe("C-4");
    expect(tracker.label({ kind: "note", note: 1, octave: 3, sfx: 0 })).toBe("C#3");
  });
});

describe("MusicTracker song arrangement", () => {
  it("round-trips a frame's channel pattern", () => {
    const tracker = newTracker();
    tracker.setFramePattern(1, 3, 2, 17);
    expect(tracker.getFramePattern(1, 3, 2)).toBe(17);
  });

  it("keeps each channel's pattern independent within a frame", () => {
    const tracker = newTracker();
    tracker.setFramePattern(0, 0, 0, 5);
    tracker.setFramePattern(0, 0, 1, 9);
    tracker.setFramePattern(0, 0, 3, 31);
    expect(tracker.getFramePattern(0, 0, 0)).toBe(5);
    expect(tracker.getFramePattern(0, 0, 1)).toBe(9);
    expect(tracker.getFramePattern(0, 0, 2)).toBe(0);
    expect(tracker.getFramePattern(0, 0, 3)).toBe(31);
  });
});

describe("MusicTracker pattern state", () => {
  it("reports an empty pattern and a non-empty one", () => {
    const tracker = newTracker();
    expect(tracker.isEmpty(5)).toBe(true);
    tracker.setNote(5, 0, 7, 4, 0);
    expect(tracker.isEmpty(5)).toBe(false);
  });

  it("opens with the seeded arpeggio on pattern 0", () => {
    const tracker = newTracker();
    expect(tracker.isEmpty(0)).toBe(false);
    expect(tracker.getCell(0, 0)).toEqual({ kind: "note", note: 0, octave: 4, sfx: 0 });
  });
});
