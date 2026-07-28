/**
 * Material derivation tests — reading normal, height, specular, roughness and
 * emissive back out of the art a sprite is already drawn with.
 *
 * These drive the real StubCartEngine through the real SpriteSheet, NormalMap
 * and MaterialMap views, and read every assertion back off the engine after the
 * derivation has run. Nothing is asserted against a hard-coded channel value:
 * every expectation is computed from the art that was painted, using the same
 * public `luminance` the derivation itself is defined in terms of, so the tests
 * check the *relationships* the heuristics promise rather than memorising the
 * numbers one particular tuning happens to produce.
 */

import { describe, expect, it } from "vitest";
import {
  MATERIAL_LEVELS,
  MaterialMap,
  NormalMap,
  SpriteSheet,
  StubCartEngine,
  applyDerivedMaterials,
  defaultMaterialDeriveParams,
  deriveMaterials,
  luminance,
  normalVector,
  normalizeMaterialDeriveParams,
  quantizeLevel,
  DERIVABLE_CHANNELS,
  MATERIAL_DERIVE_PARAMS,
  type MaterialChannel,
  type SheetImage,
  type SpritePage,
} from "@cartbox/editor";
import { readBlockAlbedo } from "../apps/web/src/app/edit/[cartId]/blockBuffers";

const PAGE: SpritePage = 0;
const TILE = 1;

/** A fresh engine with the real sheet and the real channel views over it. */
function makeRig() {
  const engine = new StubCartEngine();
  const sheet = new SpriteSheet(engine);
  const normals = new NormalMap(engine);
  const height = new MaterialMap(engine, "height");
  const specular = new MaterialMap(engine, "specular");
  const roughness = new MaterialMap(engine, "roughness");
  const emissive = new MaterialMap(engine, "emissive");
  const writers = { normal: normals, height, specular, roughness, emissive };
  const target = {
    page: PAGE,
    tile: TILE,
    tilesWide: 1,
    tilesHigh: 1,
    tileSize: sheet.tileSize,
    sheetCols: sheet.sheetCols,
  };
  return { engine, sheet, normals, height, specular, roughness, emissive, writers, target };
}

/** The block the tools operate on, read the same way the editor reads it. */
function blockImage(sheet: SpriteSheet): SheetImage {
  return {
    data: readBlockAlbedo(sheet, PAGE, TILE, 1),
    width: sheet.tileSize,
    height: sheet.tileSize,
  };
}

/** Palette indices ordered dark to light, so a ramp can be painted from the real palette. */
function paletteByLuminance(sheet: SpriteSheet): number[] {
  return sheet
    .paletteRgb()
    .map((rgb, index) => ({ index, value: luminance(rgb[0], rgb[1], rgb[2]) }))
    .sort((a, b) => a.value - b.value)
    .map((entry) => entry.index);
}

/**
 * Paint a left-to-right brightness ramp across the tile: column x takes the
 * x-th darkest palette colour, so luminance rises monotonically with x.
 */
function paintRamp(sheet: SpriteSheet): number[] {
  const order = paletteByLuminance(sheet);
  const columns: number[] = [];
  for (let x = 0; x < sheet.tileSize; x += 1) {
    const colorIndex = order[Math.floor((x / sheet.tileSize) * order.length)] ?? 0;
    columns.push(colorIndex);
    for (let y = 0; y < sheet.tileSize; y += 1) sheet.setPixel(PAGE, TILE, x, y, colorIndex);
  }
  return columns;
}

describe("material derivation parameters", () => {
  it("defaults exactly to what the descriptors declare", () => {
    const defaults = defaultMaterialDeriveParams() as unknown as Record<string, number>;
    for (const spec of MATERIAL_DERIVE_PARAMS) {
      expect(defaults[spec.key]).toBe(spec.value);
    }
    expect(Object.keys(defaults).sort()).toEqual(MATERIAL_DERIVE_PARAMS.map((spec) => spec.key).sort());
  });

  it("clamps every value into its declared range and drops unknown keys", () => {
    const wild: Record<string, number> = { nonsense: 42 };
    for (const spec of MATERIAL_DERIVE_PARAMS) wild[spec.key] = spec.max * 1000;
    const clamped = normalizeMaterialDeriveParams(wild) as unknown as Record<string, number>;

    for (const spec of MATERIAL_DERIVE_PARAMS) expect(clamped[spec.key]).toBe(spec.max);
    expect(clamped.nonsense).toBeUndefined();
  });

  it("falls back to the declared default for a missing or unusable value", () => {
    const spec = MATERIAL_DERIVE_PARAMS[0]!;
    const restored = normalizeMaterialDeriveParams({ [spec.key]: Number.NaN }) as unknown as Record<string, number>;
    expect(restored[spec.key]).toBe(spec.value);
  });
});

