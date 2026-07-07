/**
 * @cartbox/payments — public surface for Stripe Connect marketplace payments.
 */

export {
  DEFAULT_PLATFORM_FEE_BPS,
  computeCreatorNet,
  computePlatformFee,
} from "./pricing.js";

export {
  createCartCheckout,
  createOnboardingLink,
  parseWebhookEvent,
  stripe,
  type CheckoutParams,
} from "./stripe.js";
