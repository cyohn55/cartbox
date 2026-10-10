/**
 * Dynamic bounce at run time (HALO_INFINITE_STYLE_ROADMAP.md I17): the player
 * finds a scene's bounce transfer a slice a frame, then relights its probes
 * when the lights move — a cart's light, or its sun (cartbox.sun3d), which
 * takes the rig's key light's place for the frame, shadows and all.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { bakeLightProbes, composeModelMatrix, encodeLightProbes, serializeMeshAsset, type LightProbeGrid, type MeshAsset, type MeshPrimitive, type SceneLighting } from "@cartbox/editor";
import { MeshOverlaySurface, codeChunks, decodeWorldLights, injectSdk, parseMeshScene, type SceneDraw, type SceneRenderer } from "@cartbox/player";
import { bounceLightsFor, bounceSignature, withCartSun } from "../packages/player/src/mesh/dynamicLights";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

function slab(w: number, h: number, d: number, at: [number, number, number]): MeshPrimitive {
  const [x0, y0, z0] = [at[0] - w / 2, at[1], at[2] - d / 2];
  const [x1, y1, z1] = [at[0] + w / 2, at[1] + h, at[2] + d / 2];
  const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const quads = [[3, 2, 6, 7], [0, 4, 5, 1], [1, 5, 6, 2], [0, 3, 7, 4], [4, 7, 6, 5], [0, 1, 2, 3]];
  const positions: number[] = [], indices: number[] = [];
  for (const q of quads) {
    const base = positions.length / 3;
    for (const i of q) positions.push(...P[i]!);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: Float32Array.from(positions), normals: null, uvs: null, indices: Uint32Array.from(indices), material: { name: "m", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null } };
}

const SUN: [number, number, number] = [0.3, 0.8, 0.5];
const yard: MeshAsset = { name: "yard", primitives: [slab(12, 0.5, 12, [0, -0.5, 0])] };
const grid: LightProbeGrid = bakeLightProbes([-3, 0.5, -3], [3, 2.5, 3], [4, 2, 4], [{ mesh: yard, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }], { rays: 32, distance: 6, sun: SUN, bounce: 0.9 });
const lighting: SceneLighting = {
  ambient: 0.3,
  lights: [{ kind: "directional", direction: SUN, color: [1, 0.9, 0.8], intensity: 2 }],
  environment: { sky: [0.5, 0.6, 0.8], horizon: [0.7, 0.7, 0.7], ground: [0.3, 0.3, 0.3], intensity: 1 },
  tonemap: { exposure: 1, mode: "aces" },
  shadows: false,
  lightProbes: encodeLightProbes(grid, { sun: SUN, distance: 6, bounce: 0.9 }),
} as unknown as SceneLighting;

describe("the lights a relight uses", () => {
  it("are the bake's own under the authored rig, scale other lights by the key's brightness, and take the cart's sun as the key", () => {
    const asAuthored = bounceLightsFor(lighting, lighting, []);
    expect(asAuthored.sun!.color).toEqual([1, 1, 1]);
    expect(asAuthored.points).toEqual([]);
    const cyan = bounceLightsFor(lighting, lighting, [{ kind: "point", position: [0, 1, 0], color: [0, 1, 1], intensity: 1, range: 4 }]);
    const key = 0.2126 * 2 + 0.7152 * 1.8 + 0.0722 * 1.6;
    expect(cyan.points[0]!.color[1]).toBeCloseTo(1 / key, 9);
    const dusk = withCartSun(lighting, { direction: [-2, 1, 0], color: [1, 0.5, 0.2] });
    expect(dusk.lights).toHaveLength(1);
    expect(dusk.lights[0]!.direction![0]).toBeCloseTo(-2 / Math.sqrt(5), 9);
    expect(bounceLightsFor(lighting, dusk, []).sun!.color[2]).toBeCloseTo(0.2 / 1.6, 9);
    // A light moved a hair isn't worth a relight; one moved a hand's width is.
    const at = (x: number) => bounceSignature(bounceLightsFor(lighting, lighting, [{ kind: "point", position: [x, 1, 0], color: [1, 1, 1], intensity: 1, range: 4 }]));
    expect(at(0.01)).toBe(at(0));
    expect(at(0.2)).not.toBe(at(0));
  });
});

describe("the player", () => {
  it("relights its probes as a cart's light moves, and moves its key light to the cart's sun", async () => {
    const sidecar = JSON.stringify({ version: 2, meshes: [{ id: "yard", name: "yard", mesh: serializeMeshAsset(yard), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }], lighting });
    const scene = parseMeshScene(sidecar)!;
    const draws: SceneDraw[] = [];
    const renderer: SceneRenderer = { backend: "software", render: (_i, d: SceneDraw) => void draws.push(d), dispose: () => {} };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer);
    const frame = () => surface.blit(new Uint8Array(16 * 16 * 4));
    const probes = () => draws.at(-1)!.environment!.lightProbes!;
    frame();
    const baked = probes();
    // The transfer is found over the first frames; with nothing moved the probes stay as baked.
    for (let i = 0; i < 6; i += 1) frame();
    expect(probes().values).toEqual(baked.values);
    // A cyan light over the floor: the probes above it pick up its bounce.
    surface.setCartLights([{ position: [0, 0.6, 0], range: 4, color: [0, 2, 2] }]);
    for (let i = 0; i < 5; i += 1) frame();
    const lit = probes();
    expect(lit).not.toBe(baked);
    let gained = 0;
    for (let i = 2; i < lit.values.length; i += 3) gained = Math.max(gained, lit.values[i]! - baked.values[i]!);
    expect(gained).toBeGreaterThan(0.05);
    // The cart's sun takes the key light's place.
    surface.setCartLights([{ position: [-0.7, 0.3, 0.6], range: 0, color: [1, 0.6, 0.3], sun: true }]);
    frame();
    const key = draws.at(-1)!.lights!.find((l) => l.kind === "directional")!;
    expect(key.direction![0]).toBeCloseTo(-0.7 / Math.hypot(0.7, 0.3, 0.6), 6);
    expect(draws.at(-1)!.lightDirection![0]).toBeCloseTo(key.direction![0], 9);
    surface.destroy();
  });
});

describe.skipIf(!existsSync(ENGINE))("cartbox.sun3d through the real engine", () => {
  it("publishes the sun's direction and colour, apart from the point lights", async () => {
    const lua = `function TIC()
  cartbox.clearlights()
  cartbox.light3d(1, 2, 3, 4, 255, 255, 255, 1)
  cartbox.sun3d(-2, 1, 0, 255, 128, 64, 1.5)
end`;
    const tic = injectSdk(codeChunks(new TextEncoder().encode(lua)));
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    mod._cbx_tick(h, 0);
    const words = new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h), mod._cbx_mailbox_words(h)).slice();
    mod._cbx_delete(h);
    const lights = decodeWorldLights(words);
    expect(lights).toHaveLength(2);
    expect(lights[0]!.sun).toBeUndefined();
    const sun = lights[1]!;
    expect(sun.sun).toBe(true);
    expect(sun.position[0]).toBeCloseTo(-2 / Math.sqrt(5), 1);
    expect(sun.position[1]).toBeCloseTo(1 / Math.sqrt(5), 1);
    expect(sun.color[0]).toBeCloseTo(1.5, 2);
  });
});
