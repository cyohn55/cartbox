/**
 * Web-app cart-starter helper: validate an untrusted starter id (a /edit/new URL
 * param) down to a known value. Kept in the web app — not imported from
 * @cartbox/editor — so server components stay free of the editor package's
 * client/DOM code, mirroring lib/consoleModel. The editor package owns the seed
 * functions; this only guards the string that selects one.
 */

/** Starter ids a fresh cart can open on. Must stay in sync with CART_STARTERS. */
const SELECTABLE_STARTER_IDS = ["demo", "parallax", "platformer", "ps1"] as const;

export type StarterId = (typeof SELECTABLE_STARTER_IDS)[number];

/** The starter used when the URL carries none; every fresh engine already has it. */
export const DEFAULT_STARTER_ID: StarterId = "demo";

export function resolveStarterId(value: string | null | undefined): StarterId {
  return SELECTABLE_STARTER_IDS.includes(value as StarterId)
    ? (value as StarterId)
    : DEFAULT_STARTER_ID;
}

/**
 * The starter a fresh cart of this model opens on when the URL names none.
 *
 * `DEFAULT_STARTER_ID` is the ring-runner demo, which is *Classic's* starter: a
 * 2D sprite you move with the arrows. Handing that to a PS1 cart produced the
 * bug this exists to fix — "Create a PS1 cartridge, textured 3D" opened on a
 * spinning 2D ring, because a blank cart has no geometry and the only starter
 * with any is the PS1 one.
 *
 * So the default is per-model: every model opens on a starter that shows what
 * that model does. A creator who wants an empty PS1 cart can still ask for one
 * with `?starter=demo`.
 */
export function defaultStarterForModel(modelId: string): StarterId {
  return modelId === "ps1" ? "ps1" : DEFAULT_STARTER_ID;
}
