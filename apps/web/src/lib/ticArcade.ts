/**
 * The TIC-80 community archive as a live catalog source for the Browse tab.
 *
 * tic80.com exposes the same listing API its built-in SURF browser uses
 * (`/api?fn=dir&path=play/<category>`), and both the API and the cart
 * binaries are served with `Access-Control-Allow-Origin: *` — so the console
 * fetches the full archive directly in the browser and plays carts straight
 * from the source. Nothing is rehosted, nothing is baked, and the static
 * demo build gets the entire catalog for free.
 *
 * The listing response is a Lua table literal, not JSON; parseTicDir() is the
 * pure parser (unit-tested) that turns it into typed entries.
 */

/** Where the archive lives. Overridable for tests/mirrors. */
export const TIC_ARCADE_BASE_URL = "https://tic80.com";

/** Archive categories, as the site names them (path segment = lowercase). */
export const TIC_ARCADE_CATEGORIES = [
  "Games",
  "Tech",
  "Tools",
  "Music",
  "Demoscene",
  "WIP",
] as const;
export type TicArcadeCategory = (typeof TIC_ARCADE_CATEGORIES)[number];

/** One cart in the archive listing. */
export interface TicArcadeEntry {
  /** tic80.com's numeric cart id (its /play?cart=<id> page). */
  id: number;
  /** Display title (listing name without the .tic suffix). */
  title: string;
  /** Content hash addressing the binary and cover art. */
  hash: string;
  /** Binary filename under the hash. */
  filename: string;
}

/**
 * Parses the archive's Lua-table directory listing into entries.
 * Tolerates unknown fields and skips malformed rows rather than throwing —
 * the archive is external input.
 */
export function parseTicDir(luaText: string): TicArcadeEntry[] {
  const entries: TicArcadeEntry[] = [];
  const row = /\{\s*name\s*=\s*"([^"]*)"\s*,\s*hash\s*=\s*"([0-9a-f]+)"\s*,\s*id\s*=\s*(\d+)\s*,\s*filename\s*=\s*"([^"]+)"\s*\}/gi;
  for (const match of luaText.matchAll(row)) {
    const [, name, hash, id, filename] = match;
    if (!name || !hash || !filename) {
      continue;
    }
    entries.push({
      id: Number(id),
      title: name.replace(/\.tic$/i, ""),
      hash,
      filename,
    });
  }
  return entries;
}

/** Direct, CORS-open URL of a cart binary. */
export function ticArcadeCartUrl(entry: TicArcadeEntry, baseUrl: string = TIC_ARCADE_BASE_URL): string {
  return `${baseUrl}/cart/${entry.hash}/${entry.filename}`;
}

/** Cover-art URL (an animated GIF the site renders for every cart). */
export function ticArcadeCoverUrl(entry: TicArcadeEntry, baseUrl: string = TIC_ARCADE_BASE_URL): string {
  return `${baseUrl}/cart/${entry.hash}/cover.gif`;
}

/** Fetches one category's full listing from the archive. */
export async function fetchTicArcadeCategory(
  category: TicArcadeCategory,
  baseUrl: string = TIC_ARCADE_BASE_URL,
): Promise<TicArcadeEntry[]> {
  const response = await fetch(`${baseUrl}/api?fn=dir&path=play/${category.toLowerCase()}`);
  if (!response.ok) {
    throw new Error(`TIC-80 archive listing failed: ${response.status}`);
  }
  return parseTicDir(await response.text());
}
