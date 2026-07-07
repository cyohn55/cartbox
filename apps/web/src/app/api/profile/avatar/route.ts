/**
 * /api/profile/avatar — save the signed-in user's avatar.
 *
 * The payload is normalized server-side, so a malformed or out-of-range spec
 * can never be persisted.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { normalizeAvatar } from "@/lib/avatar";

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = (await request.json()) as { avatar?: unknown };
  const avatar = normalizeAvatar(body.avatar);

  const db = serviceClient();
  const { error } = await db.from("profiles").update({ avatar_json: avatar }).eq("id", userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ avatar });
}
