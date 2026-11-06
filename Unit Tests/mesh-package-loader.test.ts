/**
 * The player fetching mesh packages itself (AAA_PRODUCTION_ROADMAP.md D5):
 * the play page hands over package URLs, and the client fetches them from the
 * CDN, checks each against its hash, decodes and parses, on a worker where it
 * can. What comes out must be what the server's inlining made, a bad or
 * missing package must cost only its objects, and the textures packaged
 * meshes reference must still stream.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { deserializeMeshAsset, serializeMeshAsset, type MeshAsset, type MeshMaterial } from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";
import { hashAsset } from "@/lib/cartAssetStore";
import { decodeMeshSidecar } from "@/lib/meshSidecar";
import { extractMeshTextures, inlineMeshTextures } from "@/lib/meshTextureAssets";
import { extractMeshPackages, inlineMeshPackages, loadMeshoptCodec, meshPackageRefs } from "@/lib/meshPackages";
import {
  fetchPackagedSidecar,
  loadPackagedSidecar,
  streamedMeshTextures,
  type MeshPackageSource,
  type PackageReply,
  type PackageRequest,
  type PackageWorker,
} from "@/lib/meshPackageLoader";

function grid(n: number, material: MeshMaterial): MeshAsset {
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= n; j += 1) for (let i = 0; i <= n; i += 1) {
    positions.push(i / n, Math.sin(i * 0.3) * 0.1, j / n);
    uvs.push(i / n, j / n);
    normals.push(0, 1, 0);
  }
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) {
    const a = j * (n + 1) + i;
    indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
  }
  return { name: `grid${n}`, primitives: [{ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material }] };
}
const image = (seed: number) => ({ mime: "image/png", bytes: Uint8Array.from({ length: 200 }, (_, i) => (i * 7 + seed) & 255) });
const material = (name: string, seed: number): MeshMaterial => ({ name, baseColorFactor: [1, 1, 1, 1], baseColorImage: image(seed) });
const T = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

/** A saved sidecar as the save path leaves it (textures offloaded, then meshes packaged), and the store's blobs. */
async function saved() {
  const rock = serializeMeshAsset(grid(24, material("rock", 1)));
  const tree = serializeMeshAsset(grid(20, material("bark", 2)));
  const small = serializeMeshAsset(grid(1, { name: "s", baseColorFactor: [1, 0, 0, 1], baseColorImage: null }));
  const encoded = JSON.stringify({
    version: 2,
    meshes: [
      { id: "rock1", name: "Rock", mesh: rock, transform: T },
      { id: "rock2", name: "Rock 2", mesh: rock, transform: T },
      { id: "tree", name: "Tree", mesh: tree, transform: T },
      { id: "cube", name: "Cube", mesh: small, transform: T },
    ],
  });
  const codec = await loadMeshoptCodec();
  const textures = await extractMeshTextures(encoded, hashAsset);
  const packaged = await extractMeshPackages(textures.encoded, hashAsset, codec);
  const blobs = new Map<string, Uint8Array>();
  for (const a of [...textures.textures, ...packaged.packages]) blobs.set(a.hash, a.bytes);
  const refs = meshPackageRefs(packaged.encoded);
  const packages: MeshPackageSource[] = refs.map((hash) => ({ hash, url: `https://cdn.test/assets/${hash}`, bytes: blobs.get(hash)!.length }));
  return { original: encoded, stored: packaged.encoded, blobs, packages, codec, textureHashes: textures.textures.map((t) => t.hash) };
}

