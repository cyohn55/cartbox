/**
 * Verification worker (Platform P2).
 *
 * Re-runs replays headlessly — same cart (from R2), same seed, same recorded
 * inputs — and reads what the cart actually emitted through the mailbox. Two
 * queues share this machinery:
 *   - scores: confirm a claimed score, then grant any unlocks the run produced.
 *   - replays (unlock-only): grant unlocks for sessions that had achievements
 *     but no score to submit.
 * Because the run is deterministic, neither a tampered score nor a fabricated
 * unlock can pass.
 */

import {
  getModel,
  parseReplay,
  resolveUnlockedAchievements,
  seedCartridge,
  verifyReplayScore,
  type VerificationResult,
} from "@cartbox/player";

import {
  findPendingReplayVerifications,
  findPendingScores,
  getCartAchievements,
  getCartR2Key,
  getReplayRow,
  grantUnlocks,
  setReplayVerified,
  setScoreStatus,
  type PendingReplayVerification,
  type PendingScore,
} from "./db.js";
import { getObject } from "./storage.js";
import { loadEngine, openConsole } from "./engine.js";
import { resolveEngineUrl } from "./config.js";

/** References needed to re-run a replay. */
interface ReplayRefs {
  seed: number;
  data_r2_key: string;
  model_id: string;
  cart_id: string;
}

/** Loads the cart + replay and re-runs it deterministically. */
async function computeReplayResult(refs: ReplayRefs, claimedScore: number): Promise<VerificationResult> {
  const cartKey = await getCartR2Key(refs.cart_id);
  const [cartBytes, replayBytes] = await Promise.all([
    getObject(cartKey),
    getObject(refs.data_r2_key),
  ]);
  const replay = parseReplay(new TextDecoder().decode(replayBytes));

  const model = getModel(refs.model_id);
  const engineModule = await loadEngine(resolveEngineUrl(model.id));

  // Reproduce the exact bytes the player ran: the published cart (SDK included)
  // seeded with the replay's seed.
  const seededBytes = seedCartridge(cartBytes, replay.seed);
  const console = openConsole(engineModule, model, seededBytes);
  try {
    return verifyReplayScore(console, replay, claimedScore);
  } finally {
    console.dispose();
  }
}

/** Grants the achievements a run produced to a player (server-authoritative). */
async function grantRunUnlocks(cartId: string, profileId: string, unlockHashes: number[]): Promise<void> {
  if (unlockHashes.length === 0) {
    return;
  }
  const registered = await getCartAchievements(cartId);
  const unlocked = resolveUnlockedAchievements(unlockHashes, registered);
  await grantUnlocks(
    profileId,
    unlocked.map((achievement) => achievement.id),
  );
}

/** Verifies a single pending score and grants any unlocks the run produced. */
export async function verifyPendingScore(score: PendingScore): Promise<"verified" | "rejected"> {
  const replayRow = await getReplayRow(score.replay_id);
  const result = await computeReplayResult(replayRow, score.claimed_value);

  // Unlocks are trustworthy regardless of whether the score claim matched.
  if (score.profile_id) {
    await grantRunUnlocks(replayRow.cart_id, score.profile_id, result.unlocks);
  }

  const status = result.verified ? "verified" : "rejected";
  await setScoreStatus(score.id, status);
  return status;
}

/** Grants unlocks for a replay submitted without a score. */
export async function verifyPendingReplay(replay: PendingReplayVerification): Promise<void> {
  const result = await computeReplayResult(replay, 0); // claim ignored; only unlocks used
  await grantRunUnlocks(replay.cart_id, replay.player_id, result.unlocks);
  await setReplayVerified(replay.id);
}

export interface VerifyResult {
  verified: number;
  rejected: number;
  failed: number;
}

/** Processes one batch of pending scores. */
export async function verifyPendingScores(batchSize: number): Promise<VerifyResult> {
  const pending = await findPendingScores(batchSize);

  let verified = 0;
  let rejected = 0;
  let failed = 0;
  for (const score of pending) {
    try {
      const status = await verifyPendingScore(score);
      if (status === "verified") verified++;
      else rejected++;
    } catch (error) {
      failed++;
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Score verification failed for ${score.id}: ${reason}`);
    }
  }
  return { verified, rejected, failed };
}

/** Processes one batch of unlock-only replay verifications. */
export async function verifyPendingReplays(batchSize: number): Promise<{ granted: number; failed: number }> {
  const pending = await findPendingReplayVerifications(batchSize);

  let granted = 0;
  let failed = 0;
  for (const replay of pending) {
    try {
      await verifyPendingReplay(replay);
      granted++;
    } catch (error) {
      failed++;
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Replay verification failed for ${replay.id}: ${reason}`);
    }
  }
  return { granted, failed };
}
