/**
 * Unit tests for the deterministic replay machinery (Platform P1):
 *   - ReplayRecorder run-length encoding
 *   - ReplaySource reconstruction (the record -> playback round-trip is lossless)
 *   - serialize/parse round-trip + validation
 *   - hashCart identity
 *
 * The round-trip test is the load-bearing one: it proves that replaying a
 * recorded input stream reproduces the exact per-frame masks — the host-side
 * half of the determinism guarantee.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import {
  ReplayError,
  ReplayRecorder,
  ReplaySource,
  REPLAY_VERSION,
  hashCart,
  parseReplay,
  serializeReplay,
} from "@cartbox/player";

/** Records a per-frame mask sequence and reconstructs it via a ReplaySource. */
function roundTrip(sequence: number[]): number[] {
  const recorder = new ReplayRecorder({ modelId: "classic", cartHash: "deadbeef" });
  for (const mask of sequence) {
    recorder.record(mask);
  }
  const replay = recorder.finish();
  const source = new ReplaySource(replay.inputs);
  return sequence.map((_, frame) => source.maskForFrame(frame));
}

const SEQUENCES: ReadonlyArray<number[]> = [
  [],
  [0],
  [0, 0, 0],
  [3, 3, 3, 3],
  [0, 0, 3, 3, 3, 1, 0],
  [1, 2, 4, 8, 16, 32, 64, 128],
  [5, 5, 0, 0, 5, 5, 0],
];

describe("ReplayRecorder", () => {
  it("records only mask changes, always starting at frame 0", () => {
    const recorder = new ReplayRecorder({ modelId: "classic", cartHash: "abc" });
    for (const mask of [0, 0, 3, 3, 1]) {
      recorder.record(mask);
    }
    const { inputs, frameCount } = recorder.finish();

    expect(frameCount).toBe(5);
    expect(inputs[0]?.frame).toBe(0);
    // Frames strictly increasing; no two adjacent entries share a mask.
    for (let i = 1; i < inputs.length; i++) {
      expect(inputs[i]!.frame).toBeGreaterThan(inputs[i - 1]!.frame);
      expect(inputs[i]!.mask).not.toBe(inputs[i - 1]!.mask);
    }
    // RLE never stores more entries than frames.
    expect(inputs.length).toBeLessThanOrEqual(frameCount);
  });
});

describe("record -> playback round-trip", () => {
  it("reproduces the exact per-frame mask sequence", () => {
    for (const sequence of SEQUENCES) {
      expect(roundTrip(sequence)).toEqual(sequence);
    }
  });

  it("collapses a constant input to a single stored entry", () => {
    const recorder = new ReplayRecorder({ modelId: "classic", cartHash: "abc" });
    for (let i = 0; i < 1000; i++) {
      recorder.record(7);
    }
    expect(recorder.finish().inputs).toHaveLength(1);
  });
});

describe("ReplaySource seeking", () => {
  it("returns the correct mask when frames are queried out of order", () => {
    const source = new ReplaySource([
      { frame: 0, mask: 0 },
      { frame: 3, mask: 5 },
      { frame: 6, mask: 2 },
    ]);

    // Forward, then rewind, then forward again.
    expect(source.maskForFrame(7)).toBe(2);
    expect(source.maskForFrame(1)).toBe(0);
    expect(source.maskForFrame(3)).toBe(5);
    expect(source.maskForFrame(5)).toBe(5);
  });
});

describe("serializeReplay / parseReplay", () => {
  it("round-trips a replay without loss", () => {
    const recorder = new ReplayRecorder({ modelId: "classic", cartHash: "abc123", seed: 42 });
    for (const mask of [0, 0, 1, 1, 4]) {
      recorder.record(mask);
    }
    const replay = recorder.finish();

    const restored = parseReplay(serializeReplay(replay));
    expect(restored).toEqual(replay);
    expect(restored.version).toBe(REPLAY_VERSION);
    expect(restored.seed).toBe(42);
  });

  it("rejects invalid JSON, wrong version, and missing fields", () => {
    expect(() => parseReplay("not json")).toThrow(ReplayError);
    expect(() => parseReplay(JSON.stringify({ version: 999, cartHash: "x", inputs: [] }))).toThrow(
      ReplayError,
    );
    expect(() => parseReplay(JSON.stringify({ version: REPLAY_VERSION }))).toThrow(ReplayError);
  });
});

describe("hashCart", () => {
  it("is stable for identical bytes and differs for different bytes", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    const c = new Uint8Array([1, 2, 3, 4, 6]);

    expect(hashCart(a)).toBe(hashCart(b));
    expect(hashCart(a)).not.toBe(hashCart(c));
    expect(hashCart(a)).toMatch(/^[0-9a-f]{8}$/); // 32-bit hex
  });
});
