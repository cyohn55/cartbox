/**
 * A map's sidecar, built off the main thread (DEMO_QUALITY_ROADMAP.md R2).
 *
 * A map's sidecar is generated, not fetched: its geometry, its baked textures
 * and its PNGs are made in code, then written out as a ~2.7 MB JSON string.
 * That takes about 2 s of JavaScript a map on a desktop, and several times
 * that on a phone. The demo did it on the main thread after Play was pressed,
 * so the page froze there. Here a worker builds it while the lobby is open,
 * and Play waits only for what is left (usually nothing). The worker is then
 * ended, so the generators' working memory goes with it, and the page holds
 * only the finished string.
 *
 * Without workers (or when one fails) it is built on the main thread, as before.
 */

/**
 * A map's sidecar as built: its JSON, and its scene's centre, which the cart's
 * code needs and which costs a second build of the map's mesh to work out
 * anywhere else.
 */
import type { MeshScene } from "@cartbox/player";

export interface BuiltSidecar {
  readonly json: string;
  readonly center: readonly [number, number, number];
  /**
   * The sidecar already parsed (AAA_PRODUCTION_ROADMAP.md M4), when a worker
   * built it: the page then skips the parse on its own thread. Absent from a
   * build on this thread, which parses as before.
   */
  readonly scene?: MeshScene | null;
}

/** What a sidecar worker answers with. */
export type SidecarReply = ({ readonly mapId: string } & BuiltSidecar) | { readonly mapId: string; readonly error: string };

/** The part of a Worker this needs (so tests can hand in their own). */
export interface SidecarWorker {
  postMessage(message: { mapId: string }): void;
  terminate(): void;
  onmessage: ((event: { data: SidecarReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface SidecarLoaderOptions {
  /** A new worker that builds sidecars, or null where workers can't be used. */
  readonly makeWorker: (() => SidecarWorker) | null;
  /** Build a map's sidecar on this thread (the fallback). */
  readonly buildHere: (mapId: string) => BuiltSidecar;
}

export interface SidecarLoader {
  /** The map's sidecar: the one already built or being built, else a new build. */
  get(mapId: string): Promise<BuiltSidecar>;
  /** Start building the map's sidecar now, for a later `get`. */
  prefetch(mapId: string): void;
  /** End any worker still building. */
  dispose(): void;
}

/**
 * A loader keeping one map's sidecar at a time: asking for another map lets
 * the last one go, so a page never holds two maps' worth (B2's rule).
 */
export function createSidecarLoader(options: SidecarLoaderOptions): SidecarLoader {
  let held: { mapId: string; json: Promise<BuiltSidecar> } | null = null;
  const running = new Set<SidecarWorker>();

  const here = (mapId: string): Promise<BuiltSidecar> =>
    new Promise((resolve, reject) => {
      // A task of its own, so a caller that only prefetches isn't held up by the build.
      setTimeout(() => {
        try {
          resolve(options.buildHere(mapId));
        } catch (error) {
          reject(error);
        }
      }, 0);
    });

  const inWorker = (mapId: string): Promise<BuiltSidecar> => {
    let worker: SidecarWorker;
    try {
      worker = options.makeWorker!();
    } catch {
      return here(mapId);
    }
    running.add(worker);
    return new Promise<BuiltSidecar>((resolve) => {
      const done = (): void => {
        running.delete(worker);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      };
      worker.onmessage = (event) => {
        const reply = event.data;
        if (reply.mapId !== mapId) return;
        done();
        resolve("json" in reply ? { json: reply.json, center: reply.center, ...(reply.scene ? { scene: reply.scene } : {}) } : here(mapId));
      };
      worker.onerror = () => {
        done();
        resolve(here(mapId));
      };
      worker.postMessage({ mapId });
    });
  };

  const get = (mapId: string): Promise<BuiltSidecar> => {
    if (held?.mapId === mapId) return held.json;
    const json = options.makeWorker ? inWorker(mapId) : here(mapId);
    held = { mapId, json };
    // A failed build isn't kept: the next ask tries again.
    json.catch(() => {
      if (held?.json === json) held = null;
    });
    return json;
  };

  return {
    get,
    prefetch(mapId) {
      get(mapId).catch(() => {});
    },
    dispose() {
      for (const worker of running) worker.terminate();
      running.clear();
    },
  };
}
