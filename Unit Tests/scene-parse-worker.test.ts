/**
 * The scene's parse off the main thread (AAA_PRODUCTION_ROADMAP.md M4): the
 * worker that builds a map's sidecar parses it too and hands the scene over
 * with its buffers transferred, so Beaver Creek's ~1 s parse no longer holds
 * the page. The parsed scene is plain data, so it crosses intact.
 */
import { describe, expect, it } from "vitest";
import { lockoutMeshSidecar } from "@cartbox/editor";
import { meshSceneTransferables, parseMeshScene, type MeshScene } from "@cartbox/player";
import { createSidecarLoader, type SidecarReply, type SidecarWorker } from "../apps/web/src/lib/sidecarLoader";

/** A scene's digest: its shape (keys, lengths, numbers, strings) and an FNV hash of every typed array's bytes, in walk order. */
function digest(scene: unknown): string {
  let hash = 2166136261;
  const shape: string[] = [];
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") {
      shape.push(typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? String(v) : typeof v);
      return;
    }
    if (ArrayBuffer.isView(v)) {
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      for (let i = 0; i < bytes.length; i += 1) hash = Math.imul(hash ^ bytes[i]!, 16777619) >>> 0;
      shape.push(`${v.constructor.name}[${bytes.length}]`);
      return;
    }
    const keys = Object.keys(v).sort();
    shape.push(`{${keys.length}}`);
    for (const k of keys) walk((v as Record<string, unknown>)[k]);
  };
  walk(scene);
  return `${hash}:${shape.length}:${shape.join(",").length}`;
}

describe("a parsed scene's transferables", () => {
  it("lists each buffer once, however many views share it", () => {
    const shared = new ArrayBuffer(64);
    const scene = {
      instances: [{ mesh: { primitives: [{ positions: new Float32Array(shared, 0, 4), normals: new Float32Array(shared, 16, 4), indices: new Uint32Array(3) }] } }],
      extra: { image: new Uint8Array(8), again: new Uint8Array(shared) },
    } as unknown as MeshScene;
    const list = meshSceneTransferables(scene);
    expect(list).toHaveLength(3);
    expect(list).toContain(shared);
  });

  it("crosses a structured clone with its buffers transferred, unchanged, leaving the sender's empty", () => {
    const original = parseMeshScene(lockoutMeshSidecar())!;
    const reference = parseMeshScene(lockoutMeshSidecar())!;
    const transfer = meshSceneTransferables(original);
    expect(transfer.length).toBeGreaterThan(100);
    const received = structuredClone(original, { transfer });
    expect(digest(received)).toBe(digest(reference));
    expect(transfer.every((b) => b.byteLength === 0)).toBe(true); // moved, not copied
  }, 120_000);
});

describe("the sidecar worker", () => {
  it("parses the map it built, and posts the scene with its buffers to transfer", async () => {
    const posted: { reply: SidecarReply; transfer?: Transferable[] }[] = [];
    const scope = { onmessage: null as ((event: { data: { mapId: string } }) => void) | null, postMessage: (reply: SidecarReply, transfer?: Transferable[]) => posted.push({ reply, transfer }) };
    (globalThis as { self?: unknown }).self = scope;
    await import("../apps/web/src/app/lockout/sidecar.worker");
    scope.onmessage!({ data: { mapId: "lockout" } });
    expect(posted).toHaveLength(1);
    const { reply, transfer } = posted[0]!;
    expect("error" in reply).toBe(false);
    const built = reply as SidecarReply & { json: string; scene?: MeshScene | null };
    expect(digest(built.scene)).toBe(digest(parseMeshScene(built.json)));
    expect(transfer).toEqual(meshSceneTransferables(built.scene!));
    delete (globalThis as { self?: unknown }).self;
  }, 120_000);

  it("hands the parsed scene through the loader to the page", async () => {
    const scene = { instances: [] } as unknown as MeshScene;
    const worker: SidecarWorker = {
      postMessage(message) {
        queueMicrotask(() => worker.onmessage?.({ data: { mapId: message.mapId, json: "{}", center: [0, 0, 0], scene } }));
      },
      terminate() {},
      onmessage: null,
      onerror: null,
    };
    const loader = createSidecarLoader({ makeWorker: () => worker, buildHere: () => ({ json: "{}", center: [0, 0, 0] }) });
    expect((await loader.get("lockout")).scene).toBe(scene);
    // A build on the page's own thread has none, and the page parses as before.
    const here = createSidecarLoader({ makeWorker: null, buildHere: () => ({ json: "{}", center: [0, 0, 0] }) });
    expect((await here.get("lockout")).scene).toBeUndefined();
  });
});
