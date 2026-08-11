/**
 * The HTTP-shaped seam of the asset library: map request query parameters onto a
 * {@link LibraryQuery} and produce the JSON body the browser consumes. Kept out
 * of the route file itself so the request→response transform is a pure function
 * exercised directly in tests, with the route reduced to loading the manifest
 * and handing it here.
 *
 * The wire query is intentionally flat and repeatable — `?kind=mesh&kind=sprite`
 * rather than a JSON blob — so it composes with plain anchor links and the
 * browser's history without a client to serialise it.
 */

import {
  ASSET_KINDS,
  type LibraryAsset,
  type LibraryAssetKind,
  type LibraryManifest,
} from "./libraryManifest";
import { categoriesOf, paginate, searchLibrary, type LibraryQuery } from "./librarySearch";

/** Default and maximum page sizes; the cap bounds one response's payload. */
export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 100;

/** Keep only the query values that name a real medium. */
function readKinds(params: URLSearchParams): LibraryAssetKind[] {
  return params
    .getAll("kind")
    .filter((value): value is LibraryAssetKind => (ASSET_KINDS as readonly string[]).includes(value));
}

/** Parse a bounded positive integer from a param, falling back on absence/garbage. */
function readBoundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** The parsed shape a request asked for: what to match and which page to return. */
export interface LibraryRequest {
  readonly query: LibraryQuery;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * Turn request parameters into a {@link LibraryRequest}. Unknown mediums are
 * dropped rather than erroring, an out-of-range page size is clamped, and an
 * absent page defaults to the first — a malformed URL yields a sane listing, not
 * a 400, because these params come straight from user-editable links.
 */
export function parseLibraryRequest(params: URLSearchParams): LibraryRequest {
  const text = params.get("q")?.trim() || undefined;
  const kinds = readKinds(params);
  const categories = params.getAll("category").filter((value) => value.trim() !== "");
  const tags = params.getAll("tag").filter((value) => value.trim() !== "");

  return {
    query: {
      ...(text ? { text } : {}),
      ...(kinds.length > 0 ? { kinds } : {}),
      ...(categories.length > 0 ? { categories } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    },
    page: readBoundedInt(params.get("page"), 0, 0, Number.MAX_SAFE_INTEGER),
    pageSize: readBoundedInt(params.get("pageSize"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
  };
}

/** The JSON body returned for a library listing request. */
export interface LibraryResponse {
  readonly items: readonly LibraryAsset[];
  readonly page: number;
  readonly pageCount: number;
  readonly totalItems: number;
  /** Every category in the *unfiltered* catalogue, so filter chips stay stable. */
  readonly categories: readonly string[];
}

/**
 * Apply a parsed request to a manifest and build the response body.
 *
 * Categories are scoped by the request's medium filter but *not* by its text or
 * category selection: in a medium-scoped browser (the Mesh tab shows only
 * meshes) the chips must list exactly the categories that medium actually has —
 * offering "tilesets" to a mesh browser strands the user on an empty result —
 * while staying stable as they type or pick a category, so a chip never vanishes
 * out from under the click that would select it.
 */
export function buildLibraryResponse(
  manifest: LibraryManifest,
  request: LibraryRequest,
): LibraryResponse {
  const matched = searchLibrary(manifest.assets, request.query);
  const page = paginate(matched, request.page, request.pageSize);
  const inMedium =
    request.query.kinds && request.query.kinds.length > 0
      ? searchLibrary(manifest.assets, { kinds: request.query.kinds })
      : manifest.assets;
  return {
    items: page.items,
    page: page.page,
    pageCount: page.pageCount,
    totalItems: page.totalItems,
    categories: categoriesOf(inMedium),
  };
}
