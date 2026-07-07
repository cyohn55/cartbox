/**
 * Marketplace pricing math. Pure and side-effect-free so the fee split is
 * unit-testable and identical on every call site (checkout, dashboards, receipts).
 *
 * All amounts are integer cents. The platform fee is expressed in basis points
 * (1 bp = 0.01%), so 1200 bps = 12%.
 */

/** Default platform take-rate: 12%, comfortably below the 30% app-store norm. */
export const DEFAULT_PLATFORM_FEE_BPS = 1200;

/** One hundred percent, in basis points. */
const BPS_DENOMINATOR = 10_000;

function assertValidAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new RangeError(`amountCents must be a non-negative integer, got ${amountCents}`);
  }
}

function assertValidFee(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > BPS_DENOMINATOR) {
    throw new RangeError(`feeBps must be an integer in [0, ${BPS_DENOMINATOR}], got ${feeBps}`);
  }
}

/**
 * The platform's cut of a sale, in cents (rounded to the nearest cent).
 *
 * @param amountCents Gross sale amount in cents.
 * @param feeBps Platform take-rate in basis points.
 */
export function computePlatformFee(
  amountCents: number,
  feeBps: number = DEFAULT_PLATFORM_FEE_BPS,
): number {
  assertValidAmount(amountCents);
  assertValidFee(feeBps);
  return Math.round((amountCents * feeBps) / BPS_DENOMINATOR);
}

/**
 * The creator's net payout in cents: the sale amount minus the platform fee.
 * Guaranteed to satisfy `fee + net === amountCents` (no lost or invented cents).
 */
export function computeCreatorNet(
  amountCents: number,
  feeBps: number = DEFAULT_PLATFORM_FEE_BPS,
): number {
  return amountCents - computePlatformFee(amountCents, feeBps);
}
