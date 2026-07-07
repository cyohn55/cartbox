// src/pricing.ts
var DEFAULT_PLATFORM_FEE_BPS = 1200;
var BPS_DENOMINATOR = 1e4;
function assertValidAmount(amountCents) {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new RangeError(`amountCents must be a non-negative integer, got ${amountCents}`);
  }
}
function assertValidFee(feeBps) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > BPS_DENOMINATOR) {
    throw new RangeError(`feeBps must be an integer in [0, ${BPS_DENOMINATOR}], got ${feeBps}`);
  }
}
function computePlatformFee(amountCents, feeBps = DEFAULT_PLATFORM_FEE_BPS) {
  assertValidAmount(amountCents);
  assertValidFee(feeBps);
  return Math.round(amountCents * feeBps / BPS_DENOMINATOR);
}
function computeCreatorNet(amountCents, feeBps = DEFAULT_PLATFORM_FEE_BPS) {
  return amountCents - computePlatformFee(amountCents, feeBps);
}

export {
  DEFAULT_PLATFORM_FEE_BPS,
  computePlatformFee,
  computeCreatorNet
};
