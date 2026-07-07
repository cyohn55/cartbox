/**
 * Marketplace pricing math. Pure and side-effect-free so the fee split is
 * unit-testable and identical on every call site (checkout, dashboards, receipts).
 *
 * All amounts are integer cents. The platform fee is expressed in basis points
 * (1 bp = 0.01%), so 1200 bps = 12%.
 */
/** Default platform take-rate: 12%, comfortably below the 30% app-store norm. */
declare const DEFAULT_PLATFORM_FEE_BPS = 1200;
/**
 * The platform's cut of a sale, in cents (rounded to the nearest cent).
 *
 * @param amountCents Gross sale amount in cents.
 * @param feeBps Platform take-rate in basis points.
 */
declare function computePlatformFee(amountCents: number, feeBps?: number): number;
/**
 * The creator's net payout in cents: the sale amount minus the platform fee.
 * Guaranteed to satisfy `fee + net === amountCents` (no lost or invented cents).
 */
declare function computeCreatorNet(amountCents: number, feeBps?: number): number;

export { DEFAULT_PLATFORM_FEE_BPS, computeCreatorNet, computePlatformFee };
