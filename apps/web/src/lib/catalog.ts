/**
 * The unified Browse catalog.
 *
 * Browse shows two kinds of playable thing in one grid: user-authored Cartbox
 * carts and curated catalog titles (open-source games, publisher freeware, and
 * open-source engines whose data the player supplies). They live in separate
 * tables with different shapes and different rules, so this module normalises
 * both into one `CatalogEntry` view model that the grid renders uniformly.
 *
 * Pure: rows in, entries out. Thumbnail URL resolution is injected because it
 * differs between the server build (R2 CDN) and the static demo build (baked
 * assets under the site base path) — keeping it out of here lets the whole
 * module be tested without storage credentials or a Next.js runtime.
 */

import { isRuntimeId, type AssetSource, type ContentTier, type RuntimeId } from "./titleRuntime";

export type CatalogKind = "cart" | "title";

export interface CatalogEntry {
  kind: CatalogKind;
  id: string;
  name: string;
  description: string;
  runtime: RuntimeId;
  priceCents: number;
  plays: number;
  thumbUrl: string | null;
  href: string;
  createdAt: Date;
  /** Titles only — carts have no content tier or asset-supply requirement. */
  tier?: ContentTier;
  assetSource?: AssetSource;
}

/** A `carts` row, narrowed to the columns Browse reads. */
export interface CartRow {
  id: string;
  title: string;
  description?: string | null;
  console_model: string;
  price_cents: number;
  plays: number;
  thumb_key?: string | null;
  created_at: string;
}

/** A `titles` row, narrowed to the columns Browse reads. */
export interface TitleRow {
  id: string;
  name: string;
  description: string;
  runtime: string;
  asset_source: string;
  tier: string;
  price_cents: number;
  plays: number;
  thumb_key?: string | null;
  created_at: string;
}

/** Resolves a stored object key to a displayable URL, or null when absent. */
export type ThumbResolver = (key: string | null | undefined) => string | null;

/**
 * Maps a cart's console model to its runtime id. Carts predate the runtime
 * registry, so this adapter is what lets them share a grid with titles rather
 * than requiring a migration of the `carts` table.
 */
export function runtimeForConsoleModel(consoleModel: string): RuntimeId {
  return consoleModel === "pro" ? "cartbox-pro" : "cartbox-classic";
}

export function cartToEntry(cart: CartRow, resolveThumb: ThumbResolver): CatalogEntry {
  return {
    kind: "cart",
    id: cart.id,
    name: cart.title,
    description: cart.description ?? "",
    runtime: runtimeForConsoleModel(cart.console_model),
    priceCents: cart.price_cents,
    plays: cart.plays,
    thumbUrl: resolveThumb(cart.thumb_key),
    href: `/play/${cart.id}`,
    createdAt: new Date(cart.created_at),
  };
}

export function titleToEntry(title: TitleRow, resolveThumb: ThumbResolver): CatalogEntry {
  return {
    kind: "title",
    id: title.id,
    name: title.name,
    description: title.description,
    runtime: title.runtime as RuntimeId,
    priceCents: title.price_cents,
    plays: title.plays,
    thumbUrl: resolveThumb(title.thumb_key),
    href: `/play/${title.id}`,
    createdAt: new Date(title.created_at),
    tier: title.tier as ContentTier,
    assetSource: title.asset_source as AssetSource,
  };
}

/**
 * Merges both sources into one newest-first grid.
 *
 * Interleaving by recency rather than grouping by kind is the deliberate choice:
 * the catalog reads as one library, so a newly published cart is not buried
 * beneath the curated set (or vice versa).
 */
export function mergeCatalog(entries: readonly CatalogEntry[][]): CatalogEntry[] {
  return entries
    .flat()
    .slice()
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
}

/**
 * Narrows the grid to a single runtime.
 *
 * An unset or unrecognised filter yields the full catalog — a stale or hand-typed
 * query string should show everything rather than an empty page. A *recognised*
 * runtime with no matches correctly yields nothing, so the grid's empty state
 * reports an empty category instead of hiding it behind the full list.
 */
export function filterByRuntime(
  entries: readonly CatalogEntry[],
  runtime: string | null | undefined,
): CatalogEntry[] {
  if (!runtime || !isRuntimeId(runtime)) {
    return entries.slice();
  }
  return entries.filter((entry) => entry.runtime === runtime);
}

/** Formats a price for display. Free is the common case and reads better named. */
export function formatPrice(cents: number): string {
  return cents === 0 ? "Free" : `$${(cents / 100).toFixed(2)}`;
}
