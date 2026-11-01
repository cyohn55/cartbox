/**
 * The GPU lightmapper (AAA_FIDELITY_ROADMAP.md F3d): the HDR directional light
 * map's storage, the tracer's scene, and on a real device, bakes checked
 * against what can be worked out by hand: an open floor's furnace, half the
 * sky at a tall wall's foot, the view factor of a glowing ceiling, colour
 * bleeding off a sunlit wall, and more light with more bounces.
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  decodeHdrLightmap,
  defaultSceneLighting,
  deserializeMeshAsset,
  decodePngRgba,
  directionalIrradiance,
  encodeHdrLightmap,
  encodeRgbaPng,
  fromRgbe,
  layoutLightmap,
  projectionMatrix,
  toRgbe,
  viewMatrix,
  type DecodedTexture,
  type EnvironmentLight,
  type HdrLightmap,
  type LightmapLayout,
  type MeshAsset,
  type MeshSceneInstance,
  type Occluder,
} from "@cartbox/editor";
import { WebgpuSceneRenderer } from "@cartbox/player";
import { bakeSceneLighting, clearSceneLighting, lightingStats } from "../apps/web/src/lib/lightBake";
import { addMesh, emptyMeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { bakeLightmapGpu, packLightmapScene, type GpuLightBakeOptions, type GpuLightmapBake } from "../packages/player/src/render/gpuLightmapper";
import { lightmapTexels } from "../packages/editor/src/model/lightmap";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A quad from a corner and two edges, facing `normal` (its winding is the renderers' business, not the bake's). */
function quad(corner: number[], u: number[], v: number[], normal: number[], colour: number[], emissive?: number[]): MeshAsset {
  const p = [corner, corner.map((c, i) => c + u[i]!), corner.map((c, i) => c + u[i]! + v[i]!), corner.map((c, i) => c + v[i]!)];
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from(p.flat()),
        normals: Float32Array.from([...normal, ...normal, ...normal, ...normal]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorImage: null, baseColorFactor: [colour[0]!, colour[1]!, colour[2]!, 1], ...(emissive ? { emissiveFactor: emissive } : {}) },
      },
    ],
  } as unknown as MeshAsset;
}

describe("the HDR directional light map's storage", () => {
  it("keeps a float in RGBE to within its mantissa's step", () => {
    const bytes = new Uint8Array(4);
    const out = new Float32Array(3);
    for (const [r, g, b] of [[0.7, 0.2, 0.05], [12, 3, 1], [0.001, 0.002, 0.0005], [1, 1, 1]] as const) {
      toRgbe(r, g, b, bytes, 0);
      fromRgbe(bytes, 0, out, 0);
      const m = Math.max(r, g, b);
      [r, g, b].forEach((c, i) => expect(Math.abs(out[i]! - c)).toBeLessThan(m / 128));
    }
    toRgbe(0, 0, 0, bytes, 0);
    expect([...bytes]).toEqual([0, 0, 0, 0]);
  });

  it("round-trips irradiance, direction and visibility through its PNG", async () => {
    const size = 4;
    const irradiance = new Float32Array(size * size * 3).map((_, i) => 0.05 + (i % 7) * 0.9);
    const direction = new Float32Array(size * size * 4).map((_, i) => (i % 4 === 3 ? 0.25 + (i % 3) * 0.3 : ((i % 5) - 2) / 2.5));
    const image = encodeHdrLightmap({ width: size, height: size, irradiance, direction });
    expect(image.mime).toBe("image/png");
    const back = await decodeHdrLightmap(image.bytes);
    expect([back.width, back.height]).toEqual([size, size]);
    irradiance.forEach((v, i) => expect(back.irradiance[i]!).toBeCloseTo(v, 1));
    direction.forEach((v, i) => expect(Math.abs(back.direction[i]! - v)).toBeLessThan(0.01));
  });

  it("decodes RGBA exactly as stored, alpha and all (no premultiplying)", async () => {
    const rgba = Uint8Array.from([200, 100, 50, 3, 1, 2, 3, 0]);
    const png = await decodePngRgba(encodeRgbaPng(rgba, 2, 1, { compress: true }));
    expect([...png.data]).toEqual([...rgba]);
  });

  it("rebalances by the dominant direction: exact at the baked normal, brighter toward the light, flat without one", () => {
    const e = [0.4, 0.5, 0.6] as const;
    const up = [0, 1, 0] as const;
    const toward = [Math.SQRT1_2, Math.SQRT1_2, 0] as const;
    const away = [-Math.SQRT1_2, Math.SQRT1_2, 0] as const;
    expect(directionalIrradiance(e, [0.6, 0.5, 0], up, up)).toEqual([...e].map((c) => c * 1));
    const lit = directionalIrradiance(e, [0.8, 0.4, 0], toward, up)[0];
    const shaded = directionalIrradiance(e, [0.8, 0.4, 0], away, up)[0];
    expect(lit).toBeGreaterThan(e[0]);
    expect(shaded).toBeLessThan(e[0]);
    expect(directionalIrradiance(e, [0, 0, 0], away, up)).toEqual([...e]);
  });
});

