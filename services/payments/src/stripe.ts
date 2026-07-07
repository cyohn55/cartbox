/**
 * Stripe Connect integration for the cartridge marketplace.
 *
 * Money flows as a destination charge: the buyer pays the platform, Stripe
 * transfers the creator's net to their connected account, and the platform
 * retains `application_fee_amount` (the take-rate from ./pricing). This keeps
 * the platform as merchant of record while paying creators automatically.
 */

import Stripe from "stripe";

import { computePlatformFee } from "./pricing.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

let cachedStripe: Stripe | undefined;

export function stripe(): Stripe {
  if (!cachedStripe) {
    cachedStripe = new Stripe(required("STRIPE_SECRET_KEY"), { apiVersion: "2024-06-20" });
  }
  return cachedStripe;
}

/**
 * Creates (or continues) Stripe Connect onboarding for a creator and returns
 * the hosted onboarding URL to redirect them to.
 *
 * @param existingAccountId The creator's Stripe account id, if already created.
 * @param returnUrl Where Stripe sends the creator when onboarding completes.
 */
export async function createOnboardingLink(
  existingAccountId: string | null,
  returnUrl: string,
): Promise<{ accountId: string; url: string }> {
  const api = stripe();
  const accountId =
    existingAccountId ?? (await api.accounts.create({ type: "express" })).id;

  const link = await api.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: returnUrl,
    return_url: returnUrl,
  });
  return { accountId, url: link.url };
}

/** Parameters needed to sell one cartridge. */
export interface CheckoutParams {
  cartId: string;
  cartTitle: string;
  priceCents: number;
  buyerId: string;
  /** The creator's connected Stripe account (destination of the payout). */
  creatorAccountId: string;
  successUrl: string;
  cancelUrl: string;
}

/**
 * Creates a Checkout Session for a single cartridge purchase, wiring the
 * destination charge and platform fee. Returns the URL to redirect the buyer to.
 */
export async function createCartCheckout(params: CheckoutParams): Promise<string> {
  const platformFee = computePlatformFee(params.priceCents);

  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: params.priceCents,
          product_data: { name: params.cartTitle },
        },
      },
    ],
    payment_intent_data: {
      application_fee_amount: platformFee,
      transfer_data: { destination: params.creatorAccountId },
    },
    // Echoed back on the webhook so we can grant the right entitlement.
    metadata: { cartId: params.cartId, buyerId: params.buyerId },
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }
  return session.url;
}

/** Verifies and parses a Stripe webhook event from the raw request body. */
export function parseWebhookEvent(rawBody: string, signature: string): Stripe.Event {
  return stripe().webhooks.constructEvent(rawBody, signature, required("STRIPE_WEBHOOK_SECRET"));
}
