/**
 * Query logic for the asset library: turn a browsing intent (some text, a medium
 * filter, a category, tag chips) into the matching slice of the catalogue, and
 * page that slice for display.
 *
 * Pure and total: every function takes the assets and a query and returns a new
 * array, holding no state and touching nothing outside its arguments. The editor
 * fetches the manifest once and drives this on each keystroke; keeping it pure is
 * what lets the same code back the UI and the tests without a DOM.
 *
 * See {@link LibraryAsset} for the shape being queried — tags arrive already
 * lowercased from {@link parseLibraryManifest}, so matching here is a plain
 * comparison rather than a re-normalisation on every query.
 */

import type { LibraryAsset, LibraryAssetKind } from "./libraryManifest";

/**
 * A browsing intent. Every field is optional and an omitted field is "no
 * constraint", so an empty query returns the whole catalogue. Multiple fields
 * combine with AND (narrowing); the values *within* `kinds`, `categories`, and
 * `tags` combine with OR (a chip either widens its own axis or is off).
 */
export interface LibraryQuery {
  /** Free text matched against name, tags, category, author, and source. */
  readonly text?: string;
  /** Restrict to these mediums; empty or omitted means all mediums. */
  readonly kinds?: readonly LibraryAssetKind[];
  /** Restrict to these categories (case-insensitive). */
  readonly categories?: readonly string[];
  /** Require every listed tag to be present (AND within tags — narrowing). */
  readonly tags?: readonly string[];
}

/** Split a free-text query into lowercased terms; whitespace is the separator. */
function searchTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/** The lowercased haystack a text query is matched against for one asset. */
function haystackOf(asset: LibraryAsset): string {
  return [
    asset.name,
    asset.category,
    asset.provenance.author,
    asset.provenance.source,
    ...asset.tags,
  ]
    .join(" ")
    .toLowerCase();
}

/** Whether one asset satisfies a text query — every term must appear somewhere. */
function matchesText(asset: LibraryAsset, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = haystackOf(asset);
  return terms.every((term) => haystack.includes(term));
}

/**
 * Filter a catalogue by a {@link LibraryQuery}, preserving input order (the
 * manifest's curation order is the default ranking). Returns a new array and
 * never mutates its input.
 */
export function searchLibrary(
  assets: readonly LibraryAsset[],
  query: LibraryQuery = {},
): LibraryAsset[] {
  const terms = query.text ? searchTerms(query.text) : [];
  const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : null;
  const categories =
    query.categories && query.categories.length > 0
      ? new Set(query.categories.map((category) => category.toLowerCase()))
      : null;
  const requiredTags = (query.tags ?? []).map((tag) => tag.toLowerCase());

  return assets.filter((asset) => {
    if (kinds && !kinds.has(asset.kind)) return false;
    if (categories && !categories.has(asset.category.toLowerCase())) return false;
    if (!requiredTags.every((tag) => asset.tags.includes(tag))) return false;
    return matchesText(asset, terms);
  });
}

/** The distinct categories present, in first-seen order — feeds the filter UI. */
export function categoriesOf(assets: readonly LibraryAsset[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const asset of assets) {
    if (!seen.has(asset.category)) {
      seen.add(asset.category);
      ordered.push(asset.category);
    }
  }
  return ordered;
}

/** One page of results plus enough context for the UI to render pager controls. */
export interface LibraryPage {
  readonly items: LibraryAsset[];
  /** Zero-based index of this page, clamped into range. */
  readonly page: number;
  readonly pageCount: number;
  readonly totalItems: number;
}

/**
 * Slice a result list into a page. `page` is clamped into `[0, pageCount)` so an
 * out-of-range request (e.g. the last page after a filter shrinks the list)
 * yields a valid page rather than an empty one.
 */
export function paginate(
  items: readonly LibraryAsset[],
  page: number,
  pageSize: number,
): LibraryPage {
  if (pageSize < 1) {
    throw new RangeError(`pageSize must be at least 1, got ${pageSize}`);
  }
  const totalItems = items.length;
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const clampedPage = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  const start = clampedPage * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: clampedPage,
    pageCount,
    totalItems,
  };
}