describe("the tracer's scene", () => {
  it("flattens the BVH: leaves as −1 − count with their first triangle, materials in linear light", () => {
    const floor = quad([-1, 0, -1], [2, 0, 0], [0, 0, 2], [0, 1, 0], [1, 0.5, 0], [0.5, 0, 0]);
    const scene = packLightmapScene([{ mesh: floor, model: IDENTITY }]);
    expect(scene.triangles).toBe(2);
    // Two triangles fit one leaf: the root.
    expect(scene.nodes[3]! | 0).toBe(-1 - 2);
    expect(scene.nodes[7]).toBe(0);
    expect(scene.mats[0]).toBeCloseTo(1, 5);
    expect(scene.mats[1]).toBeCloseTo(((0.5 + 0.055) / 1.055) ** 2.4, 5);
    expect(scene.mats[4]).toBeCloseTo(((0.5 + 0.055) / 1.055) ** 2.4, 5);
    // The edges from the first corner.
    const e1 = [...scene.tris.subarray(4, 7)];
    const e2 = [...scene.tris.subarray(8, 11)];
    expect(Math.hypot(...e1) * Math.hypot(...e2)).toBeGreaterThan(0);
    // An empty scene binds one node no ray enters.
    const empty = packLightmapScene([]);
    expect(empty.triangles).toBe(0);
    expect(empty.nodes[3]! | 0).toBe(-1);
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
  } catch {
    return null;
  }
}
const device = await realDevice();

/** Wait on a promise the device settles, ticking it meanwhile (a bake takes many submits). */
async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 40_000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    device.tick?.();
  }
  return promise;
}

/** A uniform sky of linear radiance `l`. */
const uniformSky = (l: number) => ({ width: 4, height: 2, data: new Float32Array(32).map((_, i) => (i % 4 === 3 ? 1 : l)) });

/** Bake `mesh` laid out at `density` among `others`, and a reader of the result at the texel nearest a point. */
async function bake(mesh: MeshAsset, others: readonly Occluder[], options: GpuLightBakeOptions, density = 8): Promise<{ result: GpuLightmapBake; layout: LightmapLayout; at: (p: readonly number[]) => number }> {
  const layout = layoutLightmap(mesh, IDENTITY, { density });
  device.pushErrorScope("validation");
  const result = await settled(bakeLightmapGpu(device, layout, [{ mesh: layout.mesh, model: IDENTITY }, ...others], options));
  const error = await settled(device.popErrorScope());
  expect(error ? String((error as any).message ?? error) : null).toBeNull();
  const texels = lightmapTexels(layout);
  const at = (p: readonly number[]) => {
    let best = -1, bestD = Infinity;
    for (let j = 0; j < texels.index.length; j += 1) {
      const d = Math.hypot(texels.position[j * 3]! - p[0]!, texels.position[j * 3 + 1]! - p[1]!, texels.position[j * 3 + 2]! - p[2]!);
      if (d < bestD) [best, bestD] = [texels.index[j]!, d];
    }
    return best;
  };
  return { result, layout, at };
}

