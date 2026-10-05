/**
 * Baked lighting (HALO2_STYLE_ROADMAP.md, H1): the light-map unwrap, the bake
 * (sky visibility + sun bounce), the stored form (second UV set, one shared
 * PNG), the software rasteriser sampling it, Lockout's stored bake, and the
 * editor's scene bake.
 */

import { describe, expect, it } from "vitest";

import {
  defaultSceneLighting,
  LIGHTMAP_RANGE,
  applyLightmapImage,
  bakeLightmap,
  composeModelMatrix,
  deserializeMeshAsset,
  layoutFingerprint,
  layoutLightmap,
  lockoutMapLayout,
  lockoutMeshSidecar,
  projectionMatrix,
  renderMeshScene,
  serializeMeshAsset,
  viewMatrix,
  withLightmap,
  type DecodedTexture,
  type MeshAsset,
} from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";

import { bakeSceneLighting, clearSceneLighting, lightingStats } from "../apps/web/src/lib/lightBake";
import { addMesh, emptyMeshSidecar, setMeshTransform } from "../apps/web/src/lib/meshSidecar";
import { extractMeshTextures, inlineMeshTextures } from "../apps/web/src/lib/meshTextureAssets";
import { LOCKOUT_LIGHTMAP } from "../packages/editor/src/model/lockoutLightmap.generated";

type Material = MeshAsset["primitives"][number]["material"];
const GREY: Material = { name: "grey", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 };
const IDENTITY = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);

