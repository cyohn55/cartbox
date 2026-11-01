/**
 * The asset library's CC0 sources (AAA_FIDELITY_ROADMAP.md F9f): Poly Haven
 * and ambientCG searched, and their materials, HDRIs and models imported as
 * the tier wants them, with their credit — all against canned API answers,
 * no network.
 */

import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { decodePngRgba, encodeRgbaPng } from "@cartbox/editor";

import { ambientCgMaterialMaps, externalCredit, importExternalHdri, importExternalMaterial, importExternalMesh, parseAmbientCg, parsePolyHaven, polyHavenListUrl, polyHavenMaterialMaps, searchExternal } from "../apps/web/src/lib/externalLibraries";
import { readZip } from "../apps/web/src/lib/zipReader";
import { addCredit, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar } from "../apps/web/src/lib/meshSidecar";

/** A flat PNG of one grey level (or colour). */
const flat = (w: number, h: number, rgb: [number, number, number]) => encodeRgbaPng(Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? 255 : rgb[i % 4]!)), w, h);

/** A ZIP of named files: stored and deflated alternately. */
function zip(files: Record<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, data], k) => {
    const deflate = k % 2 === 1;
    const body = deflate ? new Uint8Array(deflateRawSync(data)) : data;
    const nameBytes = new TextEncoder().encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, deflate ? 8 : 0, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(10, deflate ? 8 : 0, true);
    dir.setUint32(20, body.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, body);
    central.push(new Uint8Array(dir.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  });
  const dirSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A fetch over a table of URLs. */
function fakeFetch(table: Record<string, unknown>) {
  const asked: string[] = [];
  const fetchImpl = async (url: string) => {
    asked.push(url);
    const value = table[url];
    if (value === undefined) return { ok: false, status: 404, json: async () => null, arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" };
    const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    return { ok: true, status: 200, json: async () => (value instanceof Uint8Array ? null : value), arrayBuffer: async () => bytes.slice().buffer, text: async () => new TextDecoder().decode(bytes) };
  };
  return { fetchImpl, asked };
}

const polyList = {
  rock_wall: { name: "Rock Wall", tags: ["Rock", "wall"], categories: ["natural"], authors: { "Rob Tuytel": "All" } },
  brick_floor: { name: "Brick Floor", tags: ["brick"], categories: ["floor"], authors: { "Dimitrios Savva": "All" } },
};

describe("search", () => {
  it("reads Poly Haven's listing, filtered by every word, with each asset's credit", async () => {
    const assets = parsePolyHaven(polyList, "material", "rock");
    expect(assets.map((a) => a.id)).toEqual(["rock_wall"]);
    expect(assets[0]!.provenance).toEqual({ source: "Poly Haven", author: "Rob Tuytel", license: "CC0-1.0", url: "https://polyhaven.com/a/rock_wall" });
    expect(parsePolyHaven(polyList, "material", "").map((a) => a.name)).toEqual(["Brick Floor", "Rock Wall"]);
    const { fetchImpl, asked } = fakeFetch({ [polyHavenListUrl("hdri")]: polyList });
    expect(await searchExternal("polyhaven", "hdri", "brick", fetchImpl)).toHaveLength(1);
    expect(asked[0]).toBe("https://api.polyhaven.com/assets?t=hdris");
    expect(externalCredit(assets[0]!)).toContain("Rob Tuytel (Poly Haven, CC0)");
  });

  it("reads ambientCG's results with their downloads", () => {
    const json = { foundAssets: [{ assetId: "Rock030", displayName: "Rock 030", tags: ["Rock"], previewImage: { "256-PNG": "https://x/rock.png" }, downloadFolders: { default: { downloadFiletypeCategories: { zip: { downloads: [{ attribute: "1K-PNG", fullDownloadPath: "https://x/Rock030_1K-PNG.zip" }] } } } } }] };
    const [rock] = parseAmbientCg(json, "material");
    expect(rock!.downloads).toEqual({ "1K-PNG": "https://x/Rock030_1K-PNG.zip" });
    expect(rock!.provenance.license).toBe("CC0-1.0");
    expect(ambientCgMaterialMaps(["Rock030_1K-PNG_Color.png", "Rock030_1K-PNG_NormalGL.png", "Rock030_1K-PNG_NormalDX.png", "Rock030_1K-PNG_Roughness.png", "x.usda"])).toEqual({
      color: "Rock030_1K-PNG_Color.png",
      normal: "Rock030_1K-PNG_NormalGL.png",
      roughness: "Rock030_1K-PNG_Roughness.png",
      occlusion: null,
      height: null,
    });
  });
});

describe("import", () => {
  it("reads a ZIP's stored and deflated entries", async () => {
    const files = await readZip(zip({ "a.txt": new TextEncoder().encode("hello"), "b.txt": new TextEncoder().encode("world world world") }));
    expect(new TextDecoder().decode(files.get("a.txt"))).toBe("hello");
    expect(new TextDecoder().decode(files.get("b.txt"))).toBe("world world world");
  });

  it("brings a Poly Haven material in: colour and normal, roughness and AO packed as glTF keeps them", async () => {
    const [asset] = parsePolyHaven(polyList, "material", "rock");
    const files = {
      Diffuse: { "1k": { png: { url: "https://dl/diff.png" } } },
      nor_gl: { "1k": { png: { url: "https://dl/nor.png" } } },
      Rough: { "1k": { png: { url: "https://dl/rough.png" } } },
      AO: { "1k": { png: { url: "https://dl/ao.png" } } },
    };
    expect(polyHavenMaterialMaps(files).height).toBeNull();
    const { fetchImpl } = fakeFetch({
      "https://api.polyhaven.com/files/rock_wall": files,
      "https://dl/diff.png": flat(4, 4, [200, 100, 50]),
      "https://dl/nor.png": flat(4, 4, [128, 128, 255]),
      "https://dl/rough.png": flat(4, 4, [180, 180, 180]),
      "https://dl/ao.png": flat(4, 4, [90, 90, 90]),
    });
    const material = await importExternalMaterial(asset!, fetchImpl);
    expect(material.name).toBe("Rock Wall");
    expect(material.baseColorImage!.mime).toBe("image/png");
    expect(material.normalImage).toBeTruthy();
    const mr = await decodePngRgba(material.metallicRoughnessImage!.bytes);
    expect([mr.data[0], mr.data[1], mr.data[2]]).toEqual([90, 180, 0]);
    expect(material.occlusionImage).toBe(material.metallicRoughnessImage);
    expect(material.roughnessFactor).toBe(1);
  });

  it("brings an ambientCG material in from its ZIP", async () => {
    const json = { foundAssets: [{ assetId: "Rock030", displayName: "Rock 030", downloadFolders: { default: { downloadFiletypeCategories: { zip: { downloads: [{ attribute: "1K-PNG", fullDownloadPath: "https://x/r.zip" }] } } } } }] };
    const [asset] = parseAmbientCg(json, "material");
    const archive = zip({ "Rock030_1K-PNG_Color.png": flat(2, 2, [10, 20, 30]), "Rock030_1K-PNG_Roughness.png": flat(2, 2, [77, 77, 77]), "Rock030_1K-PNG_Displacement.png": flat(2, 2, [128, 128, 128]) });
    const { fetchImpl } = fakeFetch({ "https://x/r.zip": archive });
    const material = await importExternalMaterial(asset!, fetchImpl);
    const mr = await decodePngRgba(material.metallicRoughnessImage!.bytes);
    expect([mr.data[0], mr.data[1]]).toEqual([255, 77]); // no AO: full
    expect(material.reliefImage).toBeTruthy();
    // A resolution it doesn't have is a clear error.
    await expect(importExternalMaterial(asset!, fetchImpl, "4k")).rejects.toThrow(/4K-PNG/);
  });

  it("brings an HDRI in as the sky's Radiance panorama", async () => {
    const [asset] = parsePolyHaven({ sky_1: { name: "Sky 1" } }, "hdri");
    const hdr = new TextEncoder().encode("#?RADIANCE\n");
    const { fetchImpl } = fakeFetch({ "https://api.polyhaven.com/files/sky_1": { hdri: { "1k": { hdr: { url: "https://dl/sky.hdr" } } } }, "https://dl/sky.hdr": hdr });
    const out = await importExternalHdri(asset!, fetchImpl);
    expect(out.mime).toBe("image/vnd.radiance");
    expect([...out.bytes]).toEqual([...hdr]);
  });

  it("brings a Poly Haven model in, with its buffers and textures fetched beside it", async () => {
    const [asset] = parsePolyHaven({ crate: { name: "Crate" } }, "mesh");
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const bin = new Uint8Array(positions.buffer);
    const gltf = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ source: 0 }],
      images: [{ uri: "textures/crate_diff.png" }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
      bufferViews: [{ buffer: 0, byteLength: bin.length }],
      buffers: [{ uri: "crate.bin", byteLength: bin.length }],
    };
    const { fetchImpl, asked } = fakeFetch({
      "https://api.polyhaven.com/files/crate": { gltf: { "1k": { gltf: { url: "https://dl/crate.gltf", include: { "crate.bin": { url: "https://dl/crate.bin" }, "textures/crate_diff.png": { url: "https://dl/diff.png" } } } } } },
      "https://dl/crate.gltf": gltf,
      "https://dl/crate.bin": bin,
      "https://dl/diff.png": flat(2, 2, [1, 2, 3]),
    });
    const mesh = await importExternalMesh(asset!, fetchImpl);
    expect(mesh.primitives[0]!.positions.length).toBe(9);
    expect(mesh.primitives[0]!.material.baseColorImage?.mime).toBe("image/png");
    expect(asked).toContain("https://dl/diff.png");
  });
});

describe("credits", () => {
  it("keeps each imported asset's credit with the cart, once, through a save", () => {
    const [asset] = parsePolyHaven({ rock: { name: "Rock", authors: { "Jane Doe": "All" } } }, "material");
    const line = externalCredit(asset!);
    let sidecar = addCredit(emptyMeshSidecar(), line);
    sidecar = addCredit(sidecar, line);
    expect(sidecar.credits).toEqual([line]);
    const back = decodeMeshSidecar(encodeMeshSidecar(sidecar));
    expect(back.credits).toEqual([line]);
    // Credits alone are worth saving; none, and there's nothing to save.
    expect(encodeMeshSidecar(emptyMeshSidecar())).toBeNull();
  });
});
