/**
 * Builds a map's sidecar off the main thread (DEMO_QUALITY_ROADMAP.md R2; see
 * lib/sidecarLoader.ts): asked for a map by its id, it answers with that map's
 * sidecar JSON and its scene's centre, or with the error that stopped it. The
 * page ends it after one answer, so the generators' working memory goes with it.
 */

import { arenaMap } from "@cartbox/editor";
import { meshSceneTransferables, parseMeshScene } from "@cartbox/player";

import type { SidecarReply } from "../../lib/sidecarLoader";

const scope = self as unknown as { onmessage: ((event: { data: { mapId: string } }) => void) | null; postMessage(reply: SidecarReply, transfer?: Transferable[]): void };

scope.onmessage = (event) => {
  const { mapId } = event.data;
  try {
    const map = arenaMap(mapId);
    const json = map.sidecar();
    // Parsed here too (AAA_PRODUCTION_ROADMAP.md M4), its buffers handed over rather than copied:
    // about a second of Beaver Creek's load that no longer holds the page.
    const scene = parseMeshScene(json);
    // The centre too: it builds the map's mesh again, which is better done here than on the page.
    scope.postMessage({ mapId, json, center: map.center(), scene }, scene ? meshSceneTransferables(scene) : []);
  } catch (error) {
    scope.postMessage({ mapId, error: error instanceof Error ? error.message : String(error) });
  }
};
