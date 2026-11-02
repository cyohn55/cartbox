/**
 * Builds a map's sidecar off the main thread (DEMO_QUALITY_ROADMAP.md R2; see
 * lib/sidecarLoader.ts): asked for a map by its id, it answers with that map's
 * sidecar JSON and its scene's centre, or with the error that stopped it. The
 * page ends it after one answer, so the generators' working memory goes with it.
 */

import { arenaMap } from "@cartbox/editor";

import type { SidecarReply } from "../../lib/sidecarLoader";

const scope = self as unknown as { onmessage: ((event: { data: { mapId: string } }) => void) | null; postMessage(reply: SidecarReply): void };

scope.onmessage = (event) => {
  const { mapId } = event.data;
  try {
    const map = arenaMap(mapId);
    // The centre too: it builds the map's mesh again, which is better done here than on the page.
    scope.postMessage({ mapId, json: map.sidecar(), center: map.center() });
  } catch (error) {
    scope.postMessage({ mapId, error: error instanceof Error ? error.message : String(error) });
  }
};
