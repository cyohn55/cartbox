/**
 * /api/checkout — start a purchase for one paid cartridge.
 *
 * Resolves the cart and its creator's Connect account, then creates a Stripe
 * Checkout Session (destination charge + platform fee) and returns its URL for
 * the client to redirect to.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/auth";
import { createCartCheckout } from "@cartbox/payments";

export async function POST(request: Request): Promise<NextResponse> {
  const buyerId = await getSessionUserId(request);
  if (!buyerId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { cartId } = (await request.json()) as { cartId?: string };
  if (!cartId) {
    return NextResponse.json({ error: "cartId is required" }, { status: 400 });
  }

  const db = serviceClient();
  const { data: cart } = await db
    .from("carts")
    .select("id, title, price_cents, owner_id, profiles(stripe_account_id)")
    .eq("id", cartId)
    .eq("published", true)
    .single();

  if (!cart) {
    return NextResponse.json({ error: "Cartridge not found" }, { status: 404 });
  }
  if (cart.price_cents === 0) {
    return NextResponse.json({ error: "Cartridge is free" }, { status: 400 });
  }

  // Supabase types an embedded to-one relation as an array; normalize it.
  const profile = cart.profiles as unknown as
    | { stripe_account_id: string | null }
    | Array<{ stripe_account_id: string | null }>
    | null;
  const creatorAccountId = Array.isArray(profile)
    ? profile[0]?.stripe_account_id
    : profile?.stripe_account_id;
  if (!creatorAccountId) {
    return NextResponse.json({ error: "Creator is not set up for payouts" }, { status: 409 });
  }

  const origin = new URL(request.url).origin;
  const url = await createCartCheckout({
    cartId: cart.id,
    cartTitle: cart.title,
    priceCents: cart.price_cents,
    buyerId,
    creatorAccountId,
    successUrl: `${origin}/play/${cart.id}?purchased=1`,
    cancelUrl: `${origin}/play/${cart.id}`,
  });

  return NextResponse.json({ url });
}
