/**
 * Profiler and content browser (EDITOR_PRO_ROADMAP.md P8): per-device
 * budgets that flag an over-budget scene line by line; image sizes read from
 * PNG, JPEG and KTX2 headers; a scene's load as stored (triangles, draw
 * calls, mesh and texture memory) and the player's memory split by kind; LOD
 * deviation measured against each level's error budget; and the content
 * browser's tags.
 */

import { describe, expect, it } from "vitest";

import {
  DEVICE_BUDGETS,
  checkBudget,
  encodeRgbaPng,
  formatBudgetValue,
  generateLods,
  imageSize,
  lodDeviation,
  lodErrorBudget,
  newTerrain,
  overBudget,
  serializeTerrain,
  smallestFit,
  textureGpuBytes,
  type MeshAsset,
} from "@cartbox/editor";
import { estimateSceneMemory } from "@cartbox/player";

import { cleanTags, collectAssets, filterAssets, setAssetTags, tagsInUse } from "../apps/web/src/lib/contentBrowser";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { sceneLoadOf } from "../apps/web/src/lib/sceneBudget";

const MB = 1024 * 1024;

function material(image: Uint8Array | null = null) {
  return { name: "m", baseColorFactor: [1, 1, 1, 1] as [number, number, number, number], baseColorImage: image ? { mime: "image/png", bytes: image } : null, metallicFactor: 0, roughnessFactor: 1 };
}

/** A unit cube, one primitive, with an optional texture. */
function cube(image: Uint8Array | null = null): MeshAsset {
  const positions: number[] = [];
  for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) positions.push(x, y, z);
  const indices = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  return { name: "cube", primitives: [{ positions: Float32Array.from(positions), normals: null, uvs: null, indices: Uint32Array.from(indices), material: material(image) }] };
}

/** A UV sphere of `segments` × `rings`. */
function sphere(segments = 64, rings = 32): MeshAsset {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r += 1) {
    const v = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s += 1) {
      const u = (s / segments) * Math.PI * 2;
      positions.push(Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u));
    }
  }
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = r * (segments + 1) + s;
      indices.push(a, a + segments + 1, a + 1, a + 1, a + segments + 1, a + segments + 2);
    }
  }
  return { name: "sphere", primitives: [{ positions: Float32Array.from(positions), normals: null, uvs: null, indices: Uint32Array.from(indices), material: material() }] };
}

/** A rolling 10 m patch of ground, n × n quads. */
function rolling(n = 48): MeshAsset {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= n; j += 1) for (let i = 0; i <= n; i += 1) positions.push((i / n) * 10, Math.sin(i * 0.4) * Math.cos(j * 0.3) * 0.6, (j / n) * 10);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const a = j * (n + 1) + i;
      indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
    }
  }
  return { name: "rolling", primitives: [{ positions: Float32Array.from(positions), normals: null, uvs: null, indices: Uint32Array.from(indices), material: material() }] };
}

describe("per-device budgets", () => {
  it("checks each known line, and flags what's over", () => {
    const load = { triangles: 500_000, drawCalls: 200, textureBytes: 100 * MB };
    const lines = checkBudget(load, "iphone");
    expect(lines.map((l) => l.key)).toEqual(["triangles", "drawCalls", "textureBytes"]);
    expect(overBudget(load, "iphone").map((l) => l.key)).toEqual(["triangles"]);
    expect(overBudget(load, "ipad")).toEqual([]);
    expect(lines[0]!.text).toBe("500k of 400k");
    expect(smallestFit(load)).toBe("ipad");
    expect(smallestFit({ triangles: 10 })).toBe("iphone");
    expect(smallestFit({ drawCalls: 1e6 })).toBeNull();
  });

  it("orders the devices from small to large on every line", () => {
    for (const key of ["triangles", "drawCalls", "textureBytes", "meshBytes", "downloadBytes"] as const) {
      expect(DEVICE_BUDGETS.iphone[key]).toBeLessThan(DEVICE_BUDGETS.ipad[key]);
      expect(DEVICE_BUDGETS.ipad[key]).toBeLessThan(DEVICE_BUDGETS.desktop[key]);
    }
    expect(DEVICE_BUDGETS.iphone.frameMs).toBeGreaterThan(DEVICE_BUDGETS.desktop.frameMs);
    expect(formatBudgetValue("frameMs", 16.666)).toBe("16.7 ms");
    expect(formatBudgetValue("textureBytes", 3 * MB)).toBe("3.0 MB");
  });
});

describe("image sizes from headers", () => {
  it("reads a PNG's, a JPEG's and a KTX2's", () => {
    expect(imageSize(encodeRgbaPng(new Uint8Array(37 * 19 * 4), 37, 19))).toEqual({ width: 37, height: 19 });
    // A JPEG: SOI, an APP0 segment, then SOF0 with 120 × 200.
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xc8, 0x00, 0x78, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 120, height: 200 });
    const ktx2 = new Uint8Array(80);
    ktx2.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(ktx2.buffer).setUint32(20, 512, true);
    new DataView(ktx2.buffer).setUint32(24, 256, true);
    expect(imageSize(ktx2)).toEqual({ width: 512, height: 256 });
    expect(imageSize(Uint8Array.from([1, 2, 3]))).toBeNull();
    expect(textureGpuBytes(64, 64)).toBe(Math.round((64 * 64 * 4 * 4) / 3));
  });
});

