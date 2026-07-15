/**
 * /api/console/me/handheld — save the signed-in player's handheld console skin
 * (PUT). The payload is normalized server-side (preset resolved, every region
 * colour validated), so a malformed skin can never persist. Mirrors the voxel
 * avatar route.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { normalizeHandheld } from "@/lib/handheld";

export async function PUT(request: Request): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { handheld?: unknown } | null;
  const handheld = normalizeHandheld(body?.handheld);

  const db = serviceClient();
  const { error } = await db.from("profiles").update({ handheld }).eq("id", userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ handheld });
}
