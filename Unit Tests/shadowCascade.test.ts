/**
 * The near shadow cascade (ENGINE_PARITY_ROADMAP.md EP8b): which map a point
 * tests against, and the mesh overlay's near map — the same scene as a
 * from-scratch render round the camera, redrawn only as the camera crosses a
 * cell, and only on the high quality preset.
 */

import { describe, expect, it } from "vitest";

import {
  NEAR_CASCADE_BLEND,
  NEAR_CASCADE_EDGE,
  shadowVisibility,
  buildSceneShadow,
  cameraPositionFromView,
  composeModelMatrix,
  reflectionProbeAt,
  decalPreset,
  type MeshSceneInstance,
  defaultSceneLighting,
  orthographicMatrix,
  parseSceneLighting,
  patchSceneLighting,
  sceneLightingKeyDirection,
  MAX_SHADOW_DISTANCE,
  MIN_SHADOW_DISTANCE,
  sunShadowVisibility,
  viewMatrix,
  type MeshAsset,
  type ShadowInput,
} from "@cartbox/editor";
import { MeshOverlaySurface, QUALITY_PRESETS, type GpuSceneDraw, type SceneDraw, type SceneRenderer } from "@cartbox/player";
import { SUN_SOFTNESS } from "../packages/player/src/render/cascades";

describe("choosing a map", () => {
  // Main map: everything lit (depth 1). Near map: everything shadowed (depth −1, so any point is behind it).
  const view = viewMatrix([0, 10, 0], [0, 0, 0], [0, 0, -1]);
  const near = orthographicMatrix(-2, 2, -2, 2, 0.1, 20);
  const nearMvp = Float64Array.from({ length: 16 }, (_, i) => {
    let v = 0;
    for (let k = 0; k < 4; k += 1) v += near[(i % 4) + k * 4]! * view[k + Math.floor(i / 4) * 4]!;
    return v;
  });
  const shadow: ShadowInput = {
    lightViewProj: nearMvp,
    depth: new Float32Array(16).fill(1),
    size: 4,
    near: { lightViewProj: nearMvp, depth: new Float32Array(16).fill(-1), bias: 0.001, slopeBias: 0 },
  };

  it("tests a point well inside the near cascade against it, and one near its edge or outside against the main map", () => {
    expect(sunShadowVisibility(shadow, 0, 0, 0.5, 0, 0, 0, 1)).toBe(0); // inside: the near map shadows it
    const edge = 2 * NEAR_CASCADE_EDGE + 0.02; // just past the near map's inner edge (world units here)
    expect(sunShadowVisibility(shadow, 0, 0, 0.5, edge, 0, 0, 1)).toBe(1); // main map: lit
    expect(sunShadowVisibility(shadow, 0, 0, 0.5, 5, 0, 5, 1)).toBe(1);
    expect(sunShadowVisibility({ ...shadow, near: null }, 0, 0, 0.5, 0, 0, 0, 1)).toBe(1);
  });
  it("fades from the near map to the main one toward the near map's edge, leaving no seam (B7)", () => {
    const at = (x: number) => sunShadowVisibility(shadow, 0, 0, 0.5, x, 0, 0, 1);
    // World x maps to the near map's NDC as x / 2 here.
    expect(at(2 * NEAR_CASCADE_BLEND)).toBe(0); // still the near map's alone
    expect(at(2 * ((NEAR_CASCADE_BLEND + NEAR_CASCADE_EDGE) / 2))).toBeCloseTo(0.5, 6); // halfway through the fade
    expect(at(2 * NEAR_CASCADE_EDGE - 1e-4)).toBeCloseTo(1, 2); // all but the main map's at the edge
    let last = -1;
    for (let x = 0; x < 2 * NEAR_CASCADE_EDGE; x += 0.01) {
      const v = at(x);
      expect(v).toBeGreaterThanOrEqual(last - 1e-12);
      last = v;
    }
  });
});

