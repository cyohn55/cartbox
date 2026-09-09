/**
 * RenderCaps — the rendering-semantics half of a console model.
 *
 * Display specs distinguish the 2D models from each other but cannot express
 * what separates the era models on the roadmap (ERA_MODELS.md): a PS1-era model
 * is defined by having no depth buffer and affine texture mapping, an N64-era
 * model by trilinear filtering and a 4KB texture cache.
 *
 * These tests pin the two properties that make the field worth carrying: every
 * model declares caps (so a new model cannot silently inherit someone else's
 * rendering behaviour), and no fantasy-console model grants programmable
 * shaders — the trait that would dissolve the fixed-spec guarantee the platform
 * layer depends on.
 */

import { describe, expect, it } from "vitest";
import { MODELS, SOFTWARE_RASTER_CAPS, type ConsoleModel } from "@cartbox/player";

const models = Object.values(MODELS) as ConsoleModel[];

describe("RenderCaps", () => {
  it("is declared by every model", () => {
    for (const model of models) {
      expect(model.renderCaps, `${model.id} has no renderCaps`).toBeDefined();
    }
  });

  it("grants programmable shaders to no shipping model", () => {
    // A model that lets creators supply shaders is not a fixed spec, and the
    // platform layer (replays, verification, thumbnails) assumes a fixed spec.
    // Only a deliberately unconstrained tier could set this, and none exists.
    for (const model of models) {
      expect(model.renderCaps.programmableShaders, `${model.id}`).toBe(false);
    }
  });

  it("describes what the shared software rasteriser actually does today", () => {
    // The 2D models rasterise triangles through the same overlay surfaces, so
    // identical caps are correct rather than lazy. This fails the day one of
    // their renderers diverges without its descriptor following.
    //
    // PS1 is the deliberate exception, and the exclusion is what makes it one:
    // an era model that quietly matched these caps would render like every
    // other model while claiming a period. Its own spec test pins the
    // difference (see ps1-model-spec.test.ts).
    for (const model of models.filter((m) => m.id !== "ps1")) {
      expect(model.renderCaps, `${model.id}`).toEqual(SOFTWARE_RASTER_CAPS);
    }
    expect(SOFTWARE_RASTER_CAPS.zBuffer).toBe(true);
    expect(SOFTWARE_RASTER_CAPS.perspectiveCorrect).toBe(true);
    expect(SOFTWARE_RASTER_CAPS.textureFiltering).toBe("none");
  });

  it("treats zero budgets as unbounded rather than as a ban", () => {
    // 0 means "no ceiling", so a model that enforces nothing must not read as a
    // model that forbids everything.
    for (const model of models.filter((m) => m.id !== "ps1")) {
      expect(model.renderCaps.textureCacheBytes).toBe(0);
      expect(model.renderCaps.polyBudget).toBe(0);
    }
    // And an era model sets real numbers, which is the case the zero is
    // distinguished from.
    expect(MODELS.ps1.renderCaps.textureCacheBytes).toBeGreaterThan(0);
    expect(MODELS.ps1.renderCaps.polyBudget).toBeGreaterThan(0);
  });
});