/** A CDN over the blobs, with per-hash overrides, counting requests and the most in flight at once. */
function cdn(blobs: Map<string, Uint8Array>, override: Record<string, "404" | "throw" | Uint8Array> = {}) {
  let inFlight = 0;
  let most = 0;
  const asked: string[] = [];
  const fetchFn = (async (url: string) => {
    const hash = String(url).split("/").pop()!;
    asked.push(hash);
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    const o = override[hash];
    if (o === "throw") throw new Error("network down");
    if (o === "404") return new Response("missing", { status: 404 });
    const body = o ?? blobs.get(hash);
    return body ? new Response(body) : new Response("missing", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, asked, most: () => most };
}

const meshes = (json: string) => JSON.parse(json).meshes.map((m: { mesh: string }) => serializeMeshAsset(deserializeMeshAsset(m.mesh)));

describe("fetching packages on the client", () => {
  it("puts back what the server's inlining did, each package fetched once", async () => {
    const s = await saved();
    expect(s.packages).toHaveLength(2); // rock (used twice) and tree; the cube is too small to package
    const c = cdn(s.blobs);
    const out = await fetchPackagedSidecar(s.stored, s.packages, { fetchFn: c.fetchFn, codec: s.codec });
    expect(out.missing).toEqual([]);
    expect(c.asked.sort()).toEqual(s.packages.map((p) => p.hash).sort());
    const server = await inlineMeshPackages(s.stored, async (h) => s.blobs.get(h) ?? null, s.codec);
    expect(out.json).toBe(server);
    // And with the textures put back, the original scene.
    const back = await inlineMeshTextures(out.json, async (h) => s.blobs.get(h) ?? null);
    expect(meshes(back)).toEqual(meshes(s.original));
  });

  it("drops only the objects whose package didn't arrive or doesn't match its hash", async () => {
    const s = await saved();
    const [rock, tree] = s.packages.map((p) => p.hash);
    const tampered = s.blobs.get(tree!)!.slice();
    tampered[tampered.length - 1] ^= 0xff;
    const forged = await fetchPackagedSidecar(s.stored, s.packages, { fetchFn: cdn(s.blobs, { [tree!]: tampered }).fetchFn, codec: s.codec });
    expect(forged.missing).toEqual([tree]);
    expect(decodeMeshSidecar(forged.json).meshes.map((m) => m.id).sort()).toEqual(["cube", "rock1", "rock2"]);
    const gone = await fetchPackagedSidecar(s.stored, s.packages, { fetchFn: cdn(s.blobs, { [rock!]: "404", [tree!]: "throw" }).fetchFn, codec: s.codec });
    expect([...gone.missing].sort()).toEqual([rock, tree].sort());
    expect(decodeMeshSidecar(gone.json).meshes.map((m) => m.id)).toEqual(["cube"]);
  });

  it("fetches in parallel, at most `concurrency` at once, and ignores packages the sidecar doesn't use", async () => {
    const s = await saved();
    const extra: MeshPackageSource = { hash: "f".repeat(64), url: "https://cdn.test/assets/" + "f".repeat(64), bytes: 1 };
    const c = cdn(s.blobs);
    await fetchPackagedSidecar(s.stored, [...s.packages, extra], { fetchFn: c.fetchFn, codec: s.codec, concurrency: 1 });
    expect(c.most()).toBe(1);
    expect(c.asked).not.toContain(extra.hash);
    const c2 = cdn(s.blobs);
    await fetchPackagedSidecar(s.stored, s.packages, { fetchFn: c2.fetchFn, codec: s.codec });
    expect(c2.most()).toBe(2);
  });

  it("lists the textures packaged meshes reference once they're in, with their sizes and URLs", async () => {
    const s = await saved();
    expect(streamedMeshTextures(s.stored, () => 0, (h) => h)).toEqual([]); // inside the packages: not visible yet
    const out = await fetchPackagedSidecar(s.stored, s.packages, { fetchFn: cdn(s.blobs).fetchFn, codec: s.codec });
    const list = streamedMeshTextures(out.json, (h) => s.blobs.get(h)?.length ?? 0, (h) => `https://cdn.test/assets/${h}`);
    expect(list.map((t) => t.hash).sort()).toEqual([...s.textureHashes].sort());
    for (const t of list) {
      expect(t.bytes).toBe(s.blobs.get(t.hash)!.length);
      expect(t.url).toBe(`https://cdn.test/assets/${t.hash}`);
      expect(t.mime).toBe("image/png");
    }
  });
});

describe("where it runs", () => {
  const here = vi.fn(async (meshRaw: string) => ({ json: `${meshRaw}!`, missing: [] as string[] }));
  afterEach(() => here.mockClear());

  /** A worker that answers with `reply`, or fails. */
  const fakeWorker = (answer: (req: PackageRequest) => PackageReply | "fail") => {
    let terminated = 0;
    const make = (): PackageWorker => {
      const w: PackageWorker = {
        onmessage: null,
        onerror: null,
        postMessage(req) {
          queueMicrotask(() => {
            const r = answer(req);
            if (r === "fail") w.onerror?.(new Error("crashed"));
            else w.onmessage?.({ data: r });
          });
        },
        terminate() {
          terminated += 1;
        },
      };
      return w;
    };
    return { make, terminated: () => terminated };
  };

  it("on a worker, which parses the scene too, and is ended after its answer", async () => {
    const w = fakeWorker((req) => ({ json: `${req.meshRaw}?`, missing: [], scene: null }));
    const out = await loadPackagedSidecar({ meshRaw: "{}", packages: [], makeWorker: w.make, here });
    expect(out).toMatchObject({ json: "{}?", where: "worker", scene: null });
    expect(here).not.toHaveBeenCalled();
    expect(w.terminated()).toBe(1);
  });

  it("here when there are no workers, a worker fails, or it answers with an error", async () => {
    expect(await loadPackagedSidecar({ meshRaw: "a", packages: [], makeWorker: null, here })).toMatchObject({ json: "a!", where: "here" });
    const crash = fakeWorker(() => "fail");
    expect(await loadPackagedSidecar({ meshRaw: "b", packages: [], makeWorker: crash.make, here })).toMatchObject({ json: "b!", where: "here" });
    expect(crash.terminated()).toBe(1);
    const err = fakeWorker(() => ({ error: "no codec" }));
    expect(await loadPackagedSidecar({ meshRaw: "c", packages: [], makeWorker: err.make, here })).toMatchObject({ json: "c!", where: "here" });
    expect(await loadPackagedSidecar({ meshRaw: "d", packages: [], makeWorker: () => { throw new Error("blocked"); }, here })).toMatchObject({ json: "d!", where: "here" });
  });

  it("the worker module itself: fetches, decodes and answers with the parsed scene", async () => {
    const s = await saved();
    const c = cdn(s.blobs);
    vi.stubGlobal("fetch", c.fetchFn);
    const replies: PackageReply[] = [];
    const scope = { onmessage: null as ((e: { data: PackageRequest }) => void) | null, postMessage: (r: PackageReply) => replies.push(r) };
    vi.stubGlobal("self", scope);
    try {
      await import("../apps/web/src/app/play/[cartId]/meshPackages.worker");
      scope.onmessage!({ data: { meshRaw: s.stored, packages: s.packages } });
      for (let i = 0; i < 200 && replies.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(replies).toHaveLength(1);
      const reply = replies[0]!;
      if ("error" in reply) throw new Error(reply.error);
      expect(reply.missing).toEqual([]);
      expect(reply.scene?.instances).toHaveLength(4); // every object, its mesh decoded on the worker
      expect(reply.scene!.instances.map((i) => i.mesh.primitives[0]!.positions.length)).toEqual(parseMeshScene(reply.json)!.instances.map((i) => i.mesh.primitives[0]!.positions.length));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