/** An axis-aligned box from `min` to `max`, faces wound outward, one primitive. */
function box(min: [number, number, number], max: [number, number, number], material: Material = GREY): MeshAsset {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const faces: { n: [number, number, number]; v: [number, number, number][] }[] = [
    { n: [0, 1, 0], v: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]] },
    { n: [0, -1, 0], v: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
    { n: [1, 0, 0], v: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]] },
    { n: [-1, 0, 0], v: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    { n: [0, 0, 1], v: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
    { n: [0, 0, -1], v: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const v of face.v) {
      positions.push(...v);
      normals.push(...face.n);
      uvs.push(0, 0);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    name: "box",
    primitives: [
      { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material },
    ],
  };
}

/** A floor slab (top at y=0) with a low roof over its -X half, as one mesh. */
function shelter(): MeshAsset {
  const floor = box([-4, -0.2, -4], [4, 0, 4]);
  const roof = box([-4, 1, -4], [0, 1.2, 4], { ...GREY, name: "roof" });
  return { name: "shelter", primitives: [...floor.primitives, ...roof.primitives] };
}

/** A PNG's width, from its header. */
const pngWidth = (png: Uint8Array): number => new DataView(png.buffer, png.byteOffset).getUint32(16);

/**
 * The baked light at (x, z) on a horizontal face of primitive `prim` — its top
 * face (`up`) or bottom face — read from the texel its light-map UV lands on.
 */
function faceLight(layout: ReturnType<typeof layoutLightmap>, rgba: Uint8ClampedArray, x: number, z: number, prim = 0, up = true): number {
  const floor = layout.mesh.primitives[prim]!;
  // Find the face's triangle containing (x, z) and interpolate its uvs2.
  for (let t = 0; t < floor.indices.length; t += 3) {
    const [a, b, c] = [floor.indices[t]!, floor.indices[t + 1]!, floor.indices[t + 2]!];
    if (floor.normals![a * 3 + 1]! * (up ? 1 : -1) < 0.9) continue;
    const P = (i: number) => [floor.positions[i * 3]!, floor.positions[i * 3 + 2]!] as const;
    const [pa, pb, pc] = [P(a), P(b), P(c)];
    const det = (pb[1] - pc[1]) * (pa[0] - pc[0]) + (pc[0] - pb[0]) * (pa[1] - pc[1]);
    const w0 = ((pb[1] - pc[1]) * (x - pc[0]) + (pc[0] - pb[0]) * (z - pc[1])) / det;
    const w1 = ((pc[1] - pa[1]) * (x - pc[0]) + (pa[0] - pc[0]) * (z - pc[1])) / det;
    const w2 = 1 - w0 - w1;
    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
    const uv = floor.uvs2!;
    const u = w0 * uv[a * 2]! + w1 * uv[b * 2]! + w2 * uv[c * 2]!;
    const v = w0 * uv[a * 2 + 1]! + w1 * uv[b * 2 + 1]! + w2 * uv[c * 2 + 1]!;
    const px = Math.min(layout.size - 1, Math.floor(u * layout.size));
    const py = Math.min(layout.size - 1, Math.floor((1 - v) * layout.size));
    return rgba[(py * layout.size + px) * 4]!;
  }
  throw new Error(`no floor at ${x}, ${z}`);
}

describe("light-map layout", () => {
  it("gives every primitive a second UV set inside the atlas", () => {
    const layout = layoutLightmap(shelter(), IDENTITY, { density: 4 });
    expect(layout.size & (layout.size - 1)).toBe(0); // a power of two
    for (const p of layout.mesh.primitives) {
      expect(p.uvs2).toBeDefined();
      expect(p.uvs2!.length).toBe((p.positions.length / 3) * 2);
      for (const u of p.uvs2!) {
        expect(u).toBeGreaterThanOrEqual(0);
        expect(u).toBeLessThanOrEqual(1);
      }
    }
  });

  it("lowers the density when the charts would not fit the largest atlas", () => {
    const roomy = layoutLightmap(shelter(), IDENTITY, { density: 8, maxSize: 1024 });
    const tight = layoutLightmap(shelter(), IDENTITY, { density: 8, maxSize: 64 });
    expect(tight.size).toBeLessThanOrEqual(64);
    expect(tight.density).toBeLessThan(roomy.density);
  });

  it("fingerprints the geometry and light-map UVs, so a stale bake is caught", () => {
    const a = layoutLightmap(shelter(), IDENTITY, { density: 4 });
    const b = layoutLightmap(shelter(), IDENTITY, { density: 4 });
    const moved = layoutLightmap(box([-4, -0.2, -4], [4, 0.1, 4]), IDENTITY, { density: 4 });
    expect(layoutFingerprint(a)).toBe(layoutFingerprint(b));
    expect(layoutFingerprint(moved)).not.toBe(layoutFingerprint(a));
  });
});

describe("light-map bake", () => {
  const mesh = shelter();
  const layout = layoutLightmap(mesh, IDENTITY, { density: 3 });
  const rgba = bakeLightmap(layout, [{ mesh: layout.mesh, model: IDENTITY }], { rays: 32, distance: 6 });

  it("darkens floor under the roof against floor open to the sky", () => {
    const sheltered = faceLight(layout, rgba, -2, 0);
    const open = faceLight(layout, rgba, 2.5, 0);
    expect(open).toBeGreaterThan(sheltered + 40);
  });

  it("is deterministic (same inputs, same bytes)", () => {
    const again = bakeLightmap(layout, [{ mesh: layout.mesh, model: IDENTITY }], { rays: 32, distance: 6 });
    expect(Buffer.from(again).equals(Buffer.from(rgba))).toBe(true);
  });

  it("lets a sunlit floor bounce light up onto the roof's underside", () => {
    // Sun from +X, above: it lights the floor, which bounces up under the roof.
    const sun = bakeLightmap(layout, [{ mesh: layout.mesh, model: IDENTITY }], { rays: 32, distance: 6, sun: [0.6, 0.8, 0], bounce: 1 });
    const under = (map: Uint8ClampedArray) => faceLight(layout, map, -0.5, 0, 1, false);
    expect(under(sun)).toBeGreaterThan(under(rgba) + 5);
  });

  it("reports progress up to done", () => {
    const seen: number[] = [];
    bakeLightmap(layoutLightmap(box([0, 0, 0], [1, 1, 1]), IDENTITY, { density: 2 }), [], { rays: 4 }, (d) => seen.push(d));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBeCloseTo(1, 5);
  });
});

describe("light-map stored form", () => {
  const layout = layoutLightmap(shelter(), IDENTITY, { density: 3 });
  const lit = withLightmap(layout, bakeLightmap(layout, [], { rays: 4 }));

  it("puts one PNG light map on every primitive", () => {
    const image = lit.primitives[0]!.material.lightmapImage!;
    expect(image.mime).toBe("image/png");
    expect(pngWidth(image.bytes)).toBe(layout.size);
    for (const p of lit.primitives) expect(p.material.lightmapImage).toBe(image);
  });

  it("round-trips the second UV set and the light map, storing the shared image once", () => {
    const json = serializeMeshAsset(lit);
    const png = Buffer.from(lit.primitives[0]!.material.lightmapImage!.bytes).toString("base64");
    expect(json.split(png).length - 1).toBe(1);
    const back = deserializeMeshAsset(json);
    back.primitives.forEach((p, i) => {
      expect(Array.from(p.uvs2!)).toEqual(Array.from(lit.primitives[i]!.uvs2!));
      expect(Array.from(p.material.lightmapImage!.bytes)).toEqual(Array.from(lit.primitives[0]!.material.lightmapImage!.bytes));
    });
    // Still one object after the round trip, so a renderer decodes it once.
    expect(back.primitives[1]!.material.lightmapImage).toBe(back.primitives[0]!.material.lightmapImage);
  });

  it("keeps separate images separate", () => {
    const a = { mime: "image/png", bytes: Uint8Array.from([1, 2, 3]) };
    const b = { mime: "image/png", bytes: Uint8Array.from([4, 5, 6]) };
    const two = { ...shelter(), primitives: shelter().primitives.map((p, i) => ({ ...p, material: { ...p.material, baseColorImage: i === 0 ? a : b } })) };
    const back = deserializeMeshAsset(serializeMeshAsset(two));
    expect(Array.from(back.primitives[0]!.material.baseColorImage!.bytes)).toEqual([1, 2, 3]);
    expect(Array.from(back.primitives[1]!.material.baseColorImage!.bytes)).toEqual([4, 5, 6]);
  });

  it("survives the asset store: one texture offloaded, the shared reference kept", async () => {
    const store = new Map<string, Uint8Array>();
    const hash = async (bytes: Uint8Array) => {
      const key = `h${store.size}`;
      store.set(key, bytes);
      return key;
    };
    const { encoded, textures } = await extractMeshTextures(serializeMeshAsset(lit), hash);
    expect(textures.length).toBe(1);
    const back = deserializeMeshAsset(await inlineMeshTextures(encoded, async (h) => store.get(h) ?? null));
    const image = back.primitives[0]!.material.lightmapImage!;
    expect(image.bytes.length).toBeGreaterThan(0);
    for (const p of back.primitives) expect(p.material.lightmapImage).toBe(image);
  });

  it("drops a reference to a slot that was never written", () => {
    const json = JSON.parse(serializeMeshAsset(box([0, 0, 0], [1, 1, 1])));
    json.primitives[0].material.lightmapImage = { mime: "image/png", same: "7.image" };
    expect(deserializeMeshAsset(JSON.stringify(json)).primitives[0]!.material.lightmapImage).toBeNull();
  });
});

describe("rasteriser light map", () => {
  const SIZE = 32;
  const quad: MeshAsset = {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        uvs2: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: GREY,
      },
    ],
  };
  const texel = (v: number): DecodedTexture => ({ width: 1, height: 1, data: Uint8ClampedArray.from([v, v, v, 255]) });
  const centre = (lightmap: DecodedTexture | null): number => {
    const out = new Uint8ClampedArray(SIZE * SIZE * 4);
    renderMeshScene([{ mesh: quad, model: IDENTITY, lightmapTextures: [lightmap] }], {
      width: SIZE,
      height: SIZE,
      out,
      depth: new Float32Array(SIZE * SIZE),
      view: viewMatrix([0, 0, 5], [0, 0, 0]),
      projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
      lightDirection: [0, 0, -1], // turned away: only ambient reaches the face
      ambient: 0.4,
    });
    return out[((SIZE >> 1) * SIZE + (SIZE >> 1)) * 4]!;
  };

  it("scales the ambient term by the baked texel", () => {
    const none = centre(null);
    const dark = centre(texel(40));
    const bright = centre(texel(255));
    expect(dark).toBeLessThan(none);
    expect(bright).toBeGreaterThan(none); // 255 → ×LIGHTMAP_RANGE
    expect(LIGHTMAP_RANGE).toBeGreaterThan(1);
  });

  it("ignores a light map on a primitive without the second UV set", () => {
    const plain = { ...quad, primitives: [{ ...quad.primitives[0]!, uvs2: undefined }] };
    const render = (lm: DecodedTexture | null) => {
      const out = new Uint8ClampedArray(SIZE * SIZE * 4);
      renderMeshScene([{ mesh: plain, model: IDENTITY, lightmapTextures: [lm] }], {
        width: SIZE,
        height: SIZE,
        out,
        depth: new Float32Array(SIZE * SIZE),
        view: viewMatrix([0, 0, 5], [0, 0, 0]),
        projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
        lightDirection: [0, 0, -1],
        ambient: 0.4,
      });
      return out[((SIZE >> 1) * SIZE + (SIZE >> 1)) * 4]!;
    };
    expect(render(texel(40))).toBe(render(null));
  });
});

