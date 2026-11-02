/**
 * Map sidecars built off the main thread (DEMO_QUALITY_ROADMAP.md R2): a
 * worker builds the map's sidecar while the lobby is open, Play waits for the
 * same build, and the main thread builds it only where a worker can't.
 */

import { describe, expect, it } from "vitest";

import { createSidecarLoader, type SidecarReply, type SidecarWorker } from "../apps/web/src/lib/sidecarLoader";

/** A worker that answers when told to, recording what it was asked and whether it was ended. */
class FakeWorker implements SidecarWorker {
  onmessage: ((event: { data: SidecarReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  asked: string[] = [];
  ended = false;
  postMessage(message: { mapId: string }): void {
    this.asked.push(message.mapId);
  }
  terminate(): void {
    this.ended = true;
  }
  answer(reply: SidecarReply): void {
    this.onmessage?.({ data: reply });
  }
}

const C = [1, 2, 3] as const;
const built = (json: string) => ({ json, center: C });

const setup = (withWorkers = true) => {
  const workers: FakeWorker[] = [];
  const builtHere: string[] = [];
  const loader = createSidecarLoader({
    makeWorker: withWorkers
      ? () => {
          const w = new FakeWorker();
          workers.push(w);
          return w;
        }
      : null,
    buildHere: (mapId) => {
      builtHere.push(mapId);
      return built(`here:${mapId}`);
    },
  });
  return { loader, workers, builtHere };
};

describe("the sidecar loader", () => {
  it("builds in a worker, never on the main thread, and ends the worker once it answers", async () => {
    const { loader, workers, builtHere } = setup();
    const json = loader.get("beaver");
    expect(workers).toHaveLength(1);
    expect(workers[0]!.asked).toEqual(["beaver"]);
    workers[0]!.answer({ mapId: "beaver", json: "{built}", center: [4, 5, 6] });
    // The centre comes with it, worked out where the mesh was built.
    expect(await json).toEqual({ json: "{built}", center: [4, 5, 6] });
    expect(workers[0]!.ended).toBe(true);
    expect(builtHere).toEqual([]);
  });

  it("gives Play the build the lobby started, without starting another", async () => {
    const { loader, workers } = setup();
    loader.prefetch("lockout");
    const play = loader.get("lockout");
    expect(workers).toHaveLength(1);
    workers[0]!.answer({ mapId: "lockout", ...built("{lockout}") });
    expect(await play).toEqual(built("{lockout}"));
    expect(await loader.get("lockout")).toEqual(built("{lockout}"));
    expect(workers).toHaveLength(1);
  });

  it("holds one map at a time: another map is a new build, and going back builds again", async () => {
    const { loader, workers } = setup();
    loader.prefetch("lockout");
    workers[0]!.answer({ mapId: "lockout", ...built("{lockout}") });
    const beaver = loader.get("beaver");
    workers[1]!.answer({ mapId: "beaver", ...built("{beaver}") });
    expect(await beaver).toEqual(built("{beaver}"));
    loader.prefetch("lockout");
    expect(workers).toHaveLength(3);
  });

  it("falls back to the main thread when the worker fails, or can't be made", async () => {
    const failing = setup();
    const a = failing.loader.get("beaver");
    failing.workers[0]!.answer({ mapId: "beaver", error: "boom" });
    expect(await a).toEqual(built("here:beaver"));
    const crashing = setup();
    const b = crashing.loader.get("beaver");
    crashing.workers[0]!.onerror?.(new Error("crash"));
    expect(await b).toEqual(built("here:beaver"));
    expect(crashing.workers[0]!.ended).toBe(true);
    const none = setup(false);
    expect(await none.loader.get("lockout")).toEqual(built("here:lockout"));
    expect(none.builtHere).toEqual(["lockout"]);
  });

  it("ends a worker still building when the page goes", () => {
    const { loader, workers } = setup();
    loader.prefetch("beaver");
    loader.dispose();
    expect(workers[0]!.ended).toBe(true);
  });
});
