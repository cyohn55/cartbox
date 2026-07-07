import {
  DEFAULT_PLATFORM_FEE_BPS,
  computeCreatorNet,
  computePlatformFee
} from "./chunk-P4P2TV2U.js";

// src/stripe.ts
import Stripe from "stripe";
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
var cachedStripe;
function stripe() {
  if (!cachedStripe) {
    cachedStripe = new Stripe(required("STRIPE_SECRET_KEY"), { apiVersion: "2024-06-20" });
  }
  return cachedStripe;
}
async function createOnboardingLink(existingAccountId, returnUrl) {
  const api = stripe();
  const accountId = existingAccountId ?? (await api.accounts.create({ type: "express" })).id;
  const link = await api.accountLinks.create({
    account: accountId,
    type: "account_onboarding",
    refresh_url: returnUrl,
    return_url: returnUrl
  });
  return { accountId, url: link.url };
}
async function createCartCheckout(params) {
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
          product_data: { name: params.cartTitle }
        }
      }
    ],
    payment_intent_data: {
      application_fee_amount: platformFee,
      transfer_data: { destination: params.creatorAccountId }
    },
    // Echoed back on the webhook so we can grant the right entitlement.
    metadata: { cartId: params.cartId, buyerId: params.buyerId }
  });
  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }
  return session.url;
}
function parseWebhookEvent(rawBody, signature) {
  return stripe().webhooks.constructEvent(rawBody, signature, required("STRIPE_WEBHOOK_SECRET"));
}
export {
  DEFAULT_PLATFORM_FEE_BPS,
  computeCreatorNet,
  computePlatformFee,
  createCartCheckout,
  createOnboardingLink,
  parseWebhookEvent,
  stripe
};
