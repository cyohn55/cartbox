/**
 * Sun glare and lens flare (HALO2_STYLE_ROADMAP.md, H8): the flare maths the
 * shader ports, the post-FX effect and its uniforms, how much of the sun the
 * 3D overlay reports as unblocked, and Lockout's flare.
 */

import { describe, expect, it } from "vitest";

import { LOCKOUT_FX, defaultSceneLighting, serializeMeshAsset, sunVisibility, type MeshAsset } from "@cartbox/editor";
import {
  FLARE_GHOSTS,
  MeshOverlaySurface,
  POST_FX_EFFECTS,
  defaultPostFxSettings,
  lensFlareAt,
  paramKey,
  parseMeshScene,
  parsePostFxSettings,
  uniformsFromSettings,
  type SceneDraw,
  type SceneRenderer,
  type ScreenSun,
} from "@cartbox/player";

const params = { glare: 1, ghosts: 1, size: 0.1, visible: 1 };
const lum = (c: [number, number, number]) => c[0] + c[1] + c[2];

describe("flare maths", () => {
  it("glares brightest on the light, with starburst spikes, and fades with visibility", () => {
    const o: [number, number] = [0.7, 0.2];
    const on = lum(lensFlareAt(o, o, 16 / 9, params));
    expect(on).toBeGreaterThan(lum(lensFlareAt([0.7, 0.3], o, 16 / 9, params)) * 2);
    // Along a spike (level with the light) beats between spikes at the same distance.
    const r = 0.18;
    const spike = lum(lensFlareAt([o[0] + r / (16 / 9), o[1]], o, 16 / 9, { ...params, ghosts: 0 }));
    const off = Math.PI / 6; // halfway between two spikes
    const gap = lum(lensFlareAt([o[0] + (Math.cos(off) * r) / (16 / 9), o[1] + Math.sin(off) * r], o, 16 / 9, { ...params, ghosts: 0 }));
    expect(spike).toBeGreaterThan(gap * 3);
    expect(lum(lensFlareAt(o, o, 16 / 9, { ...params, visible: 0.5 }))).toBeCloseTo(on / 2, 6);
    expect(lensFlareAt(o, o, 16 / 9, { ...params, visible: 0 })).toEqual([0, 0, 0]);
    expect(lensFlareAt(o, o, 16 / 9, { ...params, glare: 0, ghosts: 0 })).toEqual([0, 0, 0]);
  });

  it("strings ghosts through the frame centre to the far side, each with its tint", () => {
    const o: [number, number] = [0.8, 0.2];
    for (const ghost of FLARE_GHOSTS) {
      const at: [number, number] = [0.5 + (o[0] - 0.5) * ghost.along, 0.5 + (o[1] - 0.5) * ghost.along];
      const c = lensFlareAt(at, o, 1.6, { ...params, glare: 0 });
      expect(lum(c)).toBeGreaterThan(0.1);
      // Its hue is its tint's.
      const bluest = ghost.tint[2] >= ghost.tint[0];
      expect(c[2] >= c[0]).toBe(bluest);
    }
    // Past the centre, opposite the light: some ghost lands on the lower left.
    const far = FLARE_GHOSTS.filter((g) => g.along < 0);
    expect(far.length).toBeGreaterThan(1);
  });
});

describe("post-FX effect", () => {
  it("is in the stack, neutral when off, and follows its source point", () => {
    expect(POST_FX_EFFECTS.some((e) => e.id === "lensflare")).toBe(true);
    const settings = defaultPostFxSettings();
    let u = uniformsFromSettings(settings);
    expect(u.flareGlare).toBe(0);
    expect(u.flareGhosts).toBe(0);
    expect(u.flareVisible).toBe(1);
    settings.enabled.lensflare = true;
    settings.values[paramKey("lensflare", "glare")] = 1.5;
    settings.values[paramKey("lensflare", "x")] = 0.3;
    settings.values[paramKey("lensflare", "y")] = 0.6;
    settings.colors[paramKey("lensflare", "tint")] = "#ff8000";
    u = uniformsFromSettings(settings);
    expect(u.flareGlare).toBe(1.5);
    expect(u.flareGhosts).toBeGreaterThan(0);
    expect(u.flareOrigin).toEqual([0.3, 0.6]);
    expect(u.flareColor[0]).toBe(1);
    expect(u.flareColor[2]).toBe(0);
    const parsed = parsePostFxSettings({ enabled: { lensflare: true }, values: { "lensflare.glare": 99, "lensflare.size": -1 } })!;
    expect(parsed.values["lensflare.glare"]).toBe(2);
    expect(parsed.values["lensflare.size"]).toBe(0.03);
  });
});