describe("Lockout's baked light map", () => {
  it("was baked for the arena as it is now (fingerprint matches the layout)", () => {
    // If this fails, the arena's geometry changed: run `npm run bake:lockout`.
    expect(LOCKOUT_LIGHTMAP.fingerprint).toBe(layoutFingerprint(lockoutMapLayout()));
  });

  it("ships in the sidecar: the map carries the second UV set and one shared light map", () => {
    const scene = parseMeshScene(lockoutMeshSidecar())!;
    const map = scene.instances.find((i) => i.id === "lockout-map")!;
    const lit = map.mesh.primitives.filter((p) => p.uvs2 && p.material.lightmapImage);
    expect(lit.length).toBe(map.mesh.primitives.length);
    expect(new Set(lit.map((p) => p.material.lightmapImage)).size).toBe(1);
    expect(pngWidth(lit[0]!.material.lightmapImage!.bytes)).toBe(lockoutMapLayout().size);
  });
});

describe("editor scene bake", () => {
  function scene() {
    let sidecar = emptyMeshSidecar();
    const floor = addMesh(sidecar, box([-3, -0.2, -3], [3, 0, 3]), "floor");
    sidecar = floor.sidecar;
    const block = addMesh(sidecar, box([-0.5, 0, -0.5], [0.5, 1, 0.5]), "block");
    sidecar = setMeshTransform(block.sidecar, block.id, { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    return sidecar;
  }

  it("bakes every still object, then clears them all", async () => {
    const sidecar = scene();
    expect(lightingStats(sidecar)).toMatchObject({ baked: 0, still: 2 });
    const seen: number[] = [];
    const baked = await bakeSceneLighting(sidecar, { density: 2, rays: 8 }, (d) => seen.push(d));
    expect(lightingStats(baked)).toMatchObject({ baked: 2, still: 2 });
    expect(seen.at(-1)).toBeCloseTo(1, 5);
    const cleared = clearSceneLighting(baked);
    expect(lightingStats(cleared)).toMatchObject({ baked: 0, still: 2 });
    for (const entry of cleared.meshes) {
      const mesh = deserializeMeshAsset(entry.mesh);
      expect(mesh.primitives.every((p) => !p.uvs2 && !p.material.lightmapImage)).toBe(true);
    }
  });

  it("bakes light probes over the still objects when the scene has a lighting rig, and clears them (EP9)", async () => {
    const sidecar = { ...scene(), lighting: defaultSceneLighting() };
    const baked = await bakeSceneLighting(sidecar, { density: 2, rays: 8, probeSpacing: 2 });
    expect(lightingStats(baked).probes).toBeGreaterThanOrEqual(8);
    expect(baked.lighting!.lightProbes!.counts.every((c) => c >= 2)).toBe(true);
    expect(lightingStats(clearSceneLighting(baked)).probes).toBe(0);
    expect(lightingStats(await bakeSceneLighting(sidecar, { density: 2, rays: 8, probeSpacing: 0 })).probes).toBe(0);
  });

  it("leaves an empty scene alone", async () => {
    const empty = emptyMeshSidecar();
    expect(await bakeSceneLighting(empty)).toBe(empty);
    expect(clearSceneLighting(empty)).toBe(empty);
  });

  it("re-applies a stored image without re-encoding", () => {
    const layout = layoutLightmap(box([0, 0, 0], [1, 1, 1]), IDENTITY, { density: 2 });
    const image = { mime: "image/png", bytes: Uint8Array.from([9]) };
    expect(applyLightmapImage(layout.mesh, image).primitives[0]!.material.lightmapImage).toBe(image);
  });
});
