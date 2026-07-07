/**
 * /api/replays — store a recorded replay (POST) and list a cart's replays (GET).
 *
 * The serialized replay JSON goes to R2; a `replays` row indexes it. A signed-in
 * user is attributed as the player; anonymous replays are allowed (player_id null),
 * since replays are recorded ambiently for everyone.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { serviceClient } from "@/lib/supabase";
import { putObject, publicUrl } from "@/lib/storage";
import { getSessionUserId } from "@/lib/auth";
import { parseReplay, ReplayError } from "@cartbox/player";

/** Replays are small (RLE input); reject anything implausibly large. */
const MAX_REPLAY_BYTES = 512 * 1024;

export async function GET(request: Request): Promise<NextResponse> {
  const cartId = new URL(request.url).searchParams.get("cartId");
  if (!cartId) {
    return NextResponse.json({ error: "cartId is required" }, { status: 400 });
  }

  const db = serviceClient();
  const { data, error } = await db
    .from("replays")
    .select("id, model_id, frame_count, created_at")
    .eq("cart_id", cartId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ replays: data });
}

export async function POST(request: Request): Promise<NextResponse> {
  const playerId = await getSessionUserId(request); // optional; may be null

  const body = (await request.json()) as { cartId?: string; replay?: string; verify?: boolean };
  if (!body.cartId || typeof body.replay !== "string") {
    return NextResponse.json({ error: "cartId and replay are required" }, { status: 400 });
  }
  if (body.replay.length > MAX_REPLAY_BYTES) {
    return NextResponse.json({ error: "Replay too large" }, { status: 400 });
  }

  let replay;
  try {
    replay = parseReplay(body.replay);
  } catch (error) {
    const message = error instanceof ReplayError ? error.message : "Invalid replay";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const id = randomUUID();
  const dataKey = `replays/${id}.json`;
  await putObject(dataKey, new TextEncoder().encode(body.replay), "application/json");

  // Queue unlock-only verification when asked and the replay is attributed to a
  // player (so the worker knows who to grant achievements to).
  const verifyStatus = body.verify === true && playerId ? "pending" : "none";

  const db = serviceClient();
  const { error } = await db.from("replays").insert({
    id,
    cart_id: body.cartId,
    player_id: playerId,
    model_id: replay.modelId,
    cart_hash: replay.cartHash,
    seed: replay.seed,
    frame_count: replay.frameCount,
    data_r2_key: dataKey,
    verify_status: verifyStatus,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ id, url: publicUrl(dataKey) }, { status: 201 });
}
