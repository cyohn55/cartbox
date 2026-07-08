/**
 * /api/console/me/avatar — save the signed-in player's voxel avatar (PUT).
 * The spec is normalized server-side (every part/palette index clamped into
 * range), so a malformed payload can never persist.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { normalizeVoxelAvatar } from "@/lib/voxelAvatar";

export async function PUT(request: Request): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { avatar?: unknown } | null;
  const avatar = normalizeVoxelAvatar(body?.avatar);

  const db = serviceClient();
  const { error } = await db.from("profiles").update({ voxel_avatar: avatar }).eq("id", userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ avatar });
}
