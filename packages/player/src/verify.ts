/**
 * Replay verification (Platform P2).
 *
 * The payoff of deterministic replays + the event mailbox: a submitted score can
 * be trusted by *re-running the replay* headlessly and reading what the cart
 * actually emitted. Because the run is deterministic (recorded inputs + RNG
 * seed), the recomputed score is exactly what the player saw — so a tampered
 * claim can't pass.
 *
 * This module is pure over a {@link ConsoleInstance} (the caller loads the cart,
 * seeded and with the SDK, into the console). It reuses the same input playback
 * and mailbox decoding the live player uses, so verification and play agree.
 */

import type { ConsoleInstance } from "./engine.js";
import { decodeMailbox, type MailboxEvent } from "./mailbox.js";
import { ReplaySource, type Replay } from "./replay.js";
import { INPUT_BLOCK_BYTES, writeInputBlock } from "./actionsSdk.js";

/** How the cart was built: where its input block sits (bytes after pmem word 0), when it has input actions. */
export interface ReplayRunOptions {
  readonly inputOffset?: number;
}

/**
 * Re-runs a replay into a loaded console and returns every platform event the
 * cart emits. The console must already hold the correct cartridge (seeded with
 * `replay.seed`, SDK present) for the result to match the original session.
 * A recorded mask carries the console buttons in its low 8 bits and the input
 * actions (EP15) above them, which go to the input block when the cart has one.
 */
export function runReplayEvents(console: ConsoleInstance, replay: Replay, options: ReplayRunOptions = {}): MailboxEvent[] {
  const source = new ReplaySource(replay.inputs);
  let lastSeq = decodeMailbox(console.readMailbox(), 0).seq; // baseline pre-existing pmem
  const events: MailboxEvent[] = [];
  let lastActions = 0;

  for (let frame = 0; frame < replay.frameCount; frame++) {
    const input = source.maskForFrame(frame) >>> 0;
    if (options.inputOffset !== undefined) {
      const bytes = console.ramView(options.inputOffset, INPUT_BLOCK_BYTES);
      if (bytes) writeInputBlock(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), input >>> 8, lastActions);
      lastActions = input >>> 8;
    }
    console.tick(input & 0xff);
    const read = decodeMailbox(console.readMailbox(), lastSeq);
    lastSeq = read.seq;
    events.push(...read.events);
  }
  return events;
}

/** The best (maximum) score emitted, or null if the cart posted no score. */
export function extractScore(events: MailboxEvent[]): number | null {
  let best: number | null = null;
  for (const event of events) {
    if (event.kind === "score") {
      best = best === null ? event.value : Math.max(best, event.value);
    }
  }
  return best;
}

/** The distinct achievement ids unlocked during the run. */
export function extractUnlocks(events: MailboxEvent[]): number[] {
  const ids = new Set<number>();
  for (const event of events) {
    if (event.kind === "achievement") {
      ids.add(event.id);
    }
  }
  return [...ids];
}

export interface VerificationResult {
  /** The score the replay actually produced (null if none). */
  score: number | null;
  /** Achievement ids the replay legitimately unlocked. */
  unlocks: number[];
  /** True when the claimed score equals the recomputed score. */
  verified: boolean;
}

/**
 * Verifies a claimed score by re-running the replay.
 *
 * @param console A console already loaded with the seeded cart + SDK.
 * @param replay The recorded session.
 * @param claimedScore The score the submitter claims.
 */
export function verifyReplayScore(
  console: ConsoleInstance,
  replay: Replay,
  claimedScore: number,
  options: ReplayRunOptions = {},
): VerificationResult {
  const events = runReplayEvents(console, replay, options);
  const score = extractScore(events);
  return {
    score,
    unlocks: extractUnlocks(events),
    verified: score !== null && score === claimedScore,
  };
}
