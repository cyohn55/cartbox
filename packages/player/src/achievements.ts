/**
 * Achievement resolution (Platform P2).
 *
 * The mailbox carries achievement unlocks as FNV-1a hashes of their string key
 * (see hashEventId / the cartbox SDK). To grant an unlock, the platform maps
 * those hashes back to the achievements registered for the cart. This resolver
 * is the pure core of that mapping; the worker fetches the cart's registered
 * achievements and calls it with the hashes a verified replay produced.
 */

/** An achievement as registered for a cart. */
export interface RegisteredAchievement {
  /** Achievement row id. */
  id: string;
  /** FNV-1a hash of the achievement key (matches the mailbox event id). */
  hash: number;
  /** Optional human key (e.g. "first_blood"). */
  key?: string;
}

/**
 * Returns the registered achievements whose hash appears in the unlock hashes.
 * Hashes are compared as unsigned 32-bit values, matching the mailbox encoding.
 */
export function resolveUnlockedAchievements(
  unlockHashes: number[],
  registered: RegisteredAchievement[],
): RegisteredAchievement[] {
  const unlocked = new Set(unlockHashes.map((hash) => hash >>> 0));
  return registered.filter((achievement) => unlocked.has(achievement.hash >>> 0));
}
