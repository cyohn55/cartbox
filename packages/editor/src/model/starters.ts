/**
 * Cart starters — the seed a brand-new cartridge opens on. Each entry pairs a
 * stable id (used in the /edit/new?starter= URL) with the seed function that
 * populates the engine and the copy shown on the create page. This registry is
 * the single source of truth: the create links, the URL validation, and the
 * editor boot all read from it, so adding a starter is a one-line change here.
 */

import type { CartEngine } from "../engine/CartEngine";
import { seedDemoCart } from "./seed";
import { seedParallaxDemoCart } from "./parallaxSeed";

/** Applies starter content to a cart's engine, in place. */
type SeedFunction = (engine: CartEngine) => void;

interface CartStarter {
  /** Stable id used in URLs and persisted references. */
  readonly id: string;
  /** Short label for the create link / picker. */
  readonly label: string;
  /** One-line description of what the starter contains. */
  readonly description: string;
  /** Seeds the engine with this starter's palette, assets, and code. */
  readonly seed: SeedFunction;
}

// Typed as a non-empty tuple so index 0 (the default) is statically known to
// exist under noUncheckedIndexedAccess.
export const CART_STARTERS: readonly [CartStarter, ...CartStarter[]] = [
  {
    id: "demo",
    label: "Classic demo",
    description: "The ring-runner template — a sprite you move with the arrows.",
    seed: seedDemoCart,
  },
  {
    id: "parallax",
    label: "Parallax scene",
    description: "Three scrolling map layers that drift at different speeds.",
    seed: seedParallaxDemoCart,
  },
];

/** The starter used when none is specified; every fresh engine already carries it. */
export const DEFAULT_STARTER_ID = CART_STARTERS[0].id;

/** All valid starter ids, for callers that only need to validate a URL value. */
export const STARTER_IDS: readonly string[] = CART_STARTERS.map((starter) => starter.id);

/** Resolve an untrusted id to a starter, falling back to the default. */
export function resolveStarter(id: string | null | undefined): CartStarter {
  return CART_STARTERS.find((starter) => starter.id === id) ?? CART_STARTERS[0];
}

/** Seed `engine` with the starter named by `id` (default starter if unknown). */
export function applyStarter(engine: CartEngine, id: string | null | undefined): void {
  resolveStarter(id).seed(engine);
}

export { type CartStarter };
