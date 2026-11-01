/**
 * Packaging and storage (AAA_FIDELITY_ROADMAP.md F9e): the binary package
 * (a round trip, meshopt-squeezed and raw, hash-checked, refusing truncation,
 * tampering and other versions), asset validation (texel density, names,
 * budgets, missing maps), and uploads straight to storage past the API's body
 * limit (the route chosen by size, the presign's checksum, and the browser's
 * begin → PUT → commit, deduplicated when the store already holds the bytes).
 */

import { describe, expect, it } from "vitest";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

import { encodeRgbaPng, packMeshAsset, readPackageManifest, sha256, unpackMeshAsset, validateMeshAsset, type MeshAsset, type MeshMaterial, type MeshoptCodec, type MeshPrimitive } from "@cartbox/editor";
import { encodedImageSize } from "../packages/editor/src/index";
import { DIRECT_UPLOAD_THRESHOLD, MAX_ASSET_BYTES, MAX_DIRECT_ASSET_BYTES, checkAssetUpload, hashToBase64, uploadRoute, EMPTY_CART_ASSETS } from "../apps/web/src/lib/cartAssetStore";
import { uploadCartAsset } from "../apps/web/src/lib/assetUploadClient";

await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const meshopt: MeshoptCodec = {
  encodeVertexBuffer: (s, c, z) => MeshoptEncoder.encodeVertexBuffer(s, c, z),
  encodeIndexBuffer: (s, c, z) => MeshoptEncoder.encodeIndexBuffer(s, c, z),
  decodeVertexBuffer: (t, c, z, s) => MeshoptDecoder.decodeVertexBuffer(t, c, z, s),
  decodeIndexBuffer: (t, c, z, s) => MeshoptDecoder.decodeIndexBuffer(t, c, z, s),
};

/** A grid of n×n quads with normals, UVs, tangents, joints and an image. */
function grid(n: number): MeshAsset {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], tangents: number[] = [], joints: number[] = [], indices: number[] = [];
  for (let j = 0; j <= n; j += 1) {
    for (let i = 0; i <= n; i += 1) {
      positions.push(i / n, Math.sin(i * 0.3) * 0.1, j / n);
      normals.push(0, 1, 0);
      uvs.push(i / n, j / n);
      tangents.push(1, 0, 0, 1);
      joints.push(i % 4, j % 4, 0, 0);
    }
  }
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) {
    const a = j * (n + 1) + i;
    indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
  }
  const image = encodeRgbaPng(new Uint8ClampedArray(16 * 16 * 4).fill(200), 16, 16);
  const material = { name: "painted", baseColorFactor: [0.8, 0.5, 0.2, 1], baseColorImage: { mime: "image/png", bytes: image }, metallicFactor: 0.3, roughnessFactor: 0.7, smartStack: { layers: [{ id: "a", name: "A", baseColor: [1, 0, 0] }] } } as unknown as MeshMaterial;
  return {
    name: "grid",
    primitives: [{ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), tangents: Float32Array.from(tangents), joints: Uint16Array.from(joints), indices: Uint32Array.from(indices), material } as unknown as MeshPrimitive],
  } as unknown as MeshAsset;
}

