/**
 * Sidecars as packages (AAA_PRODUCTION_ROADMAP.md D4): a saved mesh sidecar's
 * meshes move into the cart asset store as `.cbpk` packages, and come back as
 * the JSON every reader already parses. The round trip must be lossless (the
 * package now carries what it used to drop: asset refs, KTX2 twins, shared
 * images, morph targets, the cluster hierarchy), old inline sidecars must read
 * unchanged, and a missing package must cost its objects, never the cart.
 */
import { describe, expect, it } from "vitest";
import {
  deserializeMeshAsset,
  lockoutMeshSidecar,
  packMeshAsset,
  serializeMeshAsset,
  unpackMeshAsset,
  withClusterLods,
  type EncodedImage,
  type MeshAsset,
  type MeshMaterial,
} from "@cartbox/editor";
import { hashAsset } from "@/lib/cartAssetStore";
import { decodeMeshSidecar } from "@/lib/meshSidecar";
import { extractMeshTextures, inlineMeshTextures } from "@/lib/meshTextureAssets";
import { PACKAGE_MIME, extractMeshPackages, inlineMeshPackages, loadMeshoptCodec, meshPackageRefs } from "@/lib/meshPackages";

/** An n×n grid of quads with UVs and normals: big enough to package, and (at 104) to cluster. */
function grid(n: number, material: MeshMaterial): MeshAsset {
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= n; j += 1) for (let i = 0; i <= n; i += 1) {
    positions.push(i / n, Math.sin(i * 0.3) * Math.cos(j * 0.2) * 0.1, j / n);
    uvs.push(i / n, j / n);
    normals.push(0, 1, 0);
  }
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) {
    const a = j * (n + 1) + i;
    indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
  }
  return { name: `grid${n}`, primitives: [{ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material }] };
}

const bytes = (seed: number, length = 96) => Uint8Array.from({ length }, (_, i) => (i * 13 + seed) & 255);
const plain = (name = "m"): MeshMaterial => ({ name, baseColorFactor: [1, 1, 1, 1], baseColorImage: { mime: "image/png", bytes: bytes(1) } });

/** A mesh's canonical form: what the JSON codec writes for it. */
const canonical = (mesh: MeshAsset) => serializeMeshAsset(mesh);

/** A store over a map, and the map. */
function store() {
  const blobs = new Map<string, Uint8Array>();
  return { blobs, fetch: async (hash: string) => blobs.get(hash) ?? null, put: (items: readonly { hash: string; bytes: Uint8Array }[]) => items.forEach((t) => blobs.set(t.hash, t.bytes)) };
}

describe("the package codec, for what a sidecar's meshes carry (D4)", () => {
  it("keeps asset refs, KTX2 twins, a shared image as one, and morph targets", async () => {
    const shared: EncodedImage = { mime: "image/png", bytes: bytes(5), ktx2: bytes(9, 40), ktx2Relief: true };
    const material = {
      name: "rock",
      baseColorFactor: [1, 1, 1, 1],
      baseColorImage: { mime: "image/png", bytes: new Uint8Array(0), ref: "a".repeat(64) },
      normalImage: { mime: "image/png", bytes: bytes(3), ktx2: bytes(4, 32) },
      metallicRoughnessImage: shared,
      occlusionImage: shared,
    } as MeshMaterial;
    const base = grid(8, material);
    const p = base.primitives[0]!;
    const mesh: MeshAsset = { ...base, morphWeights: [0.25], primitives: [{ ...p, morphTargets: [{ name: "bulge", positions: p.positions.map((_, i) => (i % 3 === 1 ? 0.5 : 0)) }] }] };
    const codec = await loadMeshoptCodec();
    expect(codec).not.toBeNull(); // the codec loads under Node, as on the server
    const out = unpackMeshAsset(packMeshAsset(mesh, codec), codec);
    const m = out.primitives[0]!.material;
    expect(m.baseColorImage).toEqual({ mime: "image/png", bytes: new Uint8Array(0), ref: "a".repeat(64) });
    expect(Array.from(m.normalImage!.ktx2!)).toEqual(Array.from(bytes(4, 32)));
    expect(m.metallicRoughnessImage).toBe(m.occlusionImage);
    expect(m.occlusionImage!.ktx2Relief).toBe(true);
    expect(out.primitives[0]!.morphTargets?.[0]?.name).toBe("bulge");
    expect(out.morphWeights).toEqual([0.25]);
    expect(canonical(out)).toBe(canonical(mesh));
  });

  it("keeps a dense mesh's cluster hierarchy", async () => {
    const mesh = withClusterLods(grid(104, plain()));
    expect(mesh.primitives[0]!.clusterLod).toBeDefined();
    const codec = await loadMeshoptCodec();
    const packed = packMeshAsset(mesh, codec);
    const out = unpackMeshAsset(packed, codec);
    expect(out.primitives[0]!.clusterLod).toBeDefined();
    expect(canonical(out)).toBe(canonical(mesh));
    expect(packed.byteLength).toBeLessThan(canonical(mesh).length / 2); // binary and squeezed, against base64 JSON
  });
});

