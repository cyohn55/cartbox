/**
 * /api/console/me/featured — save which clips the player showcases on their
 * profile (PUT). At most FEATURED_CLIP_LIMIT replay ids, each of which must be
 * a replay this player recorded; order is preserved for display. An empty
 * array clears the picks, returning the profile to its most-recent fallback.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { FEATURED_CLIP_LIMIT } from "@/lib/consoleProfile";

export async function PUT(request: Request): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { replayIds?: unknown } | null;
  const replayIds = body?.replayIds;
  if (!Array.isArray(replayIds) || replayIds.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "replayIds must be an array of ids" }, { status: 400 });
  }
  const unique = [...new Set(replayIds as string[])];
  if (unique.length > FEATURED_CLIP_LIMIT) {
    return NextResponse.json(
      { error: `Pick at most ${FEATURED_CLIP_LIMIT} clips` },
      { status: 400 },
    );
  }

  const db = serviceClient();

  // Only the player's own replays can headline their profile.
  if (unique.length > 0) {
    const { data: owned, error } = await db
      .from("replays")
      .select("id")
      .eq("player_id", userId)
      .in("id", unique);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const ownedIds = new Set((owned ?? []).map((row) => row.id as string));
    const foreign = unique.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) {
      return NextResponse.json({ error: "You can only feature your own clips" }, { status: 403 });
    }
  }

  const { error: updateError } = await db
    .from("profiles")
    .update({ featured_clips: unique })
    .eq("id", userId);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ featuredClipIds: unique });
}