describe("a scene's load", () => {
  it("counts triangles and draw calls per copy, meshes and textures once, and terrain", () => {
    const png = encodeRgbaPng(new Uint8Array(64 * 64 * 4), 64, 64);
    let sidecar = addMesh(emptyMeshSidecar(), cube(png), "a").sidecar;
    sidecar = { ...sidecar, meshes: [...sidecar.meshes, { ...sidecar.meshes[0]!, id: "copy" }] };
    const load = sceneLoadOf(sidecar);
    expect(load.triangles).toBe(24);
    expect(load.drawCalls).toBe(2);
    expect(load.meshBytes).toBe(8 * 32 + 36 * 4);
    expect(load.textureBytes).toBe(textureGpuBytes(64, 64));
    expect(load.downloadBytes).toBeGreaterThan(0);
    const t = newTerrain("t", { size: 16, samples: 17 });
    const withGround = sceneLoadOf({ ...sidecar, terrains: [serializeTerrain(t)] });
    expect(withGround.triangles).toBe(24 + 16 * 16 * 2);
    expect(withGround.drawCalls).toBeGreaterThan(2);
  });

  it("flags a heavy scene on a phone but not on a desktop", () => {
    const heavy = sphere(256, 128); // 65,536 triangles
    let sidecar = addMesh(emptyMeshSidecar(), heavy, "boulder").sidecar;
    const base = sidecar.meshes[0]!;
    sidecar = { ...sidecar, meshes: Array.from({ length: 8 }, (_, i) => ({ ...base, id: `b${i}` })) };
    const load = sceneLoadOf(sidecar);
    expect(load.triangles).toBe(8 * 65_536);
    expect(overBudget(load, "iphone").map((l) => l.key)).toContain("triangles");
    expect(overBudget(load, "desktop")).toEqual([]);
  });

  it("splits the player's scene memory by kind, every map counted once", () => {
    const a = { width: 32, height: 32 };
    const n = { width: 64, height: 64 };
    const mesh = cube();
    const memory = estimateSceneMemory(
      [
        { mesh, textures: [a], normalTextures: [n] },
        { mesh, textures: [a], normalTextures: [n] },
      ],
      100,
      50,
    );
    expect(memory.meshes).toBe(8 * 32 + 36 * 4);
    expect(memory.textures).toBe(textureGpuBytes(32, 32) + textureGpuBytes(64, 64));
    expect(memory.targets).toBe(100 * 50 * 8);
  });
});

describe("LOD error bounds", () => {
  it("measures nothing for a mesh against itself, and a dropped part for what it is", () => {
    const m = rolling(8);
    expect(lodDeviation(m, m)).toBeCloseTo(0, 6);
    // Half the patch gone: its far corner is about 5 m from what's left.
    const half: MeshAsset = { ...m, primitives: [{ ...m.primitives[0]!, indices: m.primitives[0]!.indices.slice(0, m.primitives[0]!.indices.length / 2) }] };
    expect(lodDeviation(m, half)).toBeGreaterThan(4);
  });

  it("keeps every default level within its error budget", () => {
    for (const mesh of [sphere(), rolling()]) {
      const chain = generateLods(mesh)!;
      expect(chain.meshes.length).toBeGreaterThan(0);
      chain.meshes.forEach((level, i) => {
        const deviation = lodDeviation(mesh, level);
        expect(deviation).toBeGreaterThan(0);
        expect(deviation).toBeLessThanOrEqual(lodErrorBudget(mesh, i));
      });
    }
  });
});

describe("content browser tags", () => {
  it("cleans tags, stores them on the scene, and finds assets by them", () => {
    expect(cleanTags(["Rock", "#forerunner", "big rock", "rock", ""])).toEqual(["rock", "forerunner", "big-rock"]);
    let sidecar = addMesh(emptyMeshSidecar(), cube(), "boulder").sidecar;
    sidecar = addMesh(sidecar, sphere(8, 4), "orb").sidecar;
    const [boulder] = collectAssets(sidecar).filter((a) => a.name.includes("boulder") || a.kind === "mesh");
    sidecar = setAssetTags(sidecar, boulder!, ["rock", "Cliff"]);
    // Through storage.
    sidecar = decodeMeshSidecar(encodeMeshSidecar(sidecar)!);
    const assets = collectAssets(sidecar);
    expect(assets.find((a) => a.key === boulder!.key)?.tags).toEqual(["rock", "cliff"]);
    expect(filterAssets(assets, "all", "#rock").map((a) => a.key)).toEqual([boulder!.key]);
    expect(filterAssets(assets, "all", "#rock #nope")).toEqual([]);
    expect(filterAssets(assets, "mesh", "cliff").map((a) => a.key)).toEqual([boulder!.key]);
    expect(tagsInUse(assets)).toEqual(["cliff", "rock"]);
    // Untagging removes its entry, and the table with it.
    expect(setAssetTags(sidecar, boulder!, []).assetTags).toBeUndefined();
  });
});
