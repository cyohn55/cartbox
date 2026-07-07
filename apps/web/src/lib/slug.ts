/**
 * URL slug generation for cartridges and jams. Pure and dependency-free so it
 * can run on the server, in the client, and under unit tests.
 */

/** Maximum slug length; keeps URLs and the unique index tidy. */
const MAX_SLUG_LENGTH = 64;

/** Fallback when the input has no slug-safe characters (e.g. all emoji). */
const EMPTY_SLUG_FALLBACK = "untitled";

/**
 * Converts an arbitrary title into a lowercase, hyphen-separated URL slug.
 *
 * Diacritics are folded to ASCII, runs of non-alphanumerics collapse to a
 * single hyphen, and leading/trailing hyphens are trimmed.
 *
 * @param title Human-entered cartridge or jam title.
 * @returns A slug of 1..{@link MAX_SLUG_LENGTH} characters, never empty.
 */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD") // split accented letters into base + combining mark
    .replace(/[̀-ͯ]/g, "") // drop the combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumeric runs -> single hyphen
    .replace(/^-+|-+$/g, "") // trim edge hyphens
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, ""); // re-trim if the slice landed on a hyphen

  return slug.length > 0 ? slug : EMPTY_SLUG_FALLBACK;
}
