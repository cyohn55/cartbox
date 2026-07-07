/**
 * Web-app cart-starter helper: validate an untrusted starter id (a /edit/new URL
 * param) down to a known value. Kept in the web app — not imported from
 * @cartbox/editor — so server components stay free of the editor package's
 * client/DOM code, mirroring lib/consoleModel. The editor package owns the seed
 * functions; this only guards the string that selects one.
 */

/** Starter ids a fresh cart can open on. Must stay in sync with CART_STARTERS. */
const SELECTABLE_STARTER_IDS = ["demo", "parallax"] as const;

export type StarterId = (typeof SELECTABLE_STARTER_IDS)[number];

/** The starter used when the URL carries none; every fresh engine already has it. */
export const DEFAULT_STARTER_ID: StarterId = "demo";

export function resolveStarterId(value: string | null | undefined): StarterId {
  return SELECTABLE_STARTER_IDS.includes(value as StarterId)
    ? (value as StarterId)
    : DEFAULT_STARTER_ID;
}
