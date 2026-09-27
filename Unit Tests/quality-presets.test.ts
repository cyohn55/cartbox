/**
 * Graphics quality presets (ENGINE_ROADMAP.md, Phase 4): "auto" picks a preset
 * from the device, presets switch off the costly post-effects, and the mesh
 * overlay follows a preset's shadow and 3D-resolution settings.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, defaultSceneLighting, patchSceneLighting, type MeshAsset } from "@cartbox/editor";
import {
  MeshOverlaySurface,
  QUALITY_PRESETS,
  applyQualityToPostFx,
  defaultPostFxSettings,
  detectQuality,
  resolveQuality,
  type SceneDraw,
  type SceneRenderer,
} from "@cartbox/player";
import { DEFAULT_GAME_SETTINGS, parseGameSettings } from "../apps/web/src/lib/gameSettings";

describe("detecting a preset", () => {
  it("picks low for weak hardware, medium for phones and CPU rendering, else high", () => {
    expect(detectQuality({ cores: 2, memoryGB: 8, webgpu: true })).toBe("low");
    expect(detectQuality({ cores: 8, memoryGB: 2, webgpu: true })).toBe("low");
    expect(detectQuality({ cores: 8, memoryGB: 8, mobile: true, webgpu: true })).toBe("medium");
    expect(detectQuality({ cores: 8, memoryGB: 8, webgpu: false })).toBe("medium");
    expect(detectQuality({ cores: 8, memoryGB: 8, webgpu: true })).toBe("high");
    // Unknowns don't count against a device.
    expect(detectQuality({})).toBe("high");
  });

  it("resolves auto from the device and an explicit choice as given", () => {
    const weak = { cores: 2 };
    expect(resolveQuality("auto", weak).level).toBe("low");
    expect(resolveQuality(undefined, weak).level).toBe("low");
    expect(resolveQuality("high", weak).level).toBe("high");
    expect(resolveQuality("medium", {})).toBe(QUALITY_PRESETS.medium);
    // A stored value from elsewhere that isn't a preset falls back to high.
    expect(resolveQuality("ultra" as never, {}).level).toBe("high");
  });

  it("orders the presets from cheapest to richest", () => {
    const { low, medium, high } = QUALITY_PRESETS;
    expect(low.shadows).toBe(false);
    expect(medium.shadowMapSize).toBeLessThan(high.shadowMapSize);
    expect(low.maxRenderScale).toBeLessThan(medium.maxRenderScale);
    expect(medium.maxRenderScale).toBeLessThan(high.maxRenderScale);
  });
});

describe("post-effects under a preset", () => {
  const authored = () => {
    const fx = defaultPostFxSettings();
    return { ...fx, enabled: { ...fx.enabled, bloom: true, chroma: true, grade: true, crt: true } };
  };

  it("low switches off bloom and chromatic aberration but keeps the cheap looks", () => {
    const shown = applyQualityToPostFx(authored(), QUALITY_PRESETS.low);
    expect(shown.enabled.bloom).toBe(false);
    expect(shown.enabled.chroma).toBe(false);
    expect(shown.enabled.grade).toBe(true);
    expect(shown.enabled.crt).toBe(true);
    expect(shown.values).toEqual(authored().values);
  });

  it("leaves settings untouched (the same object) when nothing applies", () => {
    const fx = authored();
    expect(applyQualityToPostFx(fx, QUALITY_PRESETS.high)).toBe(fx);
    const plain = defaultPostFxSettings();
    expect(applyQualityToPostFx(plain, QUALITY_PRESETS.low)).toBe(plain);
  });
});

function cube(): MeshAsset {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return {
    name: "cube",
    primitives: [
      {
        positions: Float32Array.from(p),
        normals: Float32Array.from(p),
        uvs: null,
        indices: Uint32Array.from(idx),
        material: { name: "cube", baseColorFactor: [0.6, 0.6, 0.6, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 },
      },
    ],
  };
}

function litScene() {
  return {
    instances: [
      { mesh: cube(), model: composeModelMatrix([0, -0.5, 0], [0, 0, 0], [8, 1, 8]) },
      { mesh: cube(), model: composeModelMatrix([0, 0.5, 0], [0, 0, 0], [1, 1, 1]) },
    ],
    bounds: { min: [-4, -1, -4] as [number, number, number], max: [4, 1, 4] as [number, number, number], center: [0, 0, 0] as [number, number, number], radius: 6 },
    lighting: patchSceneLighting(defaultSceneLighting(), { shadows: true }),
  };
}

function recorder(backend: SceneRenderer["backend"]): SceneRenderer & { draws: SceneDraw[] } {
  const draws: SceneDraw[] = [];
  return { backend, draws, render: (_i, draw) => void draws.push({ ...draw, shadow: draw.shadow ? { ...draw.shadow } : null }), dispose: () => {} };
}

describe("the mesh overlay under a preset", () => {
  it("draws shadows at the preset's map size, and none on low", async () => {
    const renderer = recorder("webgpu");
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, litScene(), renderer);
    const frame = () => surface.blit(new Uint8Array(32 * 24 * 4));
    frame();
    expect(renderer.draws.at(-1)!.shadow!.size).toBe(1024);
    surface.setQuality(QUALITY_PRESETS.medium);
    frame();
    expect(renderer.draws.at(-1)!.shadow!.size).toBe(512);
    expect(renderer.draws.at(-1)!.shadow!.depth.length).toBe(512 * 512);
    surface.setQuality(QUALITY_PRESETS.low);
    frame();
    expect(renderer.draws.at(-1)!.shadow).toBeNull();
    surface.setQuality(QUALITY_PRESETS.high);
    frame();
    expect(renderer.draws.at(-1)!.shadow!.size).toBe(1024);
  });

  it("caps a software first-person view's 3D resolution", async () => {
    const renderer = recorder("software");
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 1280, 720, { ...litScene(), lighting: null }, renderer);
    surface.setHudMode(true);
    surface.setCameraOverride({ yaw: 0, pitch: 0, distance: 1, fov: 1.1, target: [0, 0, 0], hud: true });
    surface.setQuality(QUALITY_PRESETS.low);
    surface.blit(new Uint8Array(1280 * 720 * 4));
    expect(renderer.draws.at(-1)!.width).toBeLessThanOrEqual(640);
    const lowWidth = renderer.draws.at(-1)!.width;
    surface.setQuality(QUALITY_PRESETS.high);
    surface.blit(new Uint8Array(1280 * 720 * 4));
    expect(renderer.draws.at(-1)!.width).toBeGreaterThanOrEqual(lowWidth);
  });
});

describe("the quality setting", () => {
  it("defaults to auto and keeps only known presets", () => {
    expect(DEFAULT_GAME_SETTINGS.quality).toBe("auto");
    expect(parseGameSettings({ quality: "low" }).quality).toBe("low");
    expect(parseGameSettings({ quality: "high" }).quality).toBe("high");
    expect(parseGameSettings({ quality: "ultra" }).quality).toBe("auto");
    expect(parseGameSettings({}).quality).toBe("auto");
  });
});
