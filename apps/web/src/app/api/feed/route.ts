/**
 * /api/feed — assembles the console homescreen's mixed feed.
 *
 * Gathers every source the feed shows — playable published carts, replay
 * clips, achievement unlocks, and authored posts (news / LFP / tips / trivia /
 * dev posts) — normalizes each into a FeedItem, and interleaves them so no two
 * cards of the same kind sit adjacent. Public read; no auth required.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { publicUrl } from "@/lib/storage";
import { getSessionUserId } from "@/lib/auth";
import { ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
import { validateFeedPostInput } from "@/lib/consoleProfile";
import { interleaveFeed, type FeedItem, type FeedItemKind } from "@/lib/feedMix";

/** Per-source fetch caps keep one feed page light enough for a phone. */
const CART_LIMIT = 10;
const CLIP_LIMIT = 6;
const UNLOCK_LIMIT = 6;
const POST_LIMIT = 24;

interface ProfileRef {
  handle: string | null;
  display_name: string | null;
}

function engineUrlForModel(model: string): string {
  return ENGINE_URL_BY_MODEL[model as keyof typeof ENGINE_URL_BY_MODEL] ?? ENGINE_URL_BY_MODEL.classic;
}

function authorFields(profile: ProfileRef | null | undefined): Pick<FeedItem, "authorHandle" | "authorName"> {
  return {
    authorHandle: profile?.handle ?? null,
    authorName: profile?.display_name ?? profile?.handle ?? null,
  };
}

async function fetchCartItems(db: ReturnType<typeof serviceClient>): Promise<FeedItem[]> {
  const { data } = await db
    .from("carts")
    .select("id, title, description, price_cents, plays, thumb_key, r2_key, console_model, profiles(handle, display_name)")
    .eq("published", true)
    .order("created_at", { ascending: false })
    .limit(CART_LIMIT);

  return (data ?? []).map((cart) => {
    const isFree = cart.price_cents === 0;
    return {
      id: `cart:${cart.id}`,
      kind: "cart" as FeedItemKind,
      title: cart.title,
      body: cart.description ?? "",
      ...authorFields(cart.profiles as unknown as ProfileRef),
      createdAt: "",
      cart: {
        id: cart.id,
        title: cart.title,
        modelId: cart.console_model,
        priceCents: cart.price_cents,
        plays: cart.plays,
        thumbUrl: cart.thumb_key ? publicUrl(cart.thumb_key) : null,
        // Paid carts route through the detail page for the buy flow instead.
        cartUrl: isFree ? publicUrl(cart.r2_key) : null,
        engineUrl: isFree ? engineUrlForModel(cart.console_model) : null,
      },
    };
  });
}

async function fetchClipItems(db: ReturnType<typeof serviceClient>): Promise<FeedItem[]> {
  const { data } = await db
    .from("replays")
    .select(
      "id, model_id, frame_count, data_r2_key, created_at, carts(id, title, r2_key, console_model), profiles(handle, display_name)",
    )
    .order("created_at", { ascending: false })
    .limit(CLIP_LIMIT);

  const items: FeedItem[] = [];
  for (const replay of data ?? []) {
    const cart = replay.carts as unknown as {
      id: string;
      title: string;
      r2_key: string;
      console_model: string;
    } | null;
    if (!cart) {
      continue; // clip's cart was unpublished/deleted; nothing to show
    }
    items.push({
      id: `clip:${replay.id}`,
      kind: "clip",
      title: cart.title,
      body: "",
      ...authorFields(replay.profiles as unknown as ProfileRef),
      createdAt: replay.created_at,
      cart: {
        id: cart.id,
        title: cart.title,
        modelId: replay.model_id,
        priceCents: 0,
        plays: 0,
        thumbUrl: null,
        cartUrl: publicUrl(cart.r2_key),
        engineUrl: engineUrlForModel(cart.console_model),
      },
      clip: {
        replayId: replay.id,
        replayUrl: publicUrl(replay.data_r2_key),
        frameCount: replay.frame_count,
      },
    });
  }
  return items;
}

