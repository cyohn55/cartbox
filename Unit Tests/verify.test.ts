/**
 * Unit tests for replay verification (Platform P2).
 *
 * The core is pure over a ConsoleInstance: re-run a replay, collect the mailbox
 * events, and confirm the claimed score matches what the cart actually emitted.
 * A fake console simulates a cart emitting events on a schedule, so the logic is
 * tested without the WASM engine.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import {
  extractScore,
  extractUnlocks,
  runReplayEvents,
  verifyReplayScore,
  type Replay,
} from "@cartbox/player";

const CAPACITY = 21;

interface ScheduledEvent {
  atFrame: number;
  type: number;
  id: number;
  value: number;
}

/**
 * A fake console that "emits" scheduled events as it ticks, exposing them through
 * readMailbox exactly as the real engine's pmem mailbox would.
 */
function makeFakeConsole(schedule: ScheduledEvent[]) {
  let frame = -1; // becomes 0 on the first tick
  const emitted: Array<{ type: number; id: number; value: number }> = [];

  const buildWords = (): Uint32Array => {
    const words = new Uint32Array(1 + CAPACITY * 3);
    emitted.forEach((event, index) => {
      const base = 1 + (index % CAPACITY) * 3;
      words[base] = event.type;
      words[base + 1] = event.id;
      words[base + 2] = event.value;
    });
    words[0] = emitted.length;
    return words;
  };

  return {
    loadCartridge: () => true,
    tick: () => {
      frame += 1;
      for (const s of schedule) {
        if (s.atFrame === frame) {
          emitted.push({ type: s.type, id: s.id, value: s.value });
        }
      }
    },
    readFramebuffer: () => new Uint8Array(0),
    readAudioSamples: () => new Int16Array(0),
    readMailbox: () => buildWords(),
    dispose: () => {},
  };
}

function replay(frameCount: number): Replay {
  return {
    version: 1,
    modelId: "classic",
    cartHash: "test",
    seed: 7,
    frameCount,
    inputs: [{ frame: 0, mask: 0 }],
  };
}

const TYPE_ACHIEVEMENT = 1;
const TYPE_SCORE = 2;

describe("runReplayEvents", () => {
  it("collects events emitted across the replay", () => {
    const console = makeFakeConsole([
      { atFrame: 1, type: TYPE_ACHIEVEMENT, id: 42, value: 0 },
      { atFrame: 3, type: TYPE_SCORE, id: 0, value: 500 },
    ]);
    const events = runReplayEvents(console, replay(5));

    expect(events.map((e) => e.kind)).toEqual(["achievement", "score"]);
    expect(extractScore(events)).toBe(500);
    expect(extractUnlocks(events)).toEqual([42]);
  });
});

describe("verifyReplayScore", () => {
  it("verifies a correct claim and rejects a tampered one", () => {
    const schedule = [
      { atFrame: 2, type: TYPE_SCORE, id: 0, value: 100 },
      { atFrame: 4, type: TYPE_SCORE, id: 0, value: 250 }, // best = 250
    ];

    expect(verifyReplayScore(makeFakeConsole(schedule), replay(6), 250).verified).toBe(true);
    expect(verifyReplayScore(makeFakeConsole(schedule), replay(6), 999).verified).toBe(false);
  });

  it("reports the recomputed score even when it differs from the claim", () => {
    const schedule = [{ atFrame: 1, type: TYPE_SCORE, id: 0, value: 80 }];
    const result = verifyReplayScore(makeFakeConsole(schedule), replay(3), 12345);
    expect(result.score).toBe(80);
    expect(result.verified).toBe(false);
  });

  it("does not verify a claim when the cart emitted no score", () => {
    const result = verifyReplayScore(makeFakeConsole([]), replay(3), 0);
    expect(result.score).toBeNull();
    expect(result.verified).toBe(false);
  });
});
