/**
 * /api/titles — lists published catalog titles for the handheld console.
 *
 * The console's Browse tab shows carts and catalog titles in one grid, so it
 * needs the same shape from both. This mirrors /api/carts: published rows only,
 * newest first, with the fields the grid actually renders.
 *
 * Only bundled, runnable titles are returned. The catalog deliberately carries
 * games ahead of their ports (and Tier C titles that need the player's own game
 * data), and a cartridge that cannot boot is worse on a console than an absent
 * one — the web /browse page lists those with an explanation instead.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { publicUrl } from "@/lib/storage";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 180;

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const requested = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.min(Number.isFinite(requested) ? requested : DEFAULT_LIMIT, MAX_LIMIT);

  const db = serviceClient();
  const { data, error } = await db
    .from("titles")
    .select("id, name, price_cents, plays, thumb_key, bundle_key, asset_source, runtime")
    .eq("published", true)
    .eq("asset_source", "bundled")
    .not("bundle_key", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const titles = (data ?? []).map((title) => ({
    id: title.id,
    name: title.name,
    price_cents: title.price_cents,
    plays: title.plays,
    thumbUrl: title.thumb_key ? publicUrl(title.thumb_key) : null,
    bundleName: title.bundle_key,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  }));

  return NextResponse.json({ titles });
}