describe.skipIf(!device)("the GPU lightmapper, on a real device", { timeout: 300_000 }, () => {
  const floor = quad([-1, 0, -1], [2, 0, 0], [0, 0, 2], [0, 1, 0], [0.5, 0.5, 0.5]);

  it("lights open floor at the sky's radiance, from straight up, with all of the sky", async () => {
    const { result, at } = await bake(floor, [], { samples: 64, bounces: 2, sky: uniformSky(0.7) });
    const i = at([0, 0, 0]);
    for (let c = 0; c < 3; c += 1) expect(result.hdr.irradiance[i * 3 + c]!).toBeCloseTo(0.7, 4);
    // A uniform sky over the hemisphere: its cosine-weighted mean direction is ⅔ of the normal, and all of it is seen.
    expect(result.hdr.direction[i * 4 + 1]).toBeCloseTo(2 / 3, 2);
    expect(Math.hypot(result.hdr.direction[i * 4]!, result.hdr.direction[i * 4 + 2]!)).toBeLessThan(0.02);
    expect(result.hdr.direction[i * 4 + 3]).toBeCloseTo(1, 4);
    // And every other tier's scale reads 1 (× 1/1.5, in steps of 2).
    expect(Math.abs(result.ambient[i * 4]! - 170)).toBeLessThanOrEqual(2);
  });

  it("gives the floor at a tall black wall's foot half the sky, from the open side", async () => {
    const wall = quad([0, 0, -60], [0, 60, 0], [0, 0, 120], [1, 0, 0], [0, 0, 0]);
    const ground = quad([0, 0, -1], [1, 0, 0], [0, 0, 2], [0, 1, 0], [0.5, 0.5, 0.5]);
    const { result, at } = await bake(ground, [{ mesh: wall, model: IDENTITY }], { samples: 256, bounces: 0, sky: uniformSky(1) }, 16);
    const i = at([0.3, 0, 0]);
    // An infinitely tall wall blocks every direction with any heading toward it: half the cosine-weighted hemisphere.
    expect(result.hdr.irradiance[i * 3]!).toBeGreaterThan(0.47);
    expect(result.hdr.irradiance[i * 3]!).toBeLessThan(0.53);
    expect(result.hdr.direction[i * 4 + 3]!).toBeCloseTo(result.hdr.irradiance[i * 3]!, 2);
    // The light comes from the open side (+x) and above.
    expect(result.hdr.direction[i * 4]!).toBeGreaterThan(0.2);
    expect(result.hdr.direction[i * 4 + 1]!).toBeGreaterThan(0.3);
  });

  it("lights a dark room's floor from its glowing ceiling by the ceiling's view factor", async () => {
    // A closed unit box of black walls, its ceiling glowing at a linear 1.
    const black = [0, 0, 0];
    const walls = [
      quad([0, 1, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0], black, [1, 1, 1]),
      quad([0, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0], black),
      quad([1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], black),
      quad([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], black),
      quad([0, 0, 1], [1, 0, 0], [0, 1, 0], [0, 0, -1], black),
    ].map((mesh) => ({ mesh, model: IDENTITY }));
    const room = quad([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], black);
    const { result, at } = await bake(room, walls, { samples: 256, bounces: 2, sky: uniformSky(5) }, 16);
    const i = at([0.5, 0, 0.5]);
    // Four corner rectangles of 0.5 × 0.5 a metre above: F = 4 · (1/2π)(2 · A/√(1+A²) · atan(A/√(1+A²))), A = 0.5.
    const s = 0.5 / Math.sqrt(1.25);
    const view = (4 / (2 * Math.PI)) * 2 * s * Math.atan(s);
    expect(result.hdr.irradiance[i * 3]! / view).toBeGreaterThan(0.95);
    expect(result.hdr.irradiance[i * 3]! / view).toBeLessThan(1.05);
    // The sky outside never gets in, and the light is from above.
    expect(result.hdr.direction[i * 4 + 3]!).toBeLessThan(0.01);
    expect(result.hdr.direction[i * 4 + 1]!).toBeGreaterThan(0.8);
  });

  it("bleeds a sunlit red wall's colour onto the floor, and more with more bounces in a white room", async () => {
    const red = quad([0, 0, -2], [0, 2, 0], [0, 0, 4], [1, 0, 0], [0.9, 0.1, 0.1]);
    const ground = quad([0, 0, -1], [1, 0, 0], [0, 0, 2], [0, 1, 0], [0.5, 0.5, 0.5]);
    const sun = { direction: [1, 0.3, 0] as const, radiance: [3, 3, 3] as const };
    const options = { samples: 128, sky: uniformSky(0.2), lights: [sun] };
    const lit = await bake(ground, [{ mesh: red, model: IDENTITY }], { ...options, bounces: 1 });
    const i = lit.at([0.25, 0, 0]);
    expect(lit.result.hdr.irradiance[i * 3]!).toBeGreaterThan(2 * lit.result.hdr.irradiance[i * 3 + 1]!);
    // With no bounce, only the grey sky reaches it.
    const flat = await bake(ground, [{ mesh: red, model: IDENTITY }], { ...options, bounces: 0 });
    const r = flat.result.hdr.irradiance[i * 3]!, g = flat.result.hdr.irradiance[i * 3 + 1]!;
    expect(Math.abs(r - g)).toBeLessThan(0.01);
    // The ambient scale every other tier reads carries the tint too.
    expect(lit.result.ambient[i * 4]!).toBeGreaterThan(lit.result.ambient[i * 4 + 1]! + 40);

    // A white room open to the sky above: each bounce adds the light the walls pass on.
    const white = [0.8, 0.8, 0.8];
    const sides = [
      quad([0, 0, 0], [0, 2, 0], [0, 0, 1], [1, 0, 0], white),
      quad([1, 0, 0], [0, 2, 0], [0, 0, 1], [-1, 0, 0], white),
      quad([0, 0, 0], [1, 0, 0], [0, 2, 0], [0, 0, 1], white),
      quad([0, 0, 1], [1, 0, 0], [0, 2, 0], [0, 0, -1], white),
    ].map((mesh) => ({ mesh, model: IDENTITY }));
    const pit = quad([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], white);
    const one = await bake(pit, sides, { samples: 128, bounces: 0, sky: uniformSky(1) });
    const three = await bake(pit, sides, { samples: 128, bounces: 3, sky: uniformSky(1) });
    const j = one.at([0.5, 0, 0.5]);
    expect(three.result.hdr.irradiance[j * 3]! / one.result.hdr.irradiance[j * 3]!).toBeGreaterThan(1.5);
  });

  it("bakes the same light map twice", async () => {
    const a = await bake(floor, [], { samples: 16, bounces: 1, sky: uniformSky(0.5) });
    const b = await bake(floor, [], { samples: 16, bounces: 1, sky: uniformSky(0.5) });
    expect([...a.result.hdr.irradiance]).toEqual([...b.result.hdr.irradiance]);
    expect([...a.result.ambient]).toEqual([...b.result.ambient]);
  });
});