describe("sun visibility", () => {
  const W = 40;
  const H = 30;
  const sky = new Uint8ClampedArray(W * H * 4).fill(200);
  it("measures how much of the sun shows", () => {
    expect(sunVisibility(sky.slice(), sky, W, H, { x: 20, y: 15 })).toBe(1);
    const covered = sky.slice();
    for (let y = 0; y < H; y += 1) for (let x = 20; x < W; x += 1) covered.set([10, 10, 10, 255], (y * W + x) * 4);
    const half = sunVisibility(covered, sky, W, H, { x: 20, y: 15 });
    expect(half).toBeGreaterThan(0.2);
    expect(half).toBeLessThan(0.8);
    expect(sunVisibility(covered, sky, W, H, { x: 35, y: 15 })).toBe(0);
    expect(sunVisibility(sky.slice(), sky, W, H, { x: -20, y: 15 })).toBe(0); // off screen
  });

  it("is reported by the first-person overlay over the sky dome, eased, and null without one", async () => {
    const tri: MeshAsset = {
      name: "t",
      primitives: [
        {
          positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normals: null,
          uvs: null,
          indices: Uint32Array.from([0, 1, 2]),
          material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
        },
      ],
    };
    const json = (sky: boolean, sun: [number, number, number] = [0, 1, 0]) =>
      JSON.stringify({
        version: 2,
        meshes: [{ id: "a", name: "a", mesh: serializeMeshAsset(tri), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
        lighting: { ...defaultSceneLighting(), ...(sky ? { sky: { sunDirection: sun } } : {}) },
      });
    let look: readonly number[] = [];
    const renderer: SceneRenderer = { backend: "software", render: (_i, d: SceneDraw) => void (look = d.view), dispose: () => {} };
    const make = async (text: string) => {
      const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 48, 32, parseMeshScene(text)!, renderer);
      surface.setHudMode(true);
      const seen: (ScreenSun | null)[] = [];
      surface.onSun = (s) => seen.push(s);
      return { surface, seen };
    };
    const probe = await make(json(true));
    probe.surface.blit(new Uint8Array(48 * 32 * 4));
    const ahead: [number, number, number] = [-look[2]!, -look[6]!, -look[10]!];
    const { surface, seen } = await make(json(true, ahead));
    for (let i = 0; i < 12; i += 1) surface.blit(new Uint8Array(48 * 32 * 4));
    expect(seen[0]!.x).toBeCloseTo(0.5, 1);
    expect(seen[0]!.y).toBeCloseTo(0.5, 1);
    // Nothing covers it: visibility eases up toward 1.
    expect(seen[0]!.visible).toBeGreaterThan(0.2);
    expect(seen[0]!.visible).toBeLessThan(0.5);
    expect(seen.at(-1)!.visible).toBeGreaterThan(0.95);
    const none = await make(json(false));
    none.surface.blit(new Uint8Array(48 * 32 * 4));
    expect(none.seen).toEqual([null]);
  });
});

describe("Lockout", () => {
  it("flares the sun", () => {
    const fx = parsePostFxSettings(LOCKOUT_FX)!;
    expect(fx.enabled.lensflare).toBe(true);
    const u = uniformsFromSettings(fx);
    expect(u.flareGlare).toBeGreaterThan(0);
    expect(u.flareGhosts).toBeGreaterThan(0);
  });
});
