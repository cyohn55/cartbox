/**
 * /api/auth/handle?handle=<name> — check whether a username is valid and free
 * before signup. Uses the service client to look past RLS (handles are public
 * anyway). Returns `{ available, handle, error? }`.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { normalizeHandle, handleError } from "@/lib/handle";

export async function GET(request: Request): Promise<NextResponse> {
  const raw = new URL(request.url).searchParams.get("handle") ?? "";
  const handle = normalizeHandle(raw);

  const invalid = handleError(handle);
  if (invalid) {
    return NextResponse.json({ available: false, handle, error: invalid });
  }

  const db = serviceClient();
  const { data, error } = await db.from("profiles").select("id").eq("handle", handle).maybeSingle();
  if (error) {
    return NextResponse.json({ available: false, handle, error: "Could not check availability." }, { status: 500 });
  }

  return NextResponse.json({ available: data === null, handle });
}
