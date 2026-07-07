export { DEFAULT_PLATFORM_FEE_BPS, computeCreatorNet, computePlatformFee } from './pricing.js';
import Stripe from 'stripe';

/**
 * Stripe Connect integration for the cartridge marketplace.
 *
 * Money flows as a destination charge: the buyer pays the platform, Stripe
 * transfers the creator's net to their connected account, and the platform
 * retains `application_fee_amount` (the take-rate from ./pricing). This keeps
 * the platform as merchant of record while paying creators automatically.
 */

declare function stripe(): Stripe;
/**
 * Creates (or continues) Stripe Connect onboarding for a creator and returns
 * the hosted onboarding URL to redirect them to.
 *
 * @param existingAccountId The creator's Stripe account id, if already created.
 * @param returnUrl Where Stripe sends the creator when onboarding completes.
 */
declare function createOnboardingLink(existingAccountId: string | null, returnUrl: string): Promise<{
    accountId: string;
    url: string;
}>;
/** Parameters needed to sell one cartridge. */
interface CheckoutParams {
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
declare function createCartCheckout(params: CheckoutParams): Promise<string>;
/** Verifies and parses a Stripe webhook event from the raw request body. */
declare function parseWebhookEvent(rawBody: string, signature: string): Stripe.Event;

export { type CheckoutParams, createCartCheckout, createOnboardingLink, parseWebhookEvent, stripe };