describe("soft shadows (B7)", () => {
  // A 16² map: the left half at depth −1 (an occluder over everything), the right half clear.
  const depth = new Float32Array(16 * 16);
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) depth[y * 16 + x] = x < 8 ? -1 : 1;
  const map: ShadowInput = { lightViewProj: new Float64Array(16), depth, size: 16, bias: 0 };
  const across = (s: ShadowInput) => Array.from({ length: 9 }, (_, i) => shadowVisibility(s, (i - 4) / 16, 0, 0.5, 1));

  it("widens the penumbra from one texel to four", () => {
    const hard = across(map);
    const pcf = across({ ...map, pcf: true });
    const soft = across({ ...map, pcf: true, soft: true });
    const partial = (vs: number[]) => vs.filter((v) => v > 0 && v < 1).length;
    expect(partial(hard)).toBe(0);
    expect(partial(soft)).toBeGreaterThan(partial(pcf));
    // Every filter agrees far from the edge.
    for (const vs of [hard, pcf, soft]) {
      expect(vs[0]).toBe(0);
      expect(vs[8]).toBe(1);
    }
  });

  it("is what a lighting rig with softShadows builds", () => {
    const built = buildSceneShadow(scene().instances, patchSceneLighting(lighting, { softShadows: true }), [0, 0, 0], 10, { size: 32, depth: new Float32Array(32 * 32) });
    expect(built?.pcf).toBe(true);
    expect(built?.soft).toBe(true);
    expect(buildSceneShadow(scene().instances, lighting, [0, 0, 0], 10, { size: 32, depth: new Float32Array(32 * 32) })?.soft).toBeUndefined();
  });
});

function box(name: string): MeshAsset {
  const p: number[] = [];
  const idx: number[] = [];
  for (const [a, b, c] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] as const) {
    const base = p.length / 3;
    for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const v = [0, 0, 0];
      v[a] = 0.5;
      v[b] = 0.5 * s!;
      v[c] = 0.5 * t!;
      p.push(...v);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // …and the opposite faces.
  const n = p.length / 3;
  for (let i = 0; i < n; i += 1) p.push(-p[i * 3]!, -p[i * 3 + 1]!, -p[i * 3 + 2]!);
  for (let i = 0, m = idx.length; i < m; i += 1) idx.push(idx[i]! + n);
  return { name, primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name, baseColorFactor: [0.6, 0.6, 0.6, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 } }] };
}

const lighting = patchSceneLighting(defaultSceneLighting(), { shadows: true });
const bounds = { min: [-12, 0, -12] as [number, number, number], max: [12, 3, 12] as [number, number, number], center: [0, 1.5, 0] as [number, number, number], radius: 17 };
const scene = () => ({
  instances: [
    { mesh: box("floor"), model: composeModelMatrix([0, -0.5, 0], [0, 0, 0], [24, 1, 24]) },
    { mesh: box("pillar"), model: composeModelMatrix([-2, 1, -1], [0, 0, 0], [1, 2, 1]) },
    { mesh: box("crate"), model: composeModelMatrix([3, 0.5, 2], [0, 0, 0], [1, 1, 1]) },
  ],
  bounds,
  lighting,
});

function spy(): SceneRenderer & { draws: { view: SceneDraw["view"]; shadow: ShadowInput | null; near: Float32Array | null }[] } {
  const draws: { view: SceneDraw["view"]; shadow: ShadowInput | null; near: Float32Array | null }[] = [];
  return {
    backend: "webgpu",
    draws,
    render: (_i, draw) => draws.push({ view: draw.view, shadow: draw.shadow ?? null, near: draw.shadow?.near ? Float32Array.from(draw.shadow.near.depth) : null }),
    dispose: () => {},
  };
}
const camera = (x: number, z: number) => ({ yaw: 0.6, pitch: 0.4, distance: 3, target: [x, 0, z] as [number, number, number], fov: null, hud: false });