describe("a sidecar's meshes as packages (D4)", () => {
  const big = serializeMeshAsset(grid(24, plain("big")));
  const frame = serializeMeshAsset(grid(20, plain("frame")));
  const lod = serializeMeshAsset(grid(12, plain("lod")));
  const small = serializeMeshAsset(grid(1, { name: "s", baseColorFactor: [1, 0, 0, 1], baseColorImage: null }));
  const sidecar = () =>
    JSON.stringify({
      version: 1,
      meshes: [
        { id: "a", name: "A", mesh: big, frames: [big, frame], lods: { distances: [20], levels: [lod] } },
        { id: "b", name: "B", mesh: "@lib:shared" },
        { id: "c", name: "C", mesh: small },
      ],
      library: { shared: big },
      prefabs: [{ id: "p", name: "P", nodes: [{ mesh: frame }] }],
      lighting: null,
    });

  it("packages each distinct mesh once, in every place a sidecar keeps one, and reads back the same", async () => {
    const encoded = sidecar();
    const codec = await loadMeshoptCodec();
    const out = await extractMeshPackages(encoded, hashAsset, codec);
    expect(out.packages.map((p) => p.mime)).toEqual([PACKAGE_MIME, PACKAGE_MIME, PACKAGE_MIME]); // big, frame, lod
    expect(out.encoded.length).toBeLessThan(encoded.length / 10);
    const stored = JSON.parse(out.encoded);
    expect(stored.meshes[1].mesh).toBe("@lib:shared"); // a library reference stays one
    expect(stored.meshes[2].mesh).toBe(small); // too small to be worth a request
    expect(stored.library.shared).toBe(stored.meshes[0].mesh);
    expect(meshPackageRefs(out.encoded)).toHaveLength(3);

    const s = store();
    s.put(out.packages);
    const back = JSON.parse(await inlineMeshPackages(out.encoded, s.fetch, codec));
    const original = JSON.parse(encoded);
    const same = (a: string, b: string) => expect(canonical(deserializeMeshAsset(a))).toBe(canonical(deserializeMeshAsset(b)));
    same(back.meshes[0].mesh, original.meshes[0].mesh);
    same(back.meshes[0].frames[1], original.meshes[0].frames[1]);
    same(back.meshes[0].lods.levels[0], original.meshes[0].lods.levels[0]);
    same(back.library.shared, original.library.shared);
    same(back.prefabs[0].nodes[0].mesh, original.prefabs[0].nodes[0].mesh);
    expect(back.meshes[2].mesh).toBe(small);
    expect(decodeMeshSidecar(JSON.stringify(back)).meshes).toHaveLength(3);
  });

  it("follows the texture offload: images stay asset refs inside the package, and inline after", async () => {
    const encoded = sidecar();
    const codec = await loadMeshoptCodec();
    const textures = await extractMeshTextures(encoded, hashAsset);
    expect(textures.textures.length).toBeGreaterThan(0);
    const packaged = await extractMeshPackages(textures.encoded, hashAsset, codec);
    // The package holds the geometry, not the images.
    for (const p of packaged.packages) expect(unpackMeshAsset(p.bytes, codec).primitives[0]!.material.baseColorImage!.bytes.length).toBe(0);
    const s = store();
    s.put([...textures.textures, ...packaged.packages]);
    const meshesBack = await inlineMeshPackages(packaged.encoded, s.fetch, codec);
    expect(JSON.parse(meshesBack).meshes[0].mesh).toContain('"asset"'); // refs back in the stored form the texture inlining reads
    const back = JSON.parse(await inlineMeshTextures(meshesBack, s.fetch));
    const original = JSON.parse(encoded);
    expect(canonical(deserializeMeshAsset(back.meshes[0].mesh))).toBe(canonical(deserializeMeshAsset(original.meshes[0].mesh)));
  });

  it("reads an old inline sidecar unchanged, and drops only the objects whose package is missing", async () => {
    const encoded = sidecar();
    const codec = await loadMeshoptCodec();
    expect(await inlineMeshPackages(encoded, async () => null, codec)).toBe(encoded);
    const out = await extractMeshPackages(encoded, hashAsset, codec);
    const s = store();
    s.put(out.packages.slice(1)); // the first (the big mesh) is gone
    const back = await inlineMeshPackages(out.encoded, s.fetch, codec);
    const decoded = decodeMeshSidecar(back);
    expect(decoded.meshes.map((m) => m.id)).toEqual(["c"]); // A and B used the lost mesh; C never did
    const failing = await inlineMeshPackages(out.encoded, async () => { throw new Error("storage down"); }, codec);
    expect(decodeMeshSidecar(failing).meshes.map((m) => m.id)).toEqual(["c"]);
  });

  it("packages a real map's sidecar, losslessly", async () => {
    const encoded = lockoutMeshSidecar();
    const codec = await loadMeshoptCodec();
    const out = await extractMeshPackages(encoded, hashAsset, codec);
    expect(out.packages.length).toBeGreaterThan(5);
    const s = store();
    s.put(out.packages);
    const stored = out.encoded.length + out.packages.reduce((n, p) => n + p.bytes.byteLength, 0);
    expect(stored).toBeLessThan(encoded.length); // smaller in all, as well as off the row
    const back = await inlineMeshPackages(out.encoded, s.fetch, codec);
    const a = decodeMeshSidecar(encoded).meshes;
    const b = decodeMeshSidecar(back).meshes;
    expect(b.map((m) => m.id)).toEqual(a.map((m) => m.id));
    const checked = new Set<string>();
    a.forEach((entry, i) => {
      if (checked.has(entry.mesh)) return;
      checked.add(entry.mesh);
      expect(canonical(deserializeMeshAsset(b[i]!.mesh))).toBe(canonical(deserializeMeshAsset(entry.mesh)));
    });
  }, 120_000);
});