function half(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024);
}

describe.skipIf(!device)("the AAA tier lit by an HDR directional light map, on a real device", { timeout: 120_000 }, () => {
  const W = 32;
  const H = 32;
  const SKY: EnvironmentLight = { sky: [0.6, 0.7, 0.9], horizon: [0.8, 0.8, 0.8], ground: [0.3, 0.3, 0.3], intensity: 1 } as EnvironmentLight;
  // A rough white floor facing up, its light-map UVs over the whole map.
  const floor = {
    name: "lit",
    primitives: [
      {
        positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        uvs2: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 },
      },
    ],
  } as unknown as MeshAsset;
  const uniformMap = (e: readonly number[], visibility: number): HdrLightmap => ({
    width: 4,
    height: 4,
    irradiance: new Float32Array(48).map((_, i) => e[i % 3]!),
    direction: new Float32Array(64).map((_, i) => (i % 4 === 1 ? 2 / 3 : i % 4 === 3 ? visibility : 0)),
  });
  const byteMap = (v: number): DecodedTexture => ({ width: 4, height: 4, data: new Uint8ClampedArray(64).map((_, i) => (i % 4 === 3 ? 255 : v)) });

  /** The floor's linear colour at the frame's centre, lit by the sky alone (the key light from below). */
  async function shade(extra: Partial<MeshSceneInstance>, hdr = true): Promise<number[]> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr }))!;
    const instances: MeshSceneInstance[] = [{ mesh: floor, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [2, 1, 2]), ...extra }];
    device.pushErrorScope("validation");
    const texture = renderer.renderToTexture!(instances, { width: W, height: H, view: viewMatrix([0, 3, 0.001], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50), ambient: 0, lightDirection: [0, -1, 0], environment: SKY } as any);
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const bytesPerRow = 256;
    const buffer = device.createBuffer({ size: bytesPerRow * H, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, { width: W, height: H });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const mapped = buffer.getMappedRange().slice(0);
    buffer.unmap();
    buffer.destroy();
    renderer.dispose();
    if (!hdr) {
      const bytes = new Uint8Array(mapped);
      const i = (H >> 1) * bytesPerRow + (W >> 1) * 4;
      return [bytes[i]! / 255, bytes[i + 1]! / 255, bytes[i + 2]! / 255];
    }
    const halves = new Uint16Array(mapped);
    const i = ((H >> 1) * bytesPerRow) / 2 + (W >> 1) * 4;
    return [half(halves[i]!), half(halves[i + 1]!), half(halves[i + 2]!)];
  }

  it("lights the diffuse by the map's irradiance in place of the sky's, linearly, in its colour", async () => {
    const sky = await shade({});
    const dim = await shade({ lightmapHdrTextures: [uniformMap([0.2, 0.2, 0.2], 0)] });
    const twice = await shade({ lightmapHdrTextures: [uniformMap([0.4, 0.4, 0.4], 0)] });
    const red = await shade({ lightmapHdrTextures: [uniformMap([0.4, 0.1, 0.1], 0)] });
    // The diffuse of a rough white dielectric: the irradiance, less the few % the reflection takes.
    expect(dim[1]!).toBeGreaterThan(0.2 * 0.9);
    expect(dim[1]!).toBeLessThan(0.2 * 1.01);
    expect(twice[1]! / dim[1]!).toBeCloseTo(2, 2);
    expect(red[0]! / red[1]!).toBeCloseTo(4, 1);
    // With no map, the sky's own irradiance (about 0.5 here).
    expect(sky[1]!).toBeGreaterThan(2 * dim[1]!);
  });

  it("occludes the environment's reflection by the map's sky visibility", async () => {
    const hidden = await shade({ lightmapHdrTextures: [uniformMap([0.2, 0.2, 0.2], 0)] });
    const open = await shade({ lightmapHdrTextures: [uniformMap([0.2, 0.2, 0.2], 1)] });
    expect(open[1]!).toBeGreaterThan(hidden[1]! + 0.005);
  });

  it("keeps an 8-bit light map's scale on the AAA tier, and the other tiers ignore the HDR one", async () => {
    const sky = await shade({});
    const black = await shade({ lightmapTextures: [byteMap(0)] });
    const full = await shade({ lightmapTextures: [byteMap(255)] });
    expect(black[1]!).toBeLessThan(0.01);
    expect(full[1]! / sky[1]!).toBeCloseTo(1.5, 1);
    // The HDR map wins over the 8-bit one where both are bound.
    const both = await shade({ lightmapTextures: [byteMap(0)], lightmapHdrTextures: [uniformMap([0.2, 0.2, 0.2], 0)] });
    expect(both[1]!).toBeGreaterThan(0.15);
    // The byte path reads only the 8-bit map.
    const bytePlain = await shade({}, false);
    const byteHdr = await shade({ lightmapHdrTextures: [uniformMap([0.01, 0.01, 0.01], 0)] }, false);
    expect(byteHdr).toEqual(bytePlain);
  });
});