describe("the mesh overlay's near cascade", () => {
  it("renders the scene round the camera — matching a from-scratch map — sharper than the main one", async () => {
    const s = spy();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene(), s);
    surface.setCameraOverride(camera(1, 1));
    surface.blit(new Uint8Array(32 * 24 * 4));
    const frame = s.draws.at(-1)!;
    expect(frame.shadow?.near).toBeTruthy();
    // Rebuild what the overlay should have drawn: radius 17 × 0.3 = 5.1, its centre snapped to 2.55.
    const r = 17 * 0.3;
    const step = r / 2;
    const eye = cameraPositionFromView(frame.view);
    const c: [number, number, number] = [Math.round(eye[0] / step) * step, Math.round(eye[1] / step) * step, Math.round(eye[2] / step) * step];
    const reference = buildSceneShadow(scene().instances, lighting, c, r, { size: 1024, depth: new Float32Array(1024 * 1024), reach: 17 * 2 })!;
    let mismatched = 0;
    for (let k = 0; k < reference.depth.length; k += 1) if (frame.near![k] !== reference.depth[k]) mismatched += 1;
    expect(mismatched).toBe(0);
    expect(Array.from(frame.shadow!.near!.lightViewProj)).toEqual(Array.from(reference.lightViewProj));
  });

  it("is redrawn only when the camera crosses into another cell", async () => {
    const s = spy();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene(), s);
    surface.setCameraOverride(camera(1, 1));
    surface.blit(new Uint8Array(32 * 24 * 4));
    surface.setCameraOverride(camera(1.05, 1.02)); // a step: same cell
    surface.blit(new Uint8Array(32 * 24 * 4));
    expect(s.draws.at(-1)!.shadow!.near!.dirty).not.toBeNull(); // an update, not a redraw
    surface.setCameraOverride(camera(9, -7)); // across the arena
    surface.blit(new Uint8Array(32 * 24 * 4));
    expect(s.draws.at(-1)!.shadow!.near!.dirty).toBeNull(); // redrawn in full
  });

  it("is a high-quality feature: medium keeps the single map", async () => {
    const s = spy();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene(), s);
    surface.setQuality(QUALITY_PRESETS.medium);
    surface.setCameraOverride(camera(1, 1));
    surface.blit(new Uint8Array(32 * 24 * 4));
    expect(s.draws.at(-1)!.shadow).toBeTruthy();
    expect(s.draws.at(-1)!.shadow!.near ?? null).toBeNull();
  });
});

