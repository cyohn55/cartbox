/**
 * Database access for the worker: find carts awaiting a thumbnail and record the
 * result. A cart "needs a thumbnail" when it is published and thumb_key is null.
 *
 * NOTE: with several workers this select-then-update can double-render a cart
 * (harmless — the same PNG is produced and last write wins). For high volume,
 * add a `thumb_status` column and claim rows atomically with UPDATE ... RETURNING.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requiredEnv } from "./config.js";

/** A cart that still needs a thumbnail rendered. */
export interface PendingCart {
  id: string;
  r2_key: string;
  console_model: string;
}

let cachedClient: SupabaseClient | undefined;

function db(): SupabaseClient {
  if (!cachedClient) {
    cachedClient = createClient(
      requiredEnv("SUPABASE_URL"),
      requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false } },
    );
  }
  return cachedClient;
}

/** Fetches up to `limit` published carts that have no thumbnail yet. */
export async function findPendingThumbnails(limit: number): Promise<PendingCart[]> {
  const { data, error } = await db()
    .from("carts")
    .select("id, r2_key, console_model")
    .eq("published", true)
    .is("thumb_key", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to query pending thumbnails: ${error.message}`);
  }
  return data ?? [];
}

/** Records the rendered thumbnail's key against a cart. */
export async function setThumbnail(cartId: string, thumbKey: string): Promise<void> {
  const { error } = await db().from("carts").update({ thumb_key: thumbKey }).eq("id", cartId);
  if (error) {
    throw new Error(`Failed to set thumbnail for ${cartId}: ${error.message}`);
  }
}

/** A submitted score awaiting verification. */
export interface PendingScore {
  id: string;
  claimed_value: number;
  replay_id: string;
  profile_id: string | null;
}

/** The replay + cart references needed to re-run a submission. */
export interface ReplayRow {
  seed: number;
  data_r2_key: string;
  model_id: string;
  cart_id: string;
}

/** Fetches up to `limit` scores that still need verifying. */
export async function findPendingScores(limit: number): Promise<PendingScore[]> {
  const { data, error } = await db()
    .from("scores")
    .select("id, claimed_value, replay_id, profile_id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    throw new Error(`Failed to query pending scores: ${error.message}`);
  }
  return data ?? [];
}

export async function getReplayRow(id: string): Promise<ReplayRow> {
  const { data, error } = await db()
    .from("replays")
    .select("seed, data_r2_key, model_id, cart_id")
    .eq("id", id)
    .single();
  if (error || !data) {
    throw new Error(`Replay ${id} not found: ${error?.message ?? "missing"}`);
  }
  return data as ReplayRow;
}

export async function getCartR2Key(cartId: string): Promise<string> {
  const { data, error } = await db().from("carts").select("r2_key").eq("id", cartId).single();
  if (error || !data) {
    throw new Error(`Cart ${cartId} not found: ${error?.message ?? "missing"}`);
  }
  return (data as { r2_key: string }).r2_key;
}

/** Records a verification outcome. */
export async function setScoreStatus(id: string, status: "verified" | "rejected"): Promise<void> {
  const { error } = await db().from("scores").update({ status }).eq("id", id);
  if (error) {
    throw new Error(`Failed to set score status for ${id}: ${error.message}`);
  }
}

/** An achievement registered for a cart (id + hash for mailbox matching). */
export interface CartAchievement {
  id: string;
  hash: number;
}

/** Returns the achievements registered for a cart. */
export async function getCartAchievements(cartId: string): Promise<CartAchievement[]> {
  const { data, error } = await db().from("achievements").select("id, hash").eq("cart_id", cartId);
  if (error) {
    throw new Error(`Failed to load achievements for ${cartId}: ${error.message}`);
  }
  return (data ?? []).map((row) => ({ id: row.id as string, hash: Number(row.hash) }));
}

/** A replay queued for unlock-only verification (achievements without a score). */
export interface PendingReplayVerification {
  id: string;
  seed: number;
  data_r2_key: string;
  model_id: string;
  cart_id: string;
  player_id: string;
}

/** Fetches replays awaiting unlock verification (only those attributed to a player). */
export async function findPendingReplayVerifications(
  limit: number,
): Promise<PendingReplayVerification[]> {
  const { data, error } = await db()
    .from("replays")
    .select("id, seed, data_r2_key, model_id, cart_id, player_id")
    .eq("verify_status", "pending")
    .not("player_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) {
    throw new Error(`Failed to query pending replay verifications: ${error.message}`);
  }
  return (data ?? []) as PendingReplayVerification[];
}

/** Marks a replay's unlock verification complete. */
export async function setReplayVerified(id: string): Promise<void> {
  const { error } = await db().from("replays").update({ verify_status: "done" }).eq("id", id);
  if (error) {
    throw new Error(`Failed to mark replay ${id} verified: ${error.message}`);
  }
}

/** Grants achievement unlocks to a player, ignoring any already held. */
export async function grantUnlocks(profileId: string, achievementIds: string[]): Promise<void> {
  if (achievementIds.length === 0) {
    return;
  }
  const rows = achievementIds.map((achievementId) => ({
    profile_id: profileId,
    achievement_id: achievementId,
  }));
  const { error } = await db()
    .from("unlocks")
    .upsert(rows, { onConflict: "profile_id,achievement_id", ignoreDuplicates: true });
  if (error) {
    throw new Error(`Failed to grant unlocks for ${profileId}: ${error.message}`);
  }
}
