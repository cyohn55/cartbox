/**
 * Spot and point light shadows (ENGINE_PARITY_ROADMAP.md EP8c): which lights
 * cast and the tiles they get, a point light's face for a direction, the
 * shadow test itself, the stored flag, and the mesh overlay building and
 * caching the tiles each frame.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_LOCAL_SHADOW_TILES,
  assignLocalShadowTiles,
  castsLocalShadow,
  composeModelMatrix,
  defaultSceneLighting,
  localShadowFace,
  localShadowViews,
  localShadowVisibility,
  parseSceneLighting,
  patchSceneLighting,
  type SceneLight,
} from "@cartbox/editor";
import { MeshOverlaySurface, type SceneDraw, type SceneRenderer } from "@cartbox/player";

import { blockMesh, localShadowRig } from "./helpers/localShadowScene";

const spot = (over: Partial<SceneLight> = {}): SceneLight => ({ kind: "spot", position: [0, 3, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 2, range: 8, outerAngle: 30, castShadows: true, ...over });
const point = (over: Partial<SceneLight> = {}): SceneLight => ({ kind: "point", position: [0, 2, 0], color: [1, 1, 1], intensity: 2, range: 6, castShadows: true, ...over });

describe("which lights cast, and their tiles", () => {
  it("needs a ranged point or spot light that asks to cast", () => {
    expect(castsLocalShadow(spot())).toBe(true);
    expect(castsLocalShadow(spot({ range: 0 }))).toBe(false);
    expect(castsLocalShadow(spot({ castShadows: undefined }))).toBe(false);
    expect(castsLocalShadow({ kind: "directional", direction: [0, 1, 0], color: [1, 1, 1], intensity: 1, castShadows: true })).toBe(false);
  });

  it("gives a spot one tile and a point light six, in order, until the atlas is full", () => {
    const { lights, tiles } = assignLocalShadowTiles([spot(), point({ castShadows: false }), point(), spot()]);
    expect(lights.map((l) => l.shadowTile)).toEqual([0, undefined, 1, 7]);
    expect(tiles).toBe(8);
    const many = assignLocalShadowTiles(Array.from({ length: 4 }, () => point()));
    expect(many.lights.map((l) => l.shadowTile)).toEqual([0, 6, undefined, undefined]); // a third point light would overflow 16
    expect(many.tiles).toBeLessThanOrEqual(MAX_LOCAL_SHADOW_TILES);
    expect(localShadowViews(point())).toHaveLength(6);
    expect(localShadowViews(spot())).toHaveLength(1);
  });

  it("picks a point light's face by the direction's dominant axis", () => {
    expect([localShadowFace(1, 0.2, 0.3), localShadowFace(-1, 0.2, 0.3), localShadowFace(0.1, 2, 0), localShadowFace(0.1, -2, 0), localShadowFace(0, 0.1, 3), localShadowFace(0, 0.1, -3)]).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("keeps the flag through the stored lighting rig", () => {
    const lighting = parseSceneLighting({ lights: [{ ...point(), castShadows: true }, { ...point(), castShadows: "yes" }] })!;
    expect(lighting.lights.map((l) => l.castShadows ?? false)).toEqual([true, false]);
  });
});

describe("the shadow test", () => {
  const rig = localShadowRig();
  const spotLight = rig.lights.find((l) => l.kind === "spot")!;
  const pointLight = rig.lights.find((l) => l.kind === "point")!;

  it("shadows the floor behind the block from the spot, and lights it in the open", () => {
    // The block sits at (−1.2, 0.5, 0), under the spot at (−1.2, 3.2, 0.6) aimed down.
    expect(localShadowVisibility(rig.localShadows, spotLight.shadowTile!, spotLight, -1.2, 0, -0.1, 1)).toBe(0);
    expect(localShadowVisibility(rig.localShadows, spotLight.shadowTile!, spotLight, -1.2, 0, 2.2, 1)).toBe(1);
    // The block's own top faces the light: no acne.
    expect(localShadowVisibility(rig.localShadows, spotLight.shadowTile!, spotLight, -1.2, 1, 0, 1)).toBe(1);
  });

  it("shadows the floor behind the post from the point light, through the face that sees it", () => {
    // The post stands at (1.62, 0–2, 0.43); the light at (2.4, 1.2, 1.1). Behind the post, away from the light:
    const behind: [number, number, number] = [1.62 - (2.4 - 1.62) * 0.9, 0, 0.43 - (1.1 - 0.43) * 0.9];
    expect(localShadowVisibility(rig.localShadows, pointLight.shadowTile!, pointLight, ...behind, 1)).toBeLessThan(0.5);
    expect(localShadowVisibility(rig.localShadows, pointLight.shadowTile!, pointLight, 3.5, 0, 2.5, 1)).toBe(1);
  });
});

describe("the mesh overlay", () => {
  const lighting = patchSceneLighting(defaultSceneLighting(), { shadows: true, lights: [...defaultSceneLighting().lights, spot({ position: [0, 4, 0] })] });
  const scene = () => ({
    instances: [
      { mesh: blockMesh(5, 0.05, 5), model: composeModelMatrix([0, -0.05, 0], [0, 0, 0], [1, 1, 1]) },
      { mesh: blockMesh(0.5, 0.5, 0.5), model: composeModelMatrix([0, 0.5, 0], [0, 0, 0], [1, 1, 1]) },
    ],
    bounds: { min: [-5, 0, -5] as [number, number, number], max: [5, 1, 5] as [number, number, number], center: [0, 0.5, 0] as [number, number, number], radius: 7 },
    lighting,
  });
  function spyRenderer(): SceneRenderer & { draws: SceneDraw[] } {
    const draws: SceneDraw[] = [];
    return { backend: "webgpu", draws, render: (_i, draw) => draws.push(draw), dispose: () => {} };
  }

  it("hands the renderer the casting light's tiles, with the light pointing at them, reusing them frame to frame", async () => {
    const spy = spyRenderer();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene(), spy);
    surface.blit(new Uint8Array(32 * 24 * 4));
    surface.blit(new Uint8Array(32 * 24 * 4));
    const [a, b] = spy.draws.slice(-2) as [SceneDraw, SceneDraw];
    expect(a.localShadows?.tiles).toHaveLength(1);
    expect(a.lights!.find((l) => l.kind === "spot")!.shadowTile).toBe(0);
    // The block shadows the floor below it in the tile (something nearer than the far plane at its centre).
    expect(Math.min(...a.localShadows!.tiles[0]!.depth)).toBeLessThan(1);
    // The same arrays, refilled: the still scene isn't redrawn every frame.
    expect(b.localShadows!.tiles[0]!.depth).toBe(a.localShadows!.tiles[0]!.depth);
  });
});
