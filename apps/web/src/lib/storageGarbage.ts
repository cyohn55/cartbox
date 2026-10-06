/**
 * Emptying the storage garbage queue (migration 0030): objects whose rows were
 * deleted in the database — a cart's .tic and offloaded mesh, a snapshot's
 * payload — are queued by triggers there, and deleted here, a few at a time,
 * whenever the API writes to storage anyway (cart saves, snapshots).
 *
 * Best effort: a failure leaves the key queued for next time; a missing object
 * deletes as a no-op. Server-only.
 */

import { isObjectStorageConfigured } from "./meshStorage";
import { deleteObject } from "./storage";
import { serviceClient } from "./supabase";

/** The queue: the oldest keys, and marking some done. */
export interface GarbageQueue {
  take(limit: number): Promise<string[]>;
  done(keys: readonly string[]): Promise<void>;
}

/** Delete up to `limit` queued objects; returns the keys deleted. */
export async function drainGarbage(queue: GarbageQueue, remove: (key: string) => Promise<void>, limit = 25): Promise<string[]> {
  const keys = await queue.take(limit);
  const deleted: string[] = [];
  for (const key of keys) {
    try {
      await remove(key);
      deleted.push(key);
    } catch {
      // Stays queued.
    }
  }
  if (deleted.length > 0) await queue.done(deleted);
  return deleted;
}

/** The queue in the database. */
export function databaseGarbageQueue(): GarbageQueue {
  const db = serviceClient();
  return {
    async take(limit) {
      const { data, error } = await db.from("storage_garbage").select("key").order("queued_at", { ascending: true }).limit(limit);
      return error || !data ? [] : data.map((row) => row.key as string);
    },
    async done(keys) {
      await db.from("storage_garbage").delete().in("key", [...keys]);
    },
  };
}

/** Empty a little of the queue, never failing the request that called it. */
export async function collectStorageGarbage(limit = 25): Promise<void> {
  if (!isObjectStorageConfigured()) return;
  try {
    await drainGarbage(databaseGarbageQueue(), deleteObject, limit);
  } catch {
    // A missing table (migration 0030 not applied) or a storage hiccup: next time.
  }
}
