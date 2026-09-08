/**
 * Moving mesh textures into the cart asset store.
 *
 * This rewrites stored cart data, so the bar is higher than "it works": the
 * round trip has to be lossless, old carts with inline bytes have to keep
 * working untouched, and every failure mode has to degrade rather than throw —
 * a malformed texture must cost that surface's colour, never the cart.
 */

import { describe, expect, it } from "vitest";

import {
  deserializeMeshAsset,
  serializeMeshAsset,
  type MeshAsset,
} from "@cartbox/editor";
import {
  EMPTY_CART_ASSETS,
  cartAssetBytes,
  hashAsset,
  parseCartAssets,
} from "@/lib/cartAssetStore";
import {
  extractMeshTextures,
  inlineMeshTextures,
  manifestUpdate,
  meshTextureName,
  withMeshTextures,
} from "@/lib/meshTextureAssets";

/** A tiny but real PNG-ish byte run; contents only need to be stable. */
function textureBytes(seed: number, length = 64): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 7 + seed) & 255);
}

function mesh(images: (Uint8Array | null)[]): MeshAsset {
  return {
    name: "m",
    primitives: images.map((bytes) => ({
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: Float32Array.from([0, 0, 1, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2]),
      material: {
        name: "mat",
        baseColorFactor: [1, 1, 1, 1] as const,
        baseColorImage: bytes ? { mime: "image/png", bytes } : null,
      },
    })),
  };
}

/** A store that hands back exactly what was extracted. */
function storeFrom(textures: readonly { hash: string; bytes: Uint8Array }[]) {
  const map = new Map(textures.map((t) => [t.hash, t.bytes]));
  return async (hash: string) => map.get(hash) ?? null;
}

describe("extractMeshTextures", () => {
  it("replaces inline bytes with a content hash", async () => {
    const encoded = serializeMeshAsset(mesh([textureBytes(1)]));
    const result = await extractMeshTextures(encoded, hashAsset);

    expect(result.textures).toHaveLength(1);
    const payload = JSON.parse(result.encoded);
    expect(payload.primitives[0].material.image.asset).toBe(result.textures[0]!.hash);
    expect(payload.primitives[0].material.image.bytes).toBeUndefined();
    // The whole point: the payload got smaller.
    expect(result.encoded.length).toBeLessThan(encoded.length);
  });

  it("stores one copy of a texture used by several primitives", async () => {
    // The dedup that makes this worth doing at all.
    const shared = textureBytes(2);
    const result = await extractMeshTextures(
      serializeMeshAsset(mesh([shared, shared, shared])),
      hashAsset,
    );
    expect(result.textures).toHaveLength(1);

    const payload = JSON.parse(result.encoded);
    const hashes = payload.primitives.map((p: { material: { image: { asset: string } } }) => p.material.image.asset);
    expect(new Set(hashes).size).toBe(1);
  });

  it("leaves a mesh with no textures completely alone", async () => {
    const encoded = serializeMeshAsset(mesh([null]));
    const result = await extractMeshTextures(encoded, hashAsset);
    expect(result.encoded).toBe(encoded);
    expect(result.textures).toEqual([]);
  });

  it("leaves an unparseable payload alone rather than throwing", async () => {
    const result = await extractMeshTextures("{not json", hashAsset);
    expect(result.encoded).toBe("{not json");
    expect(result.textures).toEqual([]);
  });

  it("is idempotent: re-extracting an offloaded payload changes nothing", async () => {
    // Saving a cart twice must not re-upload or re-write anything.
    const first = await extractMeshTextures(serializeMeshAsset(mesh([textureBytes(3)])), hashAsset);
    const second = await extractMeshTextures(first.encoded, hashAsset);
    expect(second.encoded).toBe(first.encoded);
    expect(second.textures).toEqual([]);
  });
});

