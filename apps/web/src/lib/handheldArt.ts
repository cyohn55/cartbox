/**
 * The custom-handheld-art value type and its validation gate.
 *
 * Kept separate from the rest of the handheld logic (`handheld.ts`) so this
 * untrusted-input gate has a single responsibility and no dependency on the
 * editor package — which makes it directly unit-testable and keeps the security
 * boundary easy to audit. `normalizeHandheld` composes it.
 */

/** Largest custom-art dimension (px) accepted on either axis (single frame). */
const MAX_ART_DIMENSION = 4096;
/**
 * Cap on an inline `data:` art URL's length. The guest/static path keeps the
 * flattened PNG in localStorage as a data URL; this bounds it under the ~5 MB
 * localStorage budget while admitting a full handheld render, including a small
 * animation's horizontal sprite sheet.
 */
const MAX_ART_DATA_URL_CHARS = 4_000_000;
/** Cap on a remote (R2) art URL's length — a plain guard against junk. */
const MAX_ART_REMOTE_URL_CHARS = 2048;
/** Largest animation length; bounds the sprite-sheet width and storage size. */
const MAX_ART_FRAMES = 8;
/** Per-frame duration bounds (ms) for an animated skin. */
const MIN_FRAME_MS = 20;
const MAX_FRAME_MS = 2000;

/**
 * Flattened custom handheld art. `w`/`h` are a SINGLE frame's dimensions; when
 * `frames > 1` the image at `url` is a horizontal sprite sheet `frames` frames
 * wide (so the sheet is `w * frames` by `h`), played at `durationMs` per frame.
 */
export interface HandheldArt {
  /** An https URL (R2) or a `data:image/png;base64,` URL (guest/static). */
  url: string;
  /** Single-frame pixel dimensions. */
  w: number;
  h: number;
  /** Animation length (>= 1). Absent/1 means a static image. */
  frames?: number;
  /** Per-frame duration in ms (only meaningful when frames > 1). */
  durationMs?: number;
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
  const source = input as { url?: unknown; w?: unknown; h?: unknown; frames?: unknown; durationMs?: unknown };
  if (typeof source.url !== "string") return undefined;

  const width = Number(source.w);
  const height = Number(source.h);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width < 1 || height < 1 || width > MAX_ART_DIMENSION || height > MAX_ART_DIMENSION) return undefined;

  const url = source.url;
  const isDataPng = url.startsWith("data:image/png;base64,") && url.length <= MAX_ART_DATA_URL_CHARS;
  const isHttps = url.startsWith("https://") && url.length <= MAX_ART_REMOTE_URL_CHARS;
  if (!isDataPng && !isHttps) return undefined;

  const art: HandheldArt = { url, w: Math.round(width), h: Math.round(height) };

  // Animation is optional: keep it only when it's a valid multi-frame spec.
  const frames = Math.round(Number(source.frames));
  if (Number.isFinite(frames) && frames > 1 && frames <= MAX_ART_FRAMES) {
    const duration = Number(source.durationMs);
    art.frames = frames;
    art.durationMs = Number.isFinite(duration) ? Math.max(MIN_FRAME_MS, Math.min(MAX_FRAME_MS, Math.round(duration))) : 100;
  }
  return art;
}
