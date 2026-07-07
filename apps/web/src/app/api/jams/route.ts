/**
 * /api/jams — list jams (GET) and create a jam (POST, authenticated).
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { slugify } from "@/lib/slug";
import { jamStatus } from "@/lib/jam";

export async function GET(): Promise<NextResponse> {
  const db = serviceClient();
  const { data, error } = await db
    .from("jams")
    .select("id, slug, title, theme, starts_at, ends_at")
    .order("starts_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const jams = data.map((jam) => ({
    ...jam,
    status: jamStatus(new Date(jam.starts_at), new Date(jam.ends_at)),
  }));
  return NextResponse.json({ jams });
}

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = (await request.json()) as {
    title?: string;
    theme?: string;
    startsAt?: string;
    endsAt?: string;
  };

  const title = body.title?.trim();
  if (!title || !body.startsAt || !body.endsAt) {
    return NextResponse.json({ error: "title, startsAt and endsAt are required" }, { status: 400 });
  }

  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    return NextResponse.json({ error: "Invalid start/end window" }, { status: 400 });
  }

  const db = serviceClient();
  const { data, error } = await db
    .from("jams")
    .insert({
      slug: slugify(title),
      title,
      theme: body.theme ?? null,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
    })
    .select("id, slug")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ jam: data }, { status: 201 });
}