describe("quantizeLevel", () => {
  it("spans the cart's full level range and clamps beyond it", () => {
    expect(quantizeLevel(0)).toBe(0);
    expect(quantizeLevel(1)).toBe(MATERIAL_LEVELS - 1);
    expect(quantizeLevel(-5)).toBe(0);
    expect(quantizeLevel(5)).toBe(MATERIAL_LEVELS - 1);
  });

  it("is monotonic in its input", () => {
    let previous = -1;
    for (let step = 0; step <= 20; step += 1) {
      const level = quantizeLevel(step / 20);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });
});

describe("deriving height from art", () => {
  it("orders height by the luminance of the colours actually painted", () => {
    const { sheet, writers, target } = makeRig();
    const columns = paintRamp(sheet);
    const palette = sheet.paletteRgb();

    const derived = deriveMaterials(blockImage(sheet), defaultMaterialDeriveParams());
    applyDerivedMaterials(derived, writers, target, ["height"]);

    const heights = columns.map((_unused, x) => writers.height.getValue(PAGE, TILE, x, 4));
    const luminances = columns.map((index) => {
      const rgb = palette[index]!;
      return luminance(rgb[0], rgb[1], rgb[2]);
    });

    // Every pair must agree in order with the luminance that produced it.
    for (let a = 0; a < heights.length; a += 1) {
      for (let b = a + 1; b < heights.length; b += 1) {
        if (luminances[a]! < luminances[b]!) expect(heights[a]!).toBeLessThanOrEqual(heights[b]!);
        if (luminances[a]! > luminances[b]!) expect(heights[a]!).toBeGreaterThanOrEqual(heights[b]!);
      }
    }
    // The ramp really did produce a range, rather than one flat value.
    expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights));
  });

  it("inverts the relationship when asked to", () => {
    const { sheet } = makeRig();
    paintRamp(sheet);
    const params = defaultMaterialDeriveParams();

    const upright = deriveMaterials(blockImage(sheet), params);
    const inverted = deriveMaterials(blockImage(sheet), { ...params, heightInvert: 1 });

    for (let index = 0; index < upright.heightField.length; index += 1) {
      expect(inverted.heightField[index]!).toBeCloseTo(1 - upright.heightField[index]!, 5);
    }
  });
});

describe("deriving normals from art", () => {
  it("tilts away from the rising side of a brightness ramp", () => {
    const { sheet, writers, target } = makeRig();
    paintRamp(sheet);

    // A strong tilt, so the sixteen available directions can actually express it.
    const params = { ...defaultMaterialDeriveParams(), normalStrength: 8 };
    const derived = deriveMaterials(blockImage(sheet), params);
    applyDerivedMaterials(derived, writers, target, ["normal"]);

    let totalX = 0;
    for (let x = 0; x < sheet.tileSize; x += 1) {
      totalX += normalVector(writers.normal.getDirection(PAGE, TILE, x, 4))[0];
    }
    // Height rises left to right, so the surface faces back toward the dark side.
    expect(totalX).toBeLessThan(0);
  });

  it("leaves flat art flat", () => {
    const { sheet, writers, target } = makeRig();
    for (let y = 0; y < sheet.tileSize; y += 1) {
      for (let x = 0; x < sheet.tileSize; x += 1) sheet.setPixel(PAGE, TILE, x, y, 7);
    }

    const derived = deriveMaterials(blockImage(sheet), defaultMaterialDeriveParams());
    applyDerivedMaterials(derived, writers, target, ["normal"]);

    for (let y = 0; y < sheet.tileSize; y += 1) {
      for (let x = 0; x < sheet.tileSize; x += 1) {
        const [nx, ny, nz] = normalVector(writers.normal.getDirection(PAGE, TILE, x, y));
        expect(nx).toBe(0);
        expect(ny).toBe(0);
        expect(nz).toBe(1);
      }
    }
  });
});