describe("the binary package", () => {
  it("hashes as SHA-256 does", () => {
    expect(sha256(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  for (const squeezed of [false, true]) {
    it(`round-trips a mesh, its streams, image and material${squeezed ? ", meshopt-squeezed" : ""}`, () => {
      const mesh = grid(24);
      const bytes = packMeshAsset(mesh, squeezed ? meshopt : null);
      const back = unpackMeshAsset(bytes, squeezed ? meshopt : null);
      const p = mesh.primitives[0]!;
      const q = back.primitives[0]!;
      expect(back.name).toBe("grid");
      expect(Array.from(q.positions)).toEqual(Array.from(p.positions));
      expect(Array.from(q.indices)).toEqual(Array.from(p.indices));
      expect(Array.from(q.uvs!)).toEqual(Array.from(p.uvs!));
      expect(Array.from(q.tangents!)).toEqual(Array.from(p.tangents!));
      expect(q.joints).toBeInstanceOf(Uint16Array);
      expect(Array.from(q.joints!)).toEqual(Array.from(p.joints!));
      expect(Array.from(q.material.baseColorImage!.bytes)).toEqual(Array.from(p.material.baseColorImage!.bytes));
      expect(q.material.baseColorFactor).toEqual([0.8, 0.5, 0.2, 1]);
      expect(q.material.roughnessFactor).toBe(0.7);
      expect(q.material.smartStack).toEqual(p.material.smartStack);
      // Every chunk on a 16-byte boundary.
      const { manifest } = readPackageManifest(bytes);
      for (const c of manifest.chunks) expect(c.offset % 16).toBe(0);
    });
  }

  it("squeezes geometry with meshopt, and is far smaller than the JSON sidecar's base64", () => {
    const mesh = grid(48);
    const raw = packMeshAsset(mesh);
    const small = packMeshAsset(mesh, meshopt);
    expect(small.byteLength).toBeLessThan(raw.byteLength * 0.6);
    const { manifest } = readPackageManifest(small);
    expect(manifest.chunks.find((c) => c.name === "p0.indices")!.encoding).toBe("meshopt-index");
    expect(manifest.chunks.find((c) => c.name === "p0.positions")!.encoding).toBe("meshopt-vertex");
    // A squeezed package needs the decoder.
    expect(() => unpackMeshAsset(small)).toThrow(/meshopt/);
  });

  it("refuses what isn't a package, a truncated one, a tampered one and another version", () => {
    const bytes = packMeshAsset(grid(4));
    expect(() => unpackMeshAsset(new Uint8Array(40))).toThrow(/Not a Cartbox package/);
    expect(() => unpackMeshAsset(bytes.slice(0, bytes.length - 20))).toThrow(/truncated/);
    const tampered = bytes.slice();
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => unpackMeshAsset(tampered)).toThrow(/hash/);
    const other = bytes.slice();
    new DataView(other.buffer).setUint32(4, 99, true);
    expect(() => unpackMeshAsset(other)).toThrow(/version 99/);
  });
});

describe("asset validation", () => {
  const png = (w: number, h: number) => ({ mime: "image/png", bytes: encodeRgbaPng(new Uint8ClampedArray(w * h * 4), w, h) });
  /** A 2 m square, its UVs covering `uvScale` of the texture, with maps of `size`. */
  const square = (uvScale: number, size: number, material: Partial<MeshMaterial> = {}, extra: Partial<MeshPrimitive> = {}): MeshAsset =>
    ({
      name: "crate_01",
      primitives: [
        {
          positions: Float32Array.from([0, 0, 0, 2, 0, 0, 2, 0, 2, 0, 0, 2]),
          normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
          uvs: Float32Array.from([0, 0, uvScale, 0, uvScale, uvScale, 0, uvScale]),
          indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
          material: { name: "crate", baseColorFactor: [1, 1, 1, 1], baseColorImage: png(size, size), ...material },
          ...extra,
        },
      ],
    }) as unknown as MeshAsset;
  const codes = (mesh: MeshAsset, options = {}) => validateMeshAsset(mesh, options).map((i) => i.code);

  it("reads an image's size from its header", () => {
    expect(encodedImageSize(png(64, 32).bytes)).toEqual({ width: 64, height: 32 });
    expect(encodedImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("measures texel density against the target", () => {
    // 1024² over 2 m: 512 texels a metre, on target.
    expect(codes(square(1, 1024, { normalImage: png(1024, 1024), metallicRoughnessImage: png(1024, 1024) }, { tangents: new Float32Array(16) }))).toEqual([]);
    expect(codes(square(1, 128))).toContain("texel-density-low");
    expect(codes(square(4, 1024))).toContain("texel-density-high");
  });

  it("flags names, missing UVs, half a PBR set, and a normal map without tangents", () => {
    const bad = square(1, 1024, { name: "my crate", normalImage: png(1024, 1024) });
    const found = codes(bad);
    expect(found).toContain("name");
    expect(found).toContain("missing-map");
    expect(found).toContain("missing-tangents");
    expect(codes(square(1, 1024, {}, { uvs: null }))).toContain("missing-uvs");
  });

  it("holds an asset to its triangle, texture memory and texture size budgets", () => {
    const mesh = square(1, 1024);
    expect(codes(mesh, { maxTriangles: 1 })).toContain("triangles");
    expect(codes(mesh, { maxTextureBytes: 1024 * 1024 })).toContain("texture-memory");
    expect(codes(mesh, { maxTextureSize: 512 })).toContain("texture-size");
    expect(validateMeshAsset(mesh, { maxTriangles: 1 }).find((i) => i.code === "triangles")!.severity).toBe("error");
  });
});

describe("uploads straight to storage", () => {
  const hash = sha256(new TextEncoder().encode("abc"));

  it("sends what is past the body limit direct, and checks it against the direct ceiling", () => {
    expect(uploadRoute(DIRECT_UPLOAD_THRESHOLD)).toBe("multipart");
    expect(uploadRoute(DIRECT_UPLOAD_THRESHOLD + 1)).toBe("direct");
    expect(checkAssetUpload("big.glb", hash, MAX_ASSET_BYTES + 1, "model/gltf-binary", EMPTY_CART_ASSETS, 1e9)?.reason).toBe("too-large");
    expect(checkAssetUpload("big.glb", hash, MAX_ASSET_BYTES + 1, "model/gltf-binary", EMPTY_CART_ASSETS, 1e9, MAX_DIRECT_ASSET_BYTES)).toBeNull();
    expect(checkAssetUpload("pack.cbpk", hash, 100, "application/vnd.cartbox.package", EMPTY_CART_ASSETS, 1e9)).toBeNull();
  });

  it("gives storage the hash as the base64 SHA-256 checksum it verifies", () => {
    expect(hashToBase64(hash)).toBe("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  });

  /** A fake server: the calls it saw, and its answers by URL and phase. */
  function server(dedupe: boolean) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      calls.push({ url, method: init.method ?? "GET", body });
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
      if (url === "https://r2/put") return new Response(null, { status: 200 });
      if (url.endsWith("/assets")) return json({ url: "https://cdn/small", deduplicated: false });
      const phase = (body as { phase: string }).phase;
      if (phase === "begin") return dedupe ? json({ url: "https://cdn/had", deduplicated: true }) : json({ upload: { url: "https://r2/put", headers: { "x-amz-checksum-sha256": "x" } } });
      return json({ url: "https://cdn/big" });
    };
    return { calls, fetchImpl };
  }

  it("goes begin → PUT to storage → commit for a large file", async () => {
    const { calls, fetchImpl } = server(false);
    const big = new Uint8Array(DIRECT_UPLOAD_THRESHOLD + 10);
    const result = await uploadCartAsset("cart1", "big.glb", big, hash, "model/gltf-binary", { Authorization: "Bearer t" }, fetchImpl);
    expect(result).toEqual({ ok: true, url: "https://cdn/big", deduplicated: false });
    expect(calls.map((c) => [c.url, c.method, (c.body as { phase?: string } | null)?.phase ?? null])).toEqual([
      ["/api/carts/cart1/assets/direct", "POST", "begin"],
      ["https://r2/put", "PUT", null],
      ["/api/carts/cart1/assets/direct", "POST", "commit"],
    ]);
  });

  it("sends nothing when the store already holds the bytes, and a small file through the API", async () => {
    const dedupe = server(true);
    expect(await uploadCartAsset("cart1", "big.glb", new Uint8Array(DIRECT_UPLOAD_THRESHOLD + 10), hash, "model/gltf-binary", {}, dedupe.fetchImpl)).toEqual({ ok: true, url: "https://cdn/had", deduplicated: true });
    expect(dedupe.calls).toHaveLength(1);
    const small = server(false);
    expect(await uploadCartAsset("cart1", "a.png", new Uint8Array(100), hash, "image/png", {}, small.fetchImpl)).toEqual({ ok: true, url: "https://cdn/small", deduplicated: false });
    expect(small.calls.map((c) => c.url)).toEqual(["/api/carts/cart1/assets"]);
  });
});
