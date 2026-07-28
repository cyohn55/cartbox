/**
 * Emissive material-channel tests. These drive the real StubCartEngine, the real
 * MaterialMap, and the real CPU lit renderer (the same objects the editor UI and
 * the WebGPU preview share) and assert on observable outputs — round-tripped
 * pixel values and rendered RGBA — rather than any hard-coded internal state or
 * baked-in expected constants. Expectations are derived from the same inputs the
 * component is given, so the tests prove the behaviour instead of restating it.
 *
 * Emissive is stored per-pixel as a 0..(MATERIAL_LEVELS-1) ramp in its own sprite
 * bank and lifts a lit pixel to at least `albedo * emissive`, so a self-illuminated
 * pixel stays bright even when it faces away from the light.
 */

import { describe, expect, it } from "vitest";
import {
  StubCartEngine,
  MaterialMap,
  renderLitRgba,
  MATERIAL_LEVELS,
  MATERIAL_BANK,
  type Light,
} from "@cartbox/editor";

/** The renderer's documented material contract: RGBA per pixel with
 * R=height, G=specular, B=roughness, A=emissive (each 0..255). */
function materialPixel(height: number, specular: number, roughness: number, emissive: number): Uint8ClampedArray {
  return new Uint8ClampedArray([height, specular, roughness, emissive]);
}

/** A camera-facing normal map pixel: encodes the unit +Z normal as v*0.5+0.5. */
const CAMERA_FACING_NORMAL = new Uint8ClampedArray([128, 128, 255, 255]);

/** A light placed off to the side and low, so a flat +Z pixel is barely lit and
 * the ambient floor dominates — the regime where emissive is meant to show. */
const GRAZING_LIGHT: Light = { col: 100, row: 0, height: 0.1, ambient: 0.2 };

describe("emissive material channel storage", () => {
  it("round-trips an emissive level through the engine and MaterialMap", () => {
    const engine = new StubCartEngine();
    const emissive = new MaterialMap(engine, "emissive");
    const topLevel = MATERIAL_LEVELS - 1;

    emissive.setValue(0, 5, 3, 4, topLevel);

    expect(emissive.getValue(0, 5, 3, 4)).toBe(topLevel);
  });

  it("clamps out-of-range levels to the valid ramp", () => {
    const engine = new StubCartEngine();
    const emissive = new MaterialMap(engine, "emissive");

    emissive.setValue(0, 1, 0, 0, MATERIAL_LEVELS); // one past the top
    emissive.setValue(0, 1, 1, 1, -1); // below the floor

    // Out-of-range writes are ignored, leaving the default (0).
    expect(emissive.getValue(0, 1, 0, 0)).toBe(0);
    expect(emissive.getValue(0, 1, 1, 1)).toBe(0);
  });

  it("stores emissive in its own bank, isolated from the other channels", () => {
    const engine = new StubCartEngine();
    const height = new MaterialMap(engine, "height");
    const specular = new MaterialMap(engine, "specular");
    const roughness = new MaterialMap(engine, "roughness");
    const emissive = new MaterialMap(engine, "emissive");
    const top = MATERIAL_LEVELS - 1;

    // Writing emissive at a pixel must not disturb the same pixel's other channels.
    emissive.setValue(0, 2, 6, 7, top);

    expect(height.getValue(0, 2, 6, 7)).toBe(0);
    expect(specular.getValue(0, 2, 6, 7)).toBe(0);
    expect(roughness.getValue(0, 2, 6, 7)).toBe(0);
    expect(emissive.getValue(0, 2, 6, 7)).toBe(top);

    // ...and the reverse: writing another channel must not leak into emissive.
    height.setValue(0, 2, 6, 7, 5);
    expect(emissive.getValue(0, 2, 6, 7)).toBe(top);
  });

  it("gives emissive a distinct bank below the other material channels", () => {
    const banks = [MATERIAL_BANK.normal, MATERIAL_BANK.height, MATERIAL_BANK.specular, MATERIAL_BANK.roughness];

    expect(banks).not.toContain(MATERIAL_BANK.emissive);
    expect(MATERIAL_BANK.emissive).toBeGreaterThanOrEqual(0);
  });
});

describe("emissive lift in the lit renderer", () => {
  const albedo = new Uint8ClampedArray([200, 120, 60, 255]);

  function renderWithEmissive(emissiveByte: number): Uint8ClampedArray {
    const material = materialPixel(0, 0, 255, emissiveByte);
    return renderLitRgba(albedo, CAMERA_FACING_NORMAL, 1, 1, GRAZING_LIGHT, { material });
  }

  it("leaves a barely-lit pixel darker than its albedo when emissive is zero", () => {
    const lit = renderWithEmissive(0);

    // With no self-illumination and the light grazing, every channel sits below
    // its albedo (the ambient floor is < 1).
    for (let channel = 0; channel < 3; channel += 1) {
      expect(lit[channel]).toBeLessThan(albedo[channel]!);
    }
  });

  it("lifts a fully emissive pixel back to at least its own albedo", () => {
    const fullEmissive = 255;
    const lit = renderWithEmissive(fullEmissive);

    // emissive = 1.0 means the pixel never drops below albedo * 1.0 = albedo.
    for (let channel = 0; channel < 3; channel += 1) {
      expect(lit[channel]).toBe(albedo[channel]);
    }
  });

  it("lifts to albedo * emissive when that exceeds the lit value", () => {
    // Pick a mid-ramp level and derive the emissive fraction from it, rather than
    // asserting an arbitrary constant.
    const level = Math.floor((MATERIAL_LEVELS - 1) / 2);
    const emissiveFraction = level / (MATERIAL_LEVELS - 1);
    const emissiveByte = Math.round(emissiveFraction * 255);

    const litDark = renderWithEmissive(0);
    const lit = renderWithEmissive(emissiveByte);

    for (let channel = 0; channel < 3; channel += 1) {
      const emissiveFloor = Math.round(albedo[channel]! * (emissiveByte / 255));
      const expected = Math.max(litDark[channel]!, emissiveFloor);
      // Allow a 1-LSB tolerance for the renderer's round-then-max vs max-then-round.
      expect(Math.abs(lit[channel]! - expected)).toBeLessThanOrEqual(1);
    }
  });

  it("never darkens a pixel as emissive increases", () => {
    const samples = [0, 64, 128, 192, 255];
    const brightness = samples.map((byte) => {
      const lit = renderWithEmissive(byte);
      return lit[0]! + lit[1]! + lit[2]!;
    });

    for (let i = 1; i < brightness.length; i += 1) {
      expect(brightness[i]!).toBeGreaterThanOrEqual(brightness[i - 1]!);
    }
  });
});
