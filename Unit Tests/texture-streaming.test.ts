/**
 * Streaming a published cart's textures (ENGINE_ROADMAP.md, Phase 4): a saved
 * scene's textures move into the cart asset store (the whole sidecar, every
 * image slot), the scene a player starts on carries placeholders, the textures
 * stream in with progress, and the running player swaps them in.
 */

import { describe, expect, it, vi } from "vitest";

import { composeModelMatrix, deserializeMeshAsset, serializeMeshAsset, type DecodedTexture, type MeshAsset } from "@cartbox/editor";
import { MeshOverlaySurface, type SceneDraw, type SceneRenderer } from "@cartbox/player";
import { hashAsset } from "../apps/web/src/lib/cartAssetStore";
import { measureDownload } from "../apps/web/src/lib/downloadBudget";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, readMeshEntry } from "../apps/web/src/lib/meshSidecar";
import { extractMeshTextures, inlineMeshTextures, meshTextureRefs } from "../apps/web/src/lib/meshTextureAssets";
import { streamTextures } from "../apps/web/src/lib/textureStream";

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

function quad(name: string, maps: { base?: Uint8Array; normal?: Uint8Array; mime?: string }): MeshAsset {
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: null,
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: {
          name: "m",
          baseColorFactor: [1, 1, 1, 1],
          baseColorImage: maps.base ? { mime: maps.mime ?? "image/png", bytes: maps.base } : null,
          ...(maps.normal ? { normalImage: { mime: "image/png", bytes: maps.normal } } : {}),
        },
      },
    ],
  };
}

describe("textures into the asset store, for a whole scene", () => {
  it("moves every image in every mesh of a sidecar out, deduplicated, and puts them back", async () => {
    const shared = bytes(4000, 7);
    let sidecar = emptyMeshSidecar();
    sidecar = addMesh(sidecar, quad("a", { base: shared, normal: bytes(3000, 9) }), "a").sidecar;
    sidecar = addMesh(sidecar, quad("b", { base: shared }), "b").sidecar;
    sidecar = addMesh(sidecar, quad("c", { base: bytes(2000, 3) }), "c").sidecar;
    const encoded = encodeMeshSidecar(sidecar)!;

    const extracted = await extractMeshTextures(encoded, hashAsset);
    expect(extracted.textures).toHaveLength(3); // the shared base colour once, the normal map, c's
    expect(extracted.encoded.length).toBeLessThan(encoded.length);
    expect(extracted.encoded).not.toContain('"bytes"');
    expect(meshTextureRefs(extracted.encoded).map((r) => r.hash).sort()).toEqual(extracted.textures.map((t) => t.hash).sort());

    const store = new Map(extracted.textures.map((t) => [t.hash, t.bytes]));
    const restored = await inlineMeshTextures(extracted.encoded, async (hash) => store.get(hash) ?? null);
    const before = decodeMeshSidecar(encoded).meshes.map(readMeshEntry);
    const after = decodeMeshSidecar(restored).meshes.map(readMeshEntry);
    expect(after).toEqual(before);
  });

  it("drops a texture it can't fetch to flat colour, in any slot", async () => {
    const encoded = encodeMeshSidecar(addMesh(emptyMeshSidecar(), quad("a", { base: bytes(10, 1), normal: bytes(10, 2) }), "a").sidecar)!;
    const extracted = await extractMeshTextures(encoded, hashAsset);
    const restored = await inlineMeshTextures(extracted.encoded, async () => null);
    const mesh = readMeshEntry(decodeMeshSidecar(restored).meshes[0]!);
    expect(mesh.primitives[0]!.material.baseColorImage).toBeNull();
    expect(mesh.primitives[0]!.material.normalImage ?? null).toBeNull();
  });

  it("still handles a single serialized mesh, as before", async () => {
    const extracted = await extractMeshTextures(serializeMeshAsset(quad("a", { base: bytes(12, 5) })), hashAsset);
    expect(extracted.textures).toHaveLength(1);
  });
});

describe("placeholders", () => {
  it("decode an asset reference as a placeholder the player can fill in", async () => {
    const extracted = await extractMeshTextures(serializeMeshAsset(quad("a", { base: bytes(12, 5) })), hashAsset);
    const image = deserializeMeshAsset(extracted.encoded).primitives[0]!.material.baseColorImage!;
    expect(image.ref).toBe(extracted.textures[0]!.hash);
    expect(image.bytes.length).toBe(0);
    expect(image.mime).toBe("image/png");
  });
});