describe.skipIf(!device)("the editor's scene bake on the GPU", { timeout: 300_000 }, () => {
  it("gives every still object its 8-bit map and its HDR directional one, which a CPU rebake or a clear takes away", async () => {
    let sidecar = { ...emptyMeshSidecar(), lighting: defaultSceneLighting() };
    sidecar = addMesh(sidecar, quad([-3, 0, -3], [6, 0, 0], [0, 0, 6], [0, 1, 0], [0.6, 0.6, 0.6]), "floor").sidecar;
    sidecar = addMesh(sidecar, quad([-0.5, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.9, 0.2, 0.2]), "panel").sidecar;
    const seen: number[] = [];
    const baked = await settled(bakeSceneLighting(sidecar, { density: 2, rays: 4, bounces: 2, probeSpacing: 0, device }, (d) => seen.push(d)));
    expect(lightingStats(baked)).toMatchObject({ baked: 2, still: 2 });
    expect(seen.at(-1)).toBeCloseTo(1, 5);
    for (const entry of baked.meshes) {
      const mesh = deserializeMeshAsset(entry.mesh);
      for (const p of mesh.primitives) {
        expect(p.uvs2).toBeTruthy();
        expect(p.material.lightmapImage).toBeTruthy();
        const hdr = await decodeHdrLightmap(p.material.lightmapHdrImage!.bytes);
        expect(hdr.width).toBe(hdr.height);
        // Lit: the sky reaches the floor and the panel alike.
        expect(Math.max(...hdr.irradiance)).toBeGreaterThan(0.05);
      }
    }
    // The CPU bake keeps no stale HDR map, and clearing takes both.
    const cpu = await bakeSceneLighting(baked, { density: 2, rays: 4, probeSpacing: 0 });
    expect(cpu.meshes.every((e) => deserializeMeshAsset(e.mesh).primitives.every((p) => p.material.lightmapImage && !p.material.lightmapHdrImage))).toBe(true);
    const cleared = clearSceneLighting(baked);
    expect(cleared.meshes.every((e) => deserializeMeshAsset(e.mesh).primitives.every((p) => !p.material.lightmapImage && !p.material.lightmapHdrImage))).toBe(true);
  });
});
