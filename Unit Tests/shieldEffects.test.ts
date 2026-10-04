/**
 * Shield effects (HALO2_STYLE_ROADMAP.md, H11): a per-object surface effect —
 * the flare of a hit, the recharge shimmer, Active Camo — over an object's PBR
 * materials. The effect model, the software rasteriser, the GPU uniforms and
 * batching, the overlay (an object and everything under it), cartbox.shield
 * through the runtime (in the real engine), and Lockout's use of it.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LOCKOUT_CODE,
  SHIELD_CAMO_MAX,
  bandAmount,
  camoThreshold,
  composeModelMatrix,
  effectActive,
  projectionMatrix,
  renderMeshScene,
  serializeMeshAsset,
  shieldEffect,
  viewMatrix,
  type MeshAsset,
  type MeshMaterial,
  type MeshSceneInstance,
  type SurfaceEffect,
} from "@cartbox/editor";
import {
  MeshOverlaySurface,
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  codeChunks,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneObjectsSdkLua,
  type SceneDraw,
  type SceneRenderer,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { batchInstances } from "../packages/player/src/render/gpuFrame";
import { UNIFORM_FLOATS, writeInstanceUniform, type InstanceUniform } from "../packages/player/src/render/scenePacking";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");
const IDENTITY = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
const PBR: MeshMaterial = { name: "armor", baseColorFactor: [0.4, 0.4, 0.4, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 };
const PLAIN: MeshMaterial = { name: "plain", baseColorFactor: [0.4, 0.4, 0.4, 1], baseColorImage: null };

/** A camera-facing quad (normal +Z) spanning ±`half`. */
function quad(material: MeshMaterial, half = 1): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-half, -half, 0, half, -half, 0, half, half, 0, -half, half, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material,
      },
    ],
  };
}

const SIZE = 32;
function render(mesh: MeshAsset, effect: SurfaceEffect | null, time = 0, eye: [number, number, number] = [0, 0, 2.5]) {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const depth = new Float32Array(SIZE * SIZE);
  renderMeshScene([{ mesh, model: IDENTITY, effect }], {
    width: SIZE,
    height: SIZE,
    out,
    depth,
    view: viewMatrix(eye, [0, 0, 0]),
    projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.05, 100),
    lightDirection: [0, 0, 1],
    ambient: 0.3,
    background: [0, 0, 0, 0],
    time,
  });
  return { out, depth };
}
const px = (out: Uint8ClampedArray, x: number, y: number) => [out[(y * SIZE + x) * 4]!, out[(y * SIZE + x) * 4 + 1]!, out[(y * SIZE + x) * 4 + 2]!];

describe("surface effect model", () => {
  it("drops exactly the camo share of each 4×4 block, on a pattern that crawls with time", () => {
    const values = new Set<number>();
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) values.add(camoThreshold(x, y, 0));
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, k) => (k + 0.5) / 16));
    for (const camo of [0.25, 0.5, 0.88]) {
      let dropped = 0;
      for (let y = 8; y < 12; y += 1) for (let x = 4; x < 8; x += 1) if (camoThreshold(x, y, 0.3) < camo) dropped += 1;
      expect(dropped).toBe(Math.round(camo * 16));
    }
    const at = (t: number) => Array.from({ length: 16 }, (_, k) => camoThreshold(k % 4, k >> 2, t));
    expect(at(0)).not.toEqual(at(1 / 12));
    expect(at(0)).toEqual(at(0.05)); // steps, rather than shimmering every frame
  });

  it("sweeps bands of 0..1 up the body over time", () => {
    for (let y = 0; y < 2; y += 0.05) {
      const b = bandAmount(y, 0.4);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
    expect(bandAmount(Math.PI / 18, 0)).toBeCloseTo(1, 6); // sin = 1 at y·9 = π/2
    expect(bandAmount(0.5, 0)).not.toBeCloseTo(bandAmount(0.5, 0.2), 3);
  });

  it("maps a shield's flare, shimmer and camo onto an effect", () => {
    expect(shieldEffect(0, 0, 0)).toBeNull();
    const flare = shieldEffect(1, 0, 0)!;
    expect(flare.rim![0]).toBeGreaterThan(flare.rim![2]); // gold
    expect(flare.glow![0]).toBeGreaterThan(0);
    expect(flare.bands).toEqual([0, 0, 0]);
    expect(flare.camo).toBe(0);
    const shimmer = shieldEffect(0, 1, 0)!;
    expect(shimmer.bands![0]).toBeGreaterThan(0);
    expect(shimmer.glow).toEqual([0, 0, 0]);
    const camo = shieldEffect(0, 0, 1)!;
    expect(camo.camo).toBeCloseTo(SHIELD_CAMO_MAX);
    expect(camo.rim![2]).toBeGreaterThan(camo.rim![0]); // a cool edge
    expect(shieldEffect(2, -1, Number.NaN)).toEqual(shieldEffect(1, 0, 0)); // clamped
    expect(effectActive(null)).toBe(false);
    expect(effectActive({ rim: [0, 0, 0] })).toBe(false);
    expect(effectActive(camo)).toBe(true);
  });
});

