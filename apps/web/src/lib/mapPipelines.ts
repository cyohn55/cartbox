/**
 * Shipped pipeline manifests (AAA_PRODUCTION_ROADMAP.md M3, R5's fix): each
 * map's pipelines, recorded by `npm run record:pipelines <map>` from a scripted
 * run of the map on a real device, and served beside the app at
 * `/pipelines/<map>.json`. The player compiles them behind the loading screen
 * with the browser's own recorded manifest, so the very first load on a
 * browser, which has none, doesn't compile as it meets things.
 *
 * Fetching is best effort: a map without a manifest, a slow network or a
 * malformed file loads exactly as before.
 */

import { unpackPipelineManifest } from "@cartbox/player";

export const MAP_PIPELINES_DIR = "pipelines";

/** Where a map's shipped manifest is served. */
export function mapPipelinesUrl(mapId: string): string {
  return `/${MAP_PIPELINES_DIR}/${encodeURIComponent(mapId)}.json`;
}

/**
 * A map's shipped manifest as text, or null (none, unreadable, or not here
 * within `timeoutMs`). Never throws.
 */
export async function fetchMapPipelines(
  mapId: string,
  { fetchFn = globalThis.fetch?.bind(globalThis), timeoutMs = 2000 }: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  if (!fetchFn) return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const response = await fetchFn(mapPipelinesUrl(mapId), controller ? { signal: controller.signal } : {});
    if (!response.ok) return null;
    const text = await response.text();
    return unpackPipelineManifest(text).length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
