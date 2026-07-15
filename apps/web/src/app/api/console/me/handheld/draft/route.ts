/**
 * /api/console/me/handheld/draft — the signed-in player's handheld pixel-editor
 * working copy, so a drawing resumes across devices.
 *
 * GET returns the stored draft text (or null); PUT stores it, or clears it when
 * the body's `draft` is null. The value is opaque here — base64 of a gzipped,
 * serialised paint document — and is only ever validated on the client when the
 * editor re-opens it, so the server just persists a bounded blob of text.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";

/** Upper bound on the stored draft, so one row can't grow unbounded. */
const MAX_DRAFT_CHARS = 4_000_000;

export async function GET(request: Request): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const db = serviceClient();
  const { data, error } = await db.from("profiles").select("handheld_draft").eq("id", userId).maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ draft: data?.handheld_draft ?? null });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { draft?: unknown } | null;
  const draft = typeof body?.draft === "string" ? body.draft : null;
  if (draft && draft.length > MAX_DRAFT_CHARS) {
    return NextResponse.json({ error: "Draft is too large to store." }, { status: 413 });
  }

  const db = serviceClient();
  const { error } = await db.from("profiles").update({ handheld_draft: draft }).eq("id", userId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