describe("writing derived channels back into the cart", () => {
  it("touches only the channels it is asked for", () => {
    const { sheet, writers, target, specular, roughness, emissive, normals } = makeRig();
    paintRamp(sheet);

    const before = {
      specular: specular.getValue(PAGE, TILE, 3, 3),
      roughness: roughness.getValue(PAGE, TILE, 3, 3),
      emissive: emissive.getValue(PAGE, TILE, 3, 3),
      normal: normals.getDirection(PAGE, TILE, 3, 3),
    };

    const derived = deriveMaterials(blockImage(sheet), defaultMaterialDeriveParams());
    applyDerivedMaterials(derived, writers, target, ["height"]);

    expect(specular.getValue(PAGE, TILE, 3, 3)).toBe(before.specular);
    expect(roughness.getValue(PAGE, TILE, 3, 3)).toBe(before.roughness);
    expect(emissive.getValue(PAGE, TILE, 3, 3)).toBe(before.emissive);
    expect(normals.getDirection(PAGE, TILE, 3, 3)).toBe(before.normal);
  });

  it("writes nothing, and reports nothing, when no channel is selected", () => {
    const { sheet, writers, target } = makeRig();
    paintRamp(sheet);
    const derived = deriveMaterials(blockImage(sheet), defaultMaterialDeriveParams());
    expect(applyDerivedMaterials(derived, writers, target, [])).toBe(0);
  });

  it("skips a channel whose writer was not supplied", () => {
    const { sheet, target, height } = makeRig();
    paintRamp(sheet);
    const derived = deriveMaterials(blockImage(sheet), defaultMaterialDeriveParams());

    // Only a height writer is offered, but every channel is requested.
    const written = applyDerivedMaterials(derived, { height }, target, DERIVABLE_CHANNELS);
    expect(written).toBe(sheet.tileSize * sheet.tileSize);
  });

  it("leaves transparent pixels alone", () => {
    const { sheet, writers, target, height } = makeRig();
    paintRamp(sheet);

    // Hole out the right half of the block, and mark it with a value the
    // derivation could not plausibly produce for that art.
    const image = blockImage(sheet);
    const sentinel = MATERIAL_LEVELS - 1;
    const half = sheet.tileSize / 2;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = half; x < image.width; x += 1) {
        image.data[(y * image.width + x) * 4 + 3] = 0;
        height.setValue(PAGE, TILE, x, y, sentinel);
      }
    }

    const derived = deriveMaterials(image, defaultMaterialDeriveParams());
    const written = applyDerivedMaterials(derived, writers, target, ["height"]);

    expect(written).toBe(half * sheet.tileSize);
    for (let y = 0; y < sheet.tileSize; y += 1) {
      for (let x = half; x < sheet.tileSize; x += 1) {
        expect(height.getValue(PAGE, TILE, x, y)).toBe(sentinel);
      }
    }
  });

  it("is deterministic: the same art derives the same channels twice", () => {
    const first = makeRig();
    const second = makeRig();
    paintRamp(first.sheet);
    paintRamp(second.sheet);

    const params = defaultMaterialDeriveParams();
    const channels: readonly MaterialChannel[] = DERIVABLE_CHANNELS;
    applyDerivedMaterials(deriveMaterials(blockImage(first.sheet), params), first.writers, first.target, channels);
    applyDerivedMaterials(deriveMaterials(blockImage(second.sheet), params), second.writers, second.target, channels);

    for (let y = 0; y < first.sheet.tileSize; y += 1) {
      for (let x = 0; x < first.sheet.tileSize; x += 1) {
        expect(first.normals.getDirection(PAGE, TILE, x, y)).toBe(second.normals.getDirection(PAGE, TILE, x, y));
        for (const channel of ["height", "specular", "roughness", "emissive"] as const) {
          expect(first[channel].getValue(PAGE, TILE, x, y)).toBe(second[channel].getValue(PAGE, TILE, x, y));
        }
      }
    }
  });
});

describe("the brightness and saturation heuristics", () => {
  it("only lights the pixels above the glow threshold", () => {
    const { sheet } = makeRig();
    const order = paletteByLuminance(sheet);
    const palette = sheet.paletteRgb();
    const darkest = order[0]!;
    const brightest = order[order.length - 1]!;

    // Half the tile at each end of the palette's luminance range.
    for (let y = 0; y < sheet.tileSize; y += 1) {
      for (let x = 0; x < sheet.tileSize; x += 1) {
        sheet.setPixel(PAGE, TILE, x, y, x < sheet.tileSize / 2 ? darkest : brightest);
      }
    }

    // A threshold set midway between the two luminances actually painted, so the
    // expectation follows from the palette rather than from a chosen number.
    const dark = palette[darkest]!;
    const bright = palette[brightest]!;
    const low = luminance(dark[0], dark[1], dark[2]);
    const high = luminance(bright[0], bright[1], bright[2]);
    const derived = deriveMaterials(blockImage(sheet), {
      ...defaultMaterialDeriveParams(),
      emissiveThreshold: (low + high) / 2,
      emissiveSoftness: 0.01,
      emissiveSaturation: 0,
    });

    const width = derived.width;
    expect(derived.emissive[4 * width + 1]!).toBeLessThan(0.5);
    expect(derived.emissive[4 * width + width - 1]!).toBeGreaterThan(0.5);
  });

  it("reads a saturated colour as paint and a neutral grey as metal", () => {
    const { sheet } = makeRig();
    // Two colours the test supplies itself, so the assertion does not depend on
    // whatever the default palette happens to contain.
    sheet.applyPalette([
      [0, 0, 0],
      [160, 160, 160], // neutral and bright: metal
      [200, 20, 20], // saturated: paint
    ]);
    for (let y = 0; y < sheet.tileSize; y += 1) {
      for (let x = 0; x < sheet.tileSize; x += 1) {
        sheet.setPixel(PAGE, TILE, x, y, x < sheet.tileSize / 2 ? 1 : 2);
      }
    }

    const derived = deriveMaterials(blockImage(sheet), defaultMaterialDeriveParams());
    const row = 4 * derived.width;
    expect(derived.specular[row + 1]!).toBeGreaterThan(derived.specular[row + derived.width - 1]!);
  });
});