describe("software rasteriser", () => {
  it("adds the rim and glow over a PBR surface, and nothing over a plain one", () => {
    const base = px(render(quad(PBR), null).out, 16, 16);
    const glow = px(render(quad(PBR), { glow: [0.3, 0.2, 0] }).out, 16, 16);
    expect(glow[0] - base[0]).toBeGreaterThan(60);
    expect(glow[2]).toBe(base[2]);
    // Seen at a grazing angle the rim lights the surface; head-on it doesn't.
    const grazing: [number, number, number] = [2.4, 0, 0.6];
    const rimLess = px(render(quad(PBR, 4), null, 0, grazing).out, 16, 16);
    const rim = px(render(quad(PBR, 4), { rim: [1, 1, 1], rimPower: 1 }, 0, grazing).out, 16, 16);
    expect(rim[1] - rimLess[1]).toBeGreaterThan(80);
    expect(px(render(quad(PLAIN), { glow: [1, 1, 1] }).out, 16, 16)).toEqual(px(render(quad(PLAIN), null).out, 16, 16));
  });

  it("lights bands that move with time", () => {
    const shimmer: SurfaceEffect = { bands: [1, 1, 1] };
    const column = (time: number) => {
      const { out } = render(quad(PBR), shimmer, time);
      return Array.from({ length: 20 }, (_, k) => px(out, 16, 6 + k)[0]);
    };
    const now = column(0);
    expect(Math.max(...now) - Math.min(...now)).toBeGreaterThan(100); // bright bands and dark gaps
    expect(column(0.15)).not.toEqual(now);
  });

  it("drops the camo share of pixels, writing no depth where the scene shows through", () => {
    const solid = render(quad(PBR), null);
    const cloaked = render(quad(PBR), { camo: 0.5 });
    let covered = 0;
    let dropped = 0;
    for (let y = 10; y < 22; y += 1)
      for (let x = 10; x < 22; x += 1) {
        const i = y * SIZE + x;
        if (!Number.isFinite(solid.depth[i]!)) continue;
        covered += 1;
        if (cloaked.out[i * 4 + 3] === 0) {
          dropped += 1;
          expect(cloaked.depth[i]).toBe(Infinity);
        }
      }
    expect(covered).toBe(144);
    expect(dropped).toBe(72);
  });
});

describe("GPU uniforms and batching", () => {
  const uniform = (effect: SurfaceEffect | null): InstanceUniform => ({
    mvp: IDENTITY,
    normalBasis: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    baseColor: [1, 1, 1, 1],
    hasTexture: false,
    light: { direction: [0, 1, 0], ambient: 0.3 },
    viewDir: [0, 0, 1],
    pbr: { metallic: 0, roughness: 1, isPbr: true, emissive: [0, 0, 0] },
    hasMrMap: false,
    hasOcclusionMap: false,
    hasEmissiveMap: false,
    environment: null,
    lightMvp: null,
    shadow: null,
    tonemap: null,
    hasSsao: false,
    model: IDENTITY,
    lightCount: 0,
    surface: { detailScale: 8, detailStrength: 0, reflect: 1, reflectMask: false, emisOffset: [0, 0], emisGain: 1, rim: [0.25, 0.25, 0.5], rimPower: 3, blend: null },
    effect,
    time: 1.5,
  });

  it("packs glow + camo and bands + time after the fog volumes, and adds the effect rim into the material's", () => {
    const data = new Float32Array(UNIFORM_FLOATS);
    writeInstanceUniform(data, 0, uniform({ rim: [1, 0.5, 0], rimPower: 1.5, glow: [0.2, 0.1, 0], bands: [0.5, 0.4, 0.3], camo: 0.6 }));
    const at = (byte: number, n: number) => Array.from(data.subarray(byte / 4, byte / 4 + n)).map((v) => +v.toFixed(3));
    expect(at(528, 4)).toEqual([1.25, 0.75, 0.5, 1.5]);
    expect(at(736, 8)).toEqual([0.2, 0.1, 0, 0.6, 0.5, 0.4, 0.3, 1.5]);
    writeInstanceUniform(data, 0, uniform(null));
    expect(at(528, 4)).toEqual([0.25, 0.25, 0.5, 3]); // the material's own rim
    expect(at(736, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 1.5]);
  });

  it("batches copies with an effect apart from plain ones, and together when they share it", () => {
    const mesh = quad(PBR);
    const fx = shieldEffect(1, 0, 0);
    const geometryOf = (m: MeshAsset) => m.primitives.map(() => ({ indexCount: 6 }));
    const copies = (effects: (SurfaceEffect | null)[]): MeshSceneInstance[] => effects.map((effect) => ({ mesh, model: IDENTITY, effect }));
    const split = batchInstances(copies([null, fx, null, fx]), geometryOf);
    expect(split.batches.map((b) => [b.effect, b.models.length])).toEqual([
      [null, 2],
      [fx, 2],
    ]);
    expect(batchInstances(copies([null, null]), geometryOf).batches).toHaveLength(1);
  });
});

