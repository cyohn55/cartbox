/**
 * Unit tests for the event mailbox codec (Platform P2).
 *
 * decodeMailbox reads the pmem-backed ring the cartbox SDK writes to: it must
 * return only events newer than the last sequence, map type codes to kinds, and
 * drop the oldest when a burst overflows the ring rather than reading stale slots.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import {
  EVENT_CAPACITY,
  MAILBOX_TYPE_ACHIEVEMENT,
  MAILBOX_TYPE_PROGRESS,
  MAILBOX_TYPE_SCORE,
  decodeMailbox,
  hashEventId,
} from "@cartbox/player";

// Derived from the decoder's own ring size so the test tracks the protocol
// (the mailbox window is shared with the lights block; see mailbox.ts).
const CAPACITY = EVENT_CAPACITY;

interface RawEvent {
  type: number;
  id: number;
  value: number;
}

/** Writes a sequence of events into a fresh mailbox word array (as the SDK would). */
function buildMailbox(events: RawEvent[], capacity = CAPACITY): Uint32Array {
  const words = new Uint32Array(1 + capacity * 3);
  events.forEach((event, index) => {
    const slot = index % capacity;
    const base = 1 + slot * 3;
    words[base] = event.type;
    words[base + 1] = event.id;
    words[base + 2] = event.value;
  });
  words[0] = events.length; // sequence counter
  return words;
}

describe("decodeMailbox", () => {
  it("returns all events since the baseline, with kinds mapped", () => {
    const words = buildMailbox([
      { type: MAILBOX_TYPE_ACHIEVEMENT, id: 111, value: 0 },
      { type: MAILBOX_TYPE_SCORE, id: 0, value: 4200 },
      { type: MAILBOX_TYPE_PROGRESS, id: 222, value: 10 },
    ]);

    const { events, seq } = decodeMailbox(words, 0);
    expect(seq).toBe(3);
    expect(events).toEqual([
      { kind: "achievement", type: MAILBOX_TYPE_ACHIEVEMENT, id: 111, value: 0 },
      { kind: "score", type: MAILBOX_TYPE_SCORE, id: 0, value: 4200 },
      { kind: "progress", type: MAILBOX_TYPE_PROGRESS, id: 222, value: 10 },
    ]);
  });

  it("returns nothing when the sequence has not advanced", () => {
    const words = buildMailbox([{ type: MAILBOX_TYPE_SCORE, id: 0, value: 1 }]);
    expect(decodeMailbox(words, 1).events).toEqual([]);
  });

  it("returns only events newer than the last seen sequence", () => {
    const words = buildMailbox([
      { type: MAILBOX_TYPE_SCORE, id: 0, value: 1 },
      { type: MAILBOX_TYPE_SCORE, id: 0, value: 2 },
      { type: MAILBOX_TYPE_SCORE, id: 0, value: 3 },
    ]);
    const { events } = decodeMailbox(words, 2);
    expect(events.map((e) => e.value)).toEqual([3]);
  });

  it("drops the oldest events when a burst overflows the ring", () => {
    // Emit 2*capacity events; only the last `capacity` slots survive in the ring.
    const total = CAPACITY * 2;
    const raw = Array.from({ length: total }, (_, i) => ({
      type: MAILBOX_TYPE_SCORE,
      id: 0,
      value: i,
    }));
    const words = buildMailbox(raw);

    const { events, seq } = decodeMailbox(words, 0);
    expect(seq).toBe(total);
    // At most a full ring is readable.
    expect(events.length).toBe(CAPACITY);
    // The newest event's value is present.
    expect(events.some((e) => e.value === total - 1)).toBe(true);
  });

  it("labels unknown type codes", () => {
    const words = buildMailbox([{ type: 99, id: 5, value: 0 }]);
    expect(decodeMailbox(words, 0).events[0]?.kind).toBe("unknown");
  });
});

describe("hashEventId", () => {
  it("is stable and 32-bit unsigned", () => {
    const a = hashEventId("first_blood");
    expect(a).toBe(hashEventId("first_blood"));
    expect(a).not.toBe(hashEventId("second_blood"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffffffff);
  });
});
