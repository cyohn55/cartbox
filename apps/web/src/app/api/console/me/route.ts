/**
 * /api/console/me — everything the handheld's Library and Profile screens
 * need for the signed-in player, in one round trip (it's a phone):
 *
 *  - profile: handle, display name, avatar
 *  - library: carts the player owns (published by them) or purchased
 *  - clips: the profile's featured clips — the player's explicit picks, or
 *    their three most recent replays when they haven't picked any
 *  - recentClips: candidates for the featured-clip picker
 *  - unlocks: achievements earned through verified runs
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { publicUrl } from "@/lib/storage";
import { getSessionUserId } from "@/lib/auth";
import { ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
import { resolveFeaturedClips } from "@/lib/consoleProfile";

/** How many recent replays the featured-clip picker offers. */
const CLIP_CANDIDATE_COUNT = 12;

interface CartRow {
  id: string;
  title: string;
  price_cents: number;
  thumb_key: string | null;
  console_model: string;
  r2_key: string;
}

function engineUrlForModel(model: string): string {
  return ENGINE_URL_BY_MODEL[model as keyof typeof ENGINE_URL_BY_MODEL] ?? ENGINE_URL_BY_MODEL.classic;
}

/** Shapes a cart row for the console: playable URL included (owner/purchaser). */
function libraryCart(cart: CartRow) {
  return {
    id: cart.id,
    title: cart.title,
    priceCents: cart.price_cents,
    modelId: cart.console_model,
    thumbUrl: cart.thumb_key ? publicUrl(cart.thumb_key) : null,
    cartUrl: publicUrl(cart.r2_key),
    engineUrl: engineUrlForModel(cart.console_model),
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const db = serviceClient();
  const cartColumns = "id, title, price_cents, thumb_key, console_model, r2_key";

  const replayColumns =
    "id, model_id, frame_count, data_r2_key, created_at, carts(id, title, r2_key, console_model)";

  const [profileResult, ownedResult, purchasedResult, clipsResult, unlocksResult] = await Promise.all([
    db
      .from("profiles")
      .select("handle, display_name, avatar_json, featured_clips")
      .eq("id", userId)
      .maybeSingle(),
    db.from("carts").select(cartColumns).eq("owner_id", userId).order("created_at", { ascending: false }),
    db.from("purchases").select(`carts(${cartColumns})`).eq("buyer_id", userId),
    db
      .from("replays")
      .select(replayColumns)
      .eq("player_id", userId)
      .order("created_at", { ascending: false })
      .limit(CLIP_CANDIDATE_COUNT),
    db
      .from("unlocks")
      .select("unlocked_at, achievements(title, description, points)")
      .eq("profile_id", userId)
      .order("unlocked_at", { ascending: false }),
  ]);

  // Featured picks older than the recent window still need their rows.
  const featuredIds = (profileResult.data?.featured_clips ?? []) as string[];
  const recentRows = clipsResult.data ?? [];
  const missingFeaturedIds = featuredIds.filter(
    (id) => !recentRows.some((row) => (row as { id: string }).id === id),
  );
  const extraFeatured =
    missingFeaturedIds.length > 0
      ? ((
          await db
            .from("replays")
            .select(replayColumns)
            .eq("player_id", userId)
            .in("id", missingFeaturedIds)
        ).data ?? [])
      : [];

  const owned = (ownedResult.data ?? []) as CartRow[];
  const purchased = ((purchasedResult.data ?? []) as unknown as Array<{ carts: CartRow | null }>)
    .map((row) => row.carts)
    .filter((cart): cart is CartRow => cart !== null);

  // A creator who bought their own cart shouldn't see it twice.
  const libraryById = new Map<string, ReturnType<typeof libraryCart>>();
  for (const cart of [...owned, ...purchased]) {
    libraryById.set(cart.id, libraryCart(cart));
  }

  const recentClips = ([...recentRows, ...extraFeatured] as unknown as Array<{
    id: string;
    model_id: string;
    frame_count: number;
    data_r2_key: string;
    created_at: string;
    carts: { id: string; title: string; r2_key: string; console_model: string } | null;
  }>)
    .filter((replay) => replay.carts !== null)
    .map((replay) => ({
      replayId: replay.id,
      replayUrl: publicUrl(replay.data_r2_key),
      frameCount: replay.frame_count,
      createdAt: replay.created_at,
      cartTitle: replay.carts!.title,
      cartUrl: publicUrl(replay.carts!.r2_key),
      engineUrl: engineUrlForModel(replay.carts!.console_model),
      modelId: replay.model_id,
    }));

  const clips = resolveFeaturedClips(featuredIds, recentClips);

  const unlocks = ((unlocksResult.data ?? []) as unknown as Array<{
    unlocked_at: string;
    achievements: { title: string; description: string; points: number } | null;
  }>)
    .filter((row) => row.achievements !== null)
    .map((row) => ({
      title: row.achievements!.title,
      description: row.achievements!.description,
      points: row.achievements!.points,
      unlockedAt: row.unlocked_at,
    }));

  return NextResponse.json({
    profile: {
      handle: profileResult.data?.handle ?? null,
      displayName: profileResult.data?.display_name ?? null,
      avatar: profileResult.data?.avatar_json ?? null,
    },
    library: [...libraryById.values()],
    clips,
    recentClips,
    featuredClipIds: featuredIds,
    unlocks,
  });
}