function sidecar(extra: Record<string, unknown> = {}) {
  const t = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  return JSON.stringify({
    ...extra,
    version: 2,
    meshes: [
      { id: "body", name: "body", mesh: serializeMeshAsset(quad(PBR)), transform: t },
      { id: "gun", name: "gun", parent: "body", mesh: serializeMeshAsset(quad(PBR, 0.2)), transform: t },
      { id: "wall", name: "wall", mesh: serializeMeshAsset(quad(PBR, 3)), transform: t },
    ],
  });
}

describe("overlay", () => {
  it("draws a shield on the object and everything under it, until it's cleared", async () => {
    const sc = parseMeshScene(sidecar())!;
    const drawn: (readonly MeshSceneInstance[])[] = [];
    const renderer: SceneRenderer = { backend: "software", render: (instances, _d: SceneDraw) => void drawn.push(instances), dispose: () => {} };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, sc, renderer);
    const effects = () => drawn.at(-1)!.map((i) => i.effect ?? null);
    surface.setShields(new Map([[0, { flare: 1, shimmer: 0, camo: 0 }]]));
    surface.blit(new Uint8Array(16 * 16 * 4));
    const first = effects();
    expect(first[0]).toEqual(shieldEffect(1, 0, 0));
    expect(first[1]).toBe(first[0]); // the gun under the body
    expect(first[2]).toBeNull();
    // The same state keeps the same effect (its batches hold together).
    surface.setShields(new Map([[0, { flare: 1, shimmer: 0, camo: 0 }]]));
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(effects()[0]).toBe(first[0]);
    surface.setShields(new Map());
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(effects()).toEqual([null, null, null]);
  });
});

describe.skipIf(!existsSync(ENGINE))("cartbox.shield from Lua (real engine)", () => {
  it("sends only changes, stands until changed, and clears at zero", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    // Shields ride the runtime block, which a scene has when it needs one for anything (debris, here).
    const sc = parseMeshScene(sidecar({ debris: [{ name: "chip", source: "gun" }] }))!;
    const code = `
t = 0
function TIC()
  t = t + 1
  if t >= 2 and t <= 4 then cartbox.shield("body", 1, 0, 0) end
  if t == 5 then cartbox.shield(2, 0, 0.5, 0.25) end
  if t == 6 then cartbox.shield("body", 0, 0, 0) cartbox.shield("nope", 1, 1, 1) end
end`;
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = prependLuaCode(tic, runtimeSdkLua(sc, layout, { physics: false }));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const channel = new RuntimeChannel(sc, null);
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const block = () => new DataView(mod.HEAPU8.buffer, base + physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES);
    const seen: { shields: [number, { flare: number; shimmer: number; camo: number }][] }[] = [];
    for (let i = 1; i <= 6; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
      seen.push({ shields: [...channel.shields()].map(([o, s]) => [o, { flare: +s.flare.toFixed(3), shimmer: +s.shimmer.toFixed(3), camo: +s.camo.toFixed(3) }]) });
    }
    expect(seen[0]!.shields).toEqual([]);
    expect(seen[1]!.shields).toEqual([[0, { flare: 1, shimmer: 0, camo: 0 }]]);
    expect(seen[2]!.shields).toEqual(seen[1]!.shields); // repeated: nothing sent, still standing
    expect(seen[4]!.shields).toEqual([
      [0, { flare: 1, shimmer: 0, camo: 0 }],
      [2, { flare: 0, shimmer: 0.5, camo: 0.25 }],
    ]);
    expect(seen[5]!.shields).toEqual([[2, { flare: 0, shimmer: 0.5, camo: 0.25 }]]);
    channel.destroy();
  });
});

describe("Lockout", () => {
  it("flares a soldier's shield when it's hit and shimmers it while it recharges", () => {
    expect(LOCKOUT_CODE).toContain("cartbox.shield(i, o.flare or 0");
    expect(LOCKOUT_CODE).toContain("local function recharge(o)");
    expect(LOCKOUT_CODE).toContain("recharge(p); for _,o in ipairs(bots) do recharge(o) end");
  });
});