describe("the running player", () => {
  const recorder = (): SceneRenderer & { last: () => unknown[] } => {
    const draws: unknown[][] = [];
    return {
      backend: "software",
      last: () => draws.at(-1)!,
      render: (instances, _draw: SceneDraw) => void draws.push(instances.map((i) => i.textures?.[0] ?? null)),
      dispose: () => {},
    };
  };
  const scene = (mesh: MeshAsset) => ({
    instances: [
      { mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) },
      { mesh, model: composeModelMatrix([2, 0, 0], [0, 0, 0], [1, 1, 1]) },
    ],
    bounds: { min: [-1, -1, -1] as [number, number, number], max: [3, 1, 1] as [number, number, number], center: [1, 0, 0] as [number, number, number], radius: 3 },
    lighting: null,
  });

  it("starts flat and swaps streamed textures in by ref", async () => {
    // KTX2 so a node test can decode (via the injected decoder); PNG goes through the browser.
    const placeholder: MeshAsset = { ...quad("a", {}), primitives: quad("a", {}).primitives.map((p) => ({ ...p, material: { ...p.material, baseColorImage: { mime: "image/ktx2", bytes: new Uint8Array(), ref: "h1" } } })) };
    const texture: DecodedTexture = { width: 1, height: 1, data: new Uint8ClampedArray([9, 8, 7, 255]) };
    const decode = vi.fn(() => texture);
    const loader = vi.fn(async () => decode);
    const renderer = recorder();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 8, 8, scene(placeholder), renderer, { ktx2: loader });
    surface.blit(new Uint8Array(8 * 8 * 4));
    expect(renderer.last()).toEqual([null, null]);
    expect(loader).not.toHaveBeenCalled(); // a placeholder never fetches a decoder

    expect(await surface.supplyImages(new Map([["other", { mime: "image/ktx2", bytes: bytes(4, 1) }]]))).toBe(0);
    expect(await surface.supplyImages(new Map([["h1", { mime: "image/ktx2", bytes: bytes(4, 1) }]]))).toBe(2);
    surface.blit(new Uint8Array(8 * 8 * 4));
    expect(renderer.last()).toEqual([texture, texture]);
    expect(decode).toHaveBeenCalledTimes(1); // one mesh, decoded once for both copies
  });
});

describe("streaming", () => {
  /** A fetch that serves each URL's bytes in 3 chunks. */
  function fakeFetch(files: Record<string, Uint8Array | null>) {
    return vi.fn(async (url: string) => {
      const data = files[url];
      if (!data) return new Response(null, { status: 404 });
      const third = Math.ceil(data.length / 3);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < data.length; i += third) controller.enqueue(data.slice(i, i + third));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("hands over each texture as it lands, with progress up to the total", async () => {
    const files = { "/a": bytes(300, 1), "/b": bytes(120, 2), "/c": null };
    const textures = [
      { hash: "a", url: "/a", bytes: 300, mime: "image/png" },
      { hash: "b", url: "/b", bytes: 120, mime: "image/png" },
      { hash: "c", url: "/c", bytes: 50, mime: "image/png" },
    ];
    const got: string[] = [];
    const progress: [number, number][] = [];
    const arrived = await streamTextures(textures, {
      fetchImpl: fakeFetch(files),
      concurrency: 2,
      onTexture: (hash, image) => {
        got.push(hash);
        expect(image.bytes.length).toBe(files[`/${hash}` as keyof typeof files]!.length);
      },
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });
    expect(arrived).toBe(2);
    expect(got.sort()).toEqual(["a", "b"]); // the missing one is skipped
    expect(progress.at(-1)).toEqual([470, 470]);
    for (let i = 1; i < progress.length; i += 1) expect(progress[i]![0]).toBeGreaterThanOrEqual(progress[i - 1]![0]);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const onTexture = vi.fn();
    expect(await streamTextures([{ hash: "a", url: "/a", bytes: 1, mime: "image/png" }], { fetchImpl: fakeFetch({ "/a": bytes(1, 1) }), onTexture, signal: controller.signal })).toBe(0);
    expect(onTexture).not.toHaveBeenCalled();
  });
});

describe("the download budget", () => {
  it("says when a cart is playable: before its textures", async () => {
    const encoded = encodeMeshSidecar(addMesh(emptyMeshSidecar(), quad("a", { base: crypto.getRandomValues(new Uint8Array(60_000)) }), "a").sidecar)!;
    const budget = await measureDownload({ modelId: "modern", cartridge: null, meshSidecar: encoded, otherData: [], uploadedBytes: 0 });
    expect(budget.playable).toBeLessThan(budget.total);
    expect(budget.total - budget.playable).toBeGreaterThan(40_000);
    const plain = await measureDownload({ modelId: "modern", cartridge: null, meshSidecar: encodeMeshSidecar(addMesh(emptyMeshSidecar(), quad("a", {}), "a").sidecar), otherData: [], uploadedBytes: 0 });
    expect(plain.playable).toBe(plain.total);
  });
});
