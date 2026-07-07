/**
 * /api/webhooks/stripe — grants entitlements after a completed purchase.
 *
 * Stripe calls this after checkout. We verify the signature, then on
 * `checkout.session.completed` record the purchase. The payment intent id is
 * stored as a unique key so redelivered webhooks are idempotent.
 */

import { NextResponse } from "next/server";

import { serviceClient } from "@/lib/supabase";
import { computePlatformFee, parseWebhookEvent } from "@cartbox/payments";

// Stripe requires the raw, unparsed body to verify the signature.
export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const rawBody = await request.text();
  let event;
  try {
    event = parseWebhookEvent(rawBody, signature);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as {
      amount_total: number | null;
      payment_intent: string | null;
      metadata: { cartId?: string; buyerId?: string } | null;
    };
    const cartId = session.metadata?.cartId;
    const buyerId = session.metadata?.buyerId;
    const amount = session.amount_total ?? 0;

    if (cartId && buyerId) {
      const db = serviceClient();
      // Upsert on the unique (buyer_id, cart_id) key makes redelivery a no-op.
      await db.from("purchases").upsert(
        {
          buyer_id: buyerId,
          cart_id: cartId,
          amount_cents: amount,
          platform_fee_cents: computePlatformFee(amount),
          stripe_payment_intent: session.payment_intent,
        },
        { onConflict: "buyer_id,cart_id", ignoreDuplicates: true },
      );
    }
  }

  return NextResponse.json({ received: true });
}
