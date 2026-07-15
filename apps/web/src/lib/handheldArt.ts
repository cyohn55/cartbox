/**
 * The custom-handheld-art value type and its validation gate.
 *
 * Kept separate from the rest of the handheld logic (`handheld.ts`) so this
 * untrusted-input gate has a single responsibility and no dependency on the
 * editor package — which makes it directly unit-testable and keeps the security
 * boundary easy to audit. `normalizeHandheld` composes it.
 */

/** Largest custom-art dimension (px) accepted on either axis. */
const MAX_ART_DIMENSION = 4096;
/**
 * Cap on an inline `data:` art URL's length. The guest/static path keeps the
 * flattened PNG in localStorage as a data URL; this bounds it well under the
 * ~5 MB localStorage budget while still admitting a full handheld render.
 */
const MAX_ART_DATA_URL_CHARS = 2_000_000;
/** Cap on a remote (R2) art URL's length — a plain guard against junk. */
const MAX_ART_REMOTE_URL_CHARS = 2048;

/** Flattened custom handheld art: where the PNG lives and its pixel size. */
export interface HandheldArt {
  /** An https URL (R2) or a `data:image/png;base64,` URL (guest/static). */
  url: string;
  /** Pixel dimensions of the flattened art. */
  w: number;
  h: number;
}

/**
 * Validate an untrusted art payload. Accepts only a bounded `data:image/png`
 * URL or a bounded `https:` URL with sane dimensions; anything else yields
 * undefined (the skin simply has no custom art). Rendering an art URL is an
 * `<img src>`, so the trust surface is limited to the player's own device — the
 * caps and scheme checks keep a malformed payload from persisting.
 */
export function normalizeArt(input: unknown): HandheldArt | undefined {
  if (!input || typeof input !== "object") return undefined;
  const source = input as { url?: unknown; w?: unknown; h?: unknown };
  if (typeof source.url !== "string") return undefined;

  const width = Number(source.w);
  const height = Number(source.h);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width < 1 || height < 1 || width > MAX_ART_DIMENSION || height > MAX_ART_DIMENSION) return undefined;

  const url = source.url;
  const isDataPng = url.startsWith("data:image/png;base64,") && url.length <= MAX_ART_DATA_URL_CHARS;
  const isHttps = url.startsWith("https://") && url.length <= MAX_ART_REMOTE_URL_CHARS;
  if (!isDataPng && !isHttps) return undefined;

  return { url, w: Math.round(width), h: Math.round(height) };
}