describe("the AAA tier's sun cascades (F2a)", () => {
  // A GPU renderer that shadows the sun itself, presented on the GPU.
  function cascaded(): SceneRenderer & { draws: GpuSceneDraw[]; drawn: (readonly MeshSceneInstance[])[] } {
    const draws: GpuSceneDraw[] = [];
    const drawn: (readonly MeshSceneInstance[])[] = [];
    return { backend: "webgpu", sunCascades: true, draws, drawn, render: () => {}, renderToTexture: (i, draw) => (draws.push(draw), drawn.push(i), {}), dispose: () => {} };
  }
  const presenter = { present: () => {}, stats: { luminance: null, sun: null } } as any;

  it("hands the renderer the casters and the sun in place of a CPU map", async () => {
    const r = cascaded();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene(), r, { presenter });
    surface.setCameraOverride(camera(1, 1));
    surface.blit(new Uint8Array(32 * 24 * 4));
    const draw = r.draws.at(-1)!;
    expect(draw.shadow ?? null).toBeNull();
    expect(draw.sunShadow!.casters).toHaveLength(3);
    expect(draw.sunShadow!.toLight).toEqual(sceneLightingKeyDirection(lighting));
    // Fitted to the scene (radius 17): its span, within the bounds.
    expect(draw.sunShadow!.distance).toBe(34);
    expect(draw.sunShadow!.reach).toBe(34);
    // The high preset's map size (F2a-2), and the real sun's size for its penumbrae.
    expect(draw.sunShadow!.size).toBe(4096);
    expect(draw.sunShadow!.softness).toBeCloseTo(SUN_SOFTNESS, 12);
    // The still casters are gathered once, not every frame.
    surface.blit(new Uint8Array(32 * 24 * 4));
    expect(r.draws.at(-1)!.sunShadow!.casters).toBe(draw.sunShadow!.casters);
  });

  it("casts foliage within its cull distance, and a layer with impostors from its full copies, never its cards", async () => {
    // Bushes on terrain that casts: one block round the camera's target, one 80 m off with a 40 m cull,
    // and a layer swapped to cards from 20 m: its full copies and its cards, both at 50 m.
    const bush = (name: string, x: number, foliage: object) => ({ mesh: box(name), model: composeModelMatrix([x, 0.5, 0], [0, 0, 0], [1, 1, 1]), terrain: true as const, casts: true as const, foliage: { center: [0, 0, 0] as [number, number, number], radius: 1, ...foliage } });
    const s = scene();
    const near = bush("near", 1, { cull: 40 });
    const far = bush("far", 80, { cull: 40 });
    const swapped = bush("swapped", 50, { cull: 200, swap: { distance: 20, far: false } });
    const cards = bush("cards", 50, { cull: 200, swap: { distance: 20, far: true } });
    const r = cascaded();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, { ...s, instances: [...s.instances, near, far, swapped, cards] }, r, { presenter });
    surface.setCameraOverride(camera(1, 1));
    surface.blit(new Uint8Array(32 * 24 * 4));
    const names = r.draws.at(-1)!.sunShadow!.casters.map((c) => c.mesh.name);
    expect(names).toContain("near");
    expect(names).not.toContain("far");
    // Past the swap the cards are drawn, but the full copies cast.
    expect(names).toContain("swapped");
    expect(names).not.toContain("cards");
    expect(names).toEqual(expect.arrayContaining(["floor", "pillar", "crate"]));
  });

  it("sizes its maps by quality level, and widens the sun for a rig's soft shadows (F2a-2)", async () => {
    const r = cascaded();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, { ...scene(), lighting: patchSceneLighting(lighting, { softShadows: true }) }, r, { presenter });
    surface.setQuality(QUALITY_PRESETS.medium);
    surface.setCameraOverride(camera(1, 1));
    surface.blit(new Uint8Array(32 * 24 * 4));
    expect(r.draws.at(-1)!.sunShadow!.size).toBe(2048);
    expect(r.draws.at(-1)!.sunShadow!.softness).toBeCloseTo(4 * SUN_SOFTNESS, 12);
  });

  it("hands the renderer the casters for its spot and point lights' tiles, not CPU maps (F2d)", async () => {
    const r = cascaded();
    const lamp = { kind: "point" as const, position: [0, 2, 0] as [number, number, number], range: 6, color: [1, 1, 1] as [number, number, number], intensity: 2, castShadows: true };
    const lit = { ...lighting, lights: [...lighting.lights, lamp] };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, { ...scene(), lighting: lit }, r, { presenter });
    surface.setCameraOverride(camera(1, 1));
    surface.blit(new Uint8Array(32 * 24 * 4));
    const draw = r.draws.at(-1)!;
    expect(draw.localShadows ?? null).toBeNull();
    expect(draw.localShadowCasters).toBe(draw.sunShadow!.casters);
    // And what the cached tiles hang on (F2d-2): the still casters' key, the same next frame, and no movers.
    expect(typeof draw.localShadowKey).toBe("string");
    expect(draw.localShadowMoved).toEqual([]);
    surface.blit(new Uint8Array(32 * 24 * 4));
    expect(r.draws.at(-1)!.localShadowKey).toBe(draw.localShadowKey);
    // Without a light that casts, none.
    const plain = cascaded();
    const bare = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene(), plain, { presenter });
    bare.setCameraOverride(camera(1, 1));
    bare.blit(new Uint8Array(32 * 24 * 4));
    expect(plain.draws.at(-1)!.localShadowCasters ?? null).toBeNull();
  });

  it("hands the renderer its reflection probes to capture on the GPU, and bakes none on the CPU (F3b)", async () => {
    const r = cascaded();
    const lit = { ...lighting, probes: [reflectionProbeAt([0, 1, 0], [10, 4, 10], "hall")] };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, { ...scene(), lighting: lit }, r, { presenter });
    await surface.probesReady;
    surface.setCameraOverride(camera(1, 1));
    surface.blit(new Uint8Array(32 * 24 * 4));
    const draw = r.draws.at(-1)!;
    expect(draw.reflectionCapture!.probes).toBe(lit.probes);
    expect(draw.reflectionCapture!.instances.map((i) => i.mesh.name).sort()).toEqual(["crate", "floor", "pillar"]);
    expect(draw.environment?.probes ?? null).toBeNull();
    // The key holds while nothing changes, so nothing is captured again.
    surface.blit(new Uint8Array(32 * 24 * 4));
    expect(r.draws.at(-1)!.reflectionCapture!.key).toBe(draw.reflectionCapture!.key);
    // Without probes, nothing to capture.
    const plain = cascaded();
    const bare = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene(), plain, { presenter });
    bare.setCameraOverride(camera(1, 1));
    bare.blit(new Uint8Array(32 * 24 * 4));
    expect(plain.draws.at(-1)!.reflectionCapture ?? null).toBeNull();
  });

  it("projects decals as boxes in place of their quads (F1f)", async () => {
    const r = cascaded();
    const pock = decalPreset("pock");
    const marks = [{ decal: pock.name, position: [0, 0.01, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], size: 0, spin: 0 }];
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, { ...scene(), decals: [pock], decalMarks: marks }, r, { presenter });
    surface.setCameraOverride(camera(1, 1));
    surface.blit(new Uint8Array(32 * 24 * 4));
    const draw = r.draws.at(-1)!;
    expect(draw.decals!.boxes).toHaveLength(1);
    expect(draw.decals!.boxes[0]!.center).toEqual([0, 0.01, 0]);
    expect(draw.decals!.tiles.count).toBe(1);
    // No quad mesh among what's drawn, and the tiles are drawn once.
    expect(r.drawn.at(-1)!.some((i) => i.mesh.name === "decals")).toBe(false);
    surface.blit(new Uint8Array(32 * 24 * 4));
    expect(r.draws.at(-1)!.decals!.tiles).toBe(draw.decals!.tiles);
  });

  it("reaches the rig's own shadow distance, and casts nothing with shadows off", async () => {
    const near = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, { ...scene(), lighting: patchSceneLighting(lighting, { shadowDistance: 60 }) }, cascaded(), { presenter });
    const r = (near as any).renderer as ReturnType<typeof cascaded>;
    near.setCameraOverride(camera(1, 1));
    near.blit(new Uint8Array(32 * 24 * 4));
    expect(r.draws.at(-1)!.sunShadow!.distance).toBe(60);
    const off = cascaded();
    const dark = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, { ...scene(), lighting: patchSceneLighting(lighting, { shadows: false }) }, off, { presenter });
    dark.setCameraOverride(camera(1, 1));
    dark.blit(new Uint8Array(32 * 24 * 4));
    expect(off.draws.at(-1)!.sunShadow ?? null).toBeNull();
    expect(off.draws.at(-1)!.shadow ?? null).toBeNull();
  });
});

describe("a rig's sun-shadow distance", () => {
  it("parses within its bounds, and clears back to fitting the scene", () => {
    expect(parseSceneLighting({ ...lighting, shadowDistance: 80 })?.shadowDistance).toBe(80);
    expect(parseSceneLighting({ ...lighting, shadowDistance: 1 })?.shadowDistance).toBe(MIN_SHADOW_DISTANCE);
    expect(parseSceneLighting({ ...lighting, shadowDistance: 1e9 })?.shadowDistance).toBe(MAX_SHADOW_DISTANCE);
    expect("shadowDistance" in (parseSceneLighting({ ...lighting, shadowDistance: -3 }) ?? {})).toBe(false);
    const set = patchSceneLighting(lighting, { shadowDistance: 120 });
    expect(set.shadowDistance).toBe(120);
    expect("shadowDistance" in patchSceneLighting(set, { shadowDistance: undefined })).toBe(false);
  });
});
