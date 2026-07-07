/**
 * /api/scores — submit a score for verification (POST) and read a cart's
 * verified leaderboard (GET).
 *
 * A submission references the replay that produced it and starts 'pending'; the
 * verification worker re-runs the replay to confirm the claim. Only verified
 * scores appear on the leaderboard.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";

export async function GET(request: Request): Promise<NextResponse> {
  const cartId = new URL(request.url).searchParams.get("cartId");
  if (!cartId) {
    return NextResponse.json({ error: "cartId is required" }, { status: 400 });
  }

  const db = serviceClient();
  const { data, error } = await db
    .from("scores")
    .select("id, profile_id, claimed_value, created_at")
    .eq("cart_id", cartId)
    .eq("status", "verified")
    .order("claimed_value", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ leaderboard: data });
}

export async function POST(request: Request): Promise<NextResponse> {
  const profileId = await getSessionUserId(request); // optional

  const body = (await request.json()) as {
    cartId?: string;
    replayId?: string;
    value?: number;
  };
  if (!body.cartId || !body.replayId || !Number.isInteger(body.value)) {
    return NextResponse.json(
      { error: "cartId, replayId and an integer value are required" },
      { status: 400 },
    );
  }

  const db = serviceClient();
  const { data, error } = await db
    .from("scores")
    .insert({
      cart_id: body.cartId,
      replay_id: body.replayId,
      profile_id: profileId,
      claimed_value: body.value,
      status: "pending",
    })
    .select("id, status")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ score: data }, { status: 201 });
}
