/**
 * Server-side handling of a cart's marketplace details — its title, description
 * and tags.
 *
 * Unlike the render sidecars (FX, scene, …) these are first-class columns on the
 * cart row and drive how the cart is presented in Browse: the title and slug, the
 * blurb, and the tag facets. The editor's details panel PUTs all three together;
 * this module owns the validation and normalisation — kept pure so it can be
 * tested on its own inputs and outputs — while the route applies the derived slug
 * (which needs the cart id) and writes the row.
 */

/** Longest a cart title may be; keeps titles, slugs and cards tidy. */
export const MAX_TITLE_LENGTH = 80;
/** Longest a description may be. */
export const MAX_DESCRIPTION_LENGTH = 2000;
/** Most tags a cart may carry. */
export const MAX_TAGS = 12;
/** Longest a single tag may be. */
export const MAX_TAG_LENGTH = 30;

/** The normalised, storable form of a cart's details. */
export interface CartMeta {
  title: string;
  description: string;
  tags: string[];
}

/** The outcome of validating a details save: the normalised meta, or a 400 message. */
export type MetaUpdate = { meta: CartMeta } | { error: string };

/**
 * Normalise an arbitrary tags value into a clean, bounded, de-duplicated list.
 *
 * Accepts either an array of strings or a single comma-separated string (what a
 * plain text input produces), lower-cases and trims each entry, drops empties,
 * removes duplicates, and caps both the per-tag length and the tag count so a
 * hostile or careless payload can never bloat the row.
 */
export function normalizeTags(input: unknown): string[] {
  const raw: unknown[] = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [];

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/**
 * Decide what a `PUT /api/carts/:id/meta` body means for the stored details.
 *
 * The title is the one hard requirement — a cart must have a non-empty name, so a
 * blank title is a malformed request rather than a silent default. Description
 * and tags are optional and normalised to safe, bounded values.
 */
export function resolveMetaUpdate(body: unknown): MetaUpdate {
  if (typeof body !== "object" || body === null) {
    return { error: "Details body must be an object." };
  }
  const data = body as Record<string, unknown>;

  const title = typeof data.title === "string" ? data.title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  if (title.length === 0) {
    return { error: "A cartridge needs a title." };
  }

  const description =
    typeof data.description === "string" ? data.description.trim().slice(0, MAX_DESCRIPTION_LENGTH) : "";

  return { meta: { title, description, tags: normalizeTags(data.tags) } };
}
