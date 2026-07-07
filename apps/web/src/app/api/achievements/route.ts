/**
 * /api/achievements — register achievements for a cart (POST, owner-only) and
 * list a cart's achievements (GET).
 *
 * The `hash` is computed with the same FNV-1a as the cartbox SDK, so a mailbox
 * unlock event can be mapped back to the achievement during verification.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { hashEventId } from "@cartbox/player";

export async function GET(request: Request): Promise<NextResponse> {
  const cartId = new URL(request.url).searchParams.get("cartId");
  if (!cartId) {
    return NextResponse.json({ error: "cartId is required" }, { status: 400 });
  }

  const db = serviceClient();
  const { data, error } = await db
    .from("achievements")
    .select("id, key, title, description, points, secret")
    .eq("cart_id", cartId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ achievements: data });
}

export async function POST(request: Request): Promise<NextResponse> {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const body = (await request.json()) as {
    cartId?: string;
    key?: string;
    title?: string;
    description?: string;
    points?: number;
    secret?: boolean;
  };
  const key = body.key?.trim();
  const title = body.title?.trim();
  if (!body.cartId || !key || !title) {
    return NextResponse.json({ error: "cartId, key and title are required" }, { status: 400 });
  }

  const db = serviceClient();

  // Only the cart's owner may register its achievements.
  const { data: cart } = await db.from("carts").select("owner_id").eq("id", body.cartId).single();
  if (!cart) {
    return NextResponse.json({ error: "Cart not found" }, { status: 404 });
  }
  if (cart.owner_id !== userId) {
    return NextResponse.json({ error: "Not the cart owner" }, { status: 403 });
  }

  const { data, error } = await db
    .from("achievements")
    .insert({
      cart_id: body.cartId,
      key,
      hash: hashEventId(key),
      title,
      description: body.description ?? "",
      points: Number.isInteger(body.points) ? body.points : 0,
      secret: body.secret === true,
    })
    .select("id, key")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ achievement: data }, { status: 201 });
}
