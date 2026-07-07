/**
 * First-save cart creation. Every cart minted by /edit/new starts life with no
 * database row — the editor only has the freshly generated id — so the first
 * save must create the row, not just overwrite bytes. The defaulting and id
 * validation live here, pure and database-free, so they are unit-testable.
 *
 * New carts are published immediately: everything a user makes should appear
 * in Browse and stay reachable, rather than existing only as an editor URL.
 */

import type { ConsoleModelId } from "@cartbox/editor";

import { slugify } from "./slug";
import { resolveModelId } from "./consoleModel";

export const DEFAULT_CART_TITLE = "Untitled cartridge";

/** Cart ids are minted with crypto.randomUUID(); anything else is rejected early. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidCartId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export interface NewCartRow {
  id: string;
  owner_id: string;
  title: string;
  slug: string;
  r2_key: string;
  console_model: ConsoleModelId;
  published: boolean;
}

export interface NewProfileRow {
  id: string;
  handle: string;
  display_name: string;
}

/**
 * Build a minimal profile row for a signed-up user who has never had one.
 * Signup only creates the auth.users record; carts.owner_id references
 * profiles, so the first save must materialise the profile or the cart
 * insert fails its foreign key. The handle is derived from the user id
 * (handles are globally unique; users can rename later on /profile/edit).
 */
export function buildDefaultProfileRow(userId: string): NewProfileRow {
  const handleSuffix = userId.replace(/-/g, "").slice(0, 12);
  return {
    id: userId,
    handle: `maker-${handleSuffix}`,
    display_name: "New maker",
  };
}

/**
 * Build the insert payload for a cart's first save. The slug carries a short
 * id suffix because (owner_id, slug) is unique in the schema and most first
 * saves share the default title.
 */
export function buildNewCartRow(params: {
  cartId: string;
  ownerId: string;
  title?: string | null;
  model?: string | null;
}): NewCartRow {
  const title = params.title?.trim() || DEFAULT_CART_TITLE;
  return {
    id: params.cartId,
    owner_id: params.ownerId,
    title,
    slug: `${slugify(title)}-${params.cartId.slice(0, 8)}`,
    r2_key: `carts/${params.cartId}.tic`,
    console_model: resolveModelId(params.model),
    published: true,
  };
}
