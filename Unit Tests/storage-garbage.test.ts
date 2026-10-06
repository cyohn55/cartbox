/**
 * The storage garbage queue (migration 0030): objects left in storage by rows
 * deleted in the database — a cart's .tic and offloaded mesh, a snapshot's
 * payload — are queued by triggers, and the API deletes them a few at a time.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { drainGarbage, type GarbageQueue } from "../apps/web/src/lib/storageGarbage";

function memoryQueue(keys: string[]): GarbageQueue & { keys: string[] } {
  const q = {
    keys: [...keys],
    take: async (limit: number) => q.keys.slice(0, limit),
    done: async (done: readonly string[]) => {
      q.keys = q.keys.filter((k) => !done.includes(k));
    },
  };
  return q;
}

describe("draining the queue", () => {
  it("deletes the oldest keys up to the limit and marks them done", async () => {
    const queue = memoryQueue(["a", "b", "c"]);
    const removed: string[] = [];
    expect(await drainGarbage(queue, async (k) => void removed.push(k), 2)).toEqual(["a", "b"]);
    expect(removed).toEqual(["a", "b"]);
    expect(queue.keys).toEqual(["c"]);
  });

  it("keeps a key whose delete failed, for next time", async () => {
    const queue = memoryQueue(["ok", "flaky", "ok2"]);
    const deleted = await drainGarbage(queue, async (k) => {
      if (k === "flaky") throw new Error("storage hiccup");
    });
    expect(deleted).toEqual(["ok", "ok2"]);
    expect(queue.keys).toEqual(["flaky"]);
  });
});

describe("the migration", () => {
  it("queues a deleted snapshot's payload and a deleted cart's .tic and mesh, behind row-level security", () => {
    for (const file of ["0030_storage_garbage.sql", "apply-0030-to-prod.sql"]) {
      const sql = readFileSync(path.resolve(__dirname, "../supabase/migrations", file), "utf8");
      expect(sql).toContain("create table if not exists storage_garbage");
      expect(sql).toContain("alter table storage_garbage enable row level security;");
      expect(sql).toMatch(/create trigger cart_snapshots_queue_object after delete on cart_snapshots/);
      expect(sql).toMatch(/create trigger carts_queue_objects after delete on carts/);
      expect(sql).toContain("'meshes/' || old.id || '.json'");
      expect(sql).toContain("old.r2_key !~ '^https?://'");
      expect(sql).not.toMatch(/create policy/i);
    }
  });
});
