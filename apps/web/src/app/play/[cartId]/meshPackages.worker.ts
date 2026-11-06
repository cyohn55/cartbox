/**
 * A cart's mesh packages fetched, checked, decoded and parsed off the main
 * thread (AAA_PRODUCTION_ROADMAP.md D5, M4; lib/meshPackageLoader.ts): asked
 * with the sidecar and its packages' URLs, it answers with the sidecar's JSON
 * and its parsed scene, the scene's buffers handed over rather than copied.
 * The page ends it after one answer, so the decoder's memory goes with it.
 */

import { meshSceneTransferables, parseMeshScene } from "@cartbox/player";

import { fetchPackagedSidecar, type PackageReply, type PackageRequest } from "../../../lib/meshPackageLoader";
import { loadMeshoptCodec } from "../../../lib/meshPackages";

const scope = self as unknown as { onmessage: ((event: { data: PackageRequest }) => void) | null; postMessage(reply: PackageReply, transfer?: Transferable[]): void };

scope.onmessage = (event) => {
  void (async () => {
    try {
      const { meshRaw, packages } = event.data;
      const { json, missing } = await fetchPackagedSidecar(meshRaw, packages, { codec: await loadMeshoptCodec() });
      const scene = parseMeshScene(json);
      scope.postMessage({ json, missing, scene }, scene ? meshSceneTransferables(scene) : []);
    } catch (error) {
      scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
  })();
};