describe("the round trip", () => {
  it("restores a mesh byte-identically", async () => {
    // The bar. Anything less corrupts carts on save.
    const original = mesh([textureBytes(4), null, textureBytes(5)]);
    const encoded = serializeMeshAsset(original);

    const extracted = await extractMeshTextures(encoded, hashAsset);
    const restored = await inlineMeshTextures(extracted.encoded, storeFrom(extracted.textures));

    expect(restored).toBe(encoded);
    // And it still deserialises to the same mesh, not merely the same string.
    const back = deserializeMeshAsset(restored);
    expect(back.primitives).toHaveLength(3);
    expect(Array.from(back.primitives[0]!.material.baseColorImage!.bytes)).toEqual(
      Array.from(textureBytes(4)),
    );
    expect(back.primitives[1]!.material.baseColorImage).toBeNull();
  });

  it("survives a large texture without blowing the argument limit", async () => {
    // Chunked base64 exists for exactly this: spreading a multi-megabyte array
    // into String.fromCharCode throws, and that is the size this path is for.
    const big = textureBytes(6, 400_000);
    const encoded = serializeMeshAsset(mesh([big]));
    const extracted = await extractMeshTextures(encoded, hashAsset);
    const restored = await inlineMeshTextures(extracted.encoded, storeFrom(extracted.textures));
    expect(restored).toBe(encoded);
  });
});

describe("inlineMeshTextures", () => {
  it("passes an old inline-bytes payload straight through", async () => {
    // Carts written before any of this exists must keep working untouched.
    const encoded = serializeMeshAsset(mesh([textureBytes(7)]));
    expect(await inlineMeshTextures(encoded, async () => null)).toBe(encoded);
  });

  it("drops a missing texture to an untextured material instead of failing", async () => {
    // A missing texture costs its surface's colour; throwing would cost the cart.
    const extracted = await extractMeshTextures(serializeMeshAsset(mesh([textureBytes(8)])), hashAsset);
    const restored = await inlineMeshTextures(extracted.encoded, async () => null);

    const back = deserializeMeshAsset(restored);
    expect(back.primitives[0]!.material.baseColorImage).toBeNull();
    expect(back.primitives).toHaveLength(1); // the mesh itself survived
  });

  it("survives a fetcher that throws", async () => {
    const extracted = await extractMeshTextures(serializeMeshAsset(mesh([textureBytes(9)])), hashAsset);
    const restored = await inlineMeshTextures(extracted.encoded, async () => {
      throw new Error("storage down");
    });
    expect(deserializeMeshAsset(restored).primitives[0]!.material.baseColorImage).toBeNull();
  });

  it("fetches a shared texture once", async () => {
    const shared = textureBytes(10);
    const extracted = await extractMeshTextures(serializeMeshAsset(mesh([shared, shared])), hashAsset);

    let fetches = 0;
    await inlineMeshTextures(extracted.encoded, async (hash) => {
      fetches += 1;
      return storeFrom(extracted.textures)(hash);
    });
    expect(fetches).toBe(1);
  });
});

describe("manifest bookkeeping", () => {
  it("records offloaded textures so a sweep cannot reclaim them", async () => {
    // Textures referenced only from inside the mesh JSON would be invisible to
    // the mark phase of asset garbage collection, and deleted while in use.
    const extracted = await extractMeshTextures(
      serializeMeshAsset(mesh([textureBytes(11), textureBytes(12)])),
      hashAsset,
    );
    const assets = withMeshTextures(EMPTY_CART_ASSETS, extracted.textures);

    expect(Object.keys(assets.entries)).toHaveLength(2);
    for (const texture of extracted.textures) {
      expect(assets.entries[meshTextureName(texture.hash)]).toEqual({
        hash: texture.hash,
        bytes: texture.bytes.length,
        contentType: "image/png",
      });
    }
    expect(cartAssetBytes(assets)).toBe(128);
  });

  it("uses a name that survives a manifest round trip", async () => {
    // `mesh-<hash>` has to pass the manifest's own name validation, or the
    // entry is silently dropped on the next read and the sweep deletes it.
    const extracted = await extractMeshTextures(serializeMeshAsset(mesh([textureBytes(13)])), hashAsset);
    const json = manifestUpdate(EMPTY_CART_ASSETS, extracted.textures)!;
    const parsed = parseCartAssets(json)!;
    expect(Object.keys(parsed.entries)).toEqual([meshTextureName(extracted.textures[0]!.hash)]);
  });

  it("reports no manifest change when nothing was offloaded", async () => {
    expect(manifestUpdate(EMPTY_CART_ASSETS, [])).toBeNull();
  });

  it("is stable across saves, so re-saving rewrites nothing", async () => {
    const extracted = await extractMeshTextures(serializeMeshAsset(mesh([textureBytes(14)])), hashAsset);
    const once = withMeshTextures(EMPTY_CART_ASSETS, extracted.textures);
    const twice = withMeshTextures(once, extracted.textures);
    expect(twice.entries).toEqual(once.entries);
  });
});