async function fetchAchievementItems(db: ReturnType<typeof serviceClient>): Promise<FeedItem[]> {
  const { data } = await db
    .from("unlocks")
    .select("unlocked_at, profiles(handle, display_name), achievements(title, description, points, cart_id)")
    .order("unlocked_at", { ascending: false })
    .limit(UNLOCK_LIMIT);

  const items: FeedItem[] = [];
  for (const unlock of data ?? []) {
    const achievement = unlock.achievements as unknown as {
      title: string;
      description: string;
      points: number;
      cart_id: string;
    } | null;
    if (!achievement) {
      continue;
    }
    const author = authorFields(unlock.profiles as unknown as ProfileRef);
    items.push({
      id: `unlock:${author.authorHandle}:${achievement.title}:${unlock.unlocked_at}`,
      kind: "achievement",
      title: achievement.title,
      body: achievement.description,
      ...author,
      createdAt: unlock.unlocked_at,
      link: `/play/${achievement.cart_id}`,
    });
  }
  return items;
}

async function fetchPostItems(db: ReturnType<typeof serviceClient>): Promise<FeedItem[]> {
  const { data } = await db
    .from("feed_posts")
    .select("id, kind, title, body, meta, created_at, cart_id, profiles(handle, display_name)")
    .order("created_at", { ascending: false })
    .limit(POST_LIMIT);

  return (data ?? []).map((post) => {
    const meta = (post.meta ?? {}) as { choices?: string[]; answerIndex?: number; link?: string };
    const hasTrivia = post.kind === "trivia" && Array.isArray(meta.choices);
    return {
      id: `post:${post.id}`,
      kind: post.kind as FeedItemKind,
      title: post.title,
      body: post.body,
      ...authorFields(post.profiles as unknown as ProfileRef),
      createdAt: post.created_at,
      link: post.cart_id ? `/play/${post.cart_id}` : meta.link,
      trivia: hasTrivia ? { choices: meta.choices!, answerIndex: meta.answerIndex ?? 0 } : undefined,
    };
  });
}

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const db = serviceClient();

  const [carts, clips, unlocks, posts] = await Promise.all([
    fetchCartItems(db),
    fetchClipItems(db),
    fetchAchievementItems(db),
    fetchPostItems(db),
  ]);

  // Split authored posts by kind so the interleave alternates card varieties
  // instead of treating "posts" as one clump.
  const postsByKind = new Map<FeedItemKind, FeedItem[]>();
  for (const post of posts) {
    const group = postsByKind.get(post.kind) ?? [];
    group.push(post);
    postsByKind.set(post.kind, group);
  }

  const items = interleaveFeed([carts, clips, unlocks, ...postsByKind.values()]);
  return NextResponse.json({ items });
}

/**
 * POST /api/feed — publish a community post (looking-for-players invite or a
 * devlog) from the console's composer. Signed-in players only. A linked cart
 * must exist and be published; a devlog's cart must additionally be the
 * author's own (you can invite players to anyone's game, but you only write
 * devlogs for yours).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const validation = validateFeedPostInput(raw ?? {});
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const post = validation.value;

  const db = serviceClient();

  if (post.cartId) {
    const { data: cart } = await db
      .from("carts")
      .select("id, owner_id, published")
      .eq("id", post.cartId)
      .maybeSingle();
    if (!cart || !cart.published) {
      return NextResponse.json({ error: "The linked cartridge was not found" }, { status: 404 });
    }
    if (post.kind === "dev_post" && cart.owner_id !== userId) {
      return NextResponse.json(
        { error: "Devlogs can only be written for your own cartridges" },
        { status: 403 },
      );
    }
  }

  const { data: inserted, error } = await db
    .from("feed_posts")
    .insert({
      kind: post.kind,
      author_id: userId,
      cart_id: post.cartId,
      title: post.title,
      body: post.body,
    })
    .select("id")
    .single();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ id: inserted.id }, { status: 201 });
}
