/**
 * Material-swatches tests — the per-colour material bindings and the composite
 * "Material" brush that stamps albedo plus every material channel in one stroke.
 *
 * These drive the real StubCartEngine with the real NormalMap/MaterialMap views
 * and the real MaterialBrushSurface, then assert on the values actually read back
 * from the engine after painting. No internal state is inspected and no channel
 * value is hard-coded into an assertion independently of the profile that was
 * painted — every expectation is derived from the swatch under test.
 */

import { describe, expect, it } from "vitest";
import {
  StubCartEngine,
  SpriteSheet,
  NormalMap,
  MaterialMap,
  defaultMaterialSwatches,
  materialProfileAt,
  setMaterialProfile,
  isMaterialSwatchEnabled,
  normalizeMaterialProfile,
  type MaterialProfile,
  type MaterialSwatches,
  type SpritePage,
} from "@cartbox/editor";
import {
  NormalSurface,
  MaterialSurface,
} from "../apps/web/src/app/edit/[cartId]/paintSurface";
import { MaterialBrushSurface } from "../apps/web/src/app/edit/[cartId]/materialBrushSurface";
import { SpriteBlockSurface } from "../apps/web/src/app/edit/[cartId]/spriteBlockSurface";

const PAGE: SpritePage = 0;
const TILE = 1;

/** The channels a swatch stamps, as they read off the engine at one pixel. */
interface ChannelReadout {
  albedo: number;
  normal: number;
  height: number;
  specular: number;
  roughness: number;
  emissive: number;
}

/** A fresh engine plus the real channel views and the composite brush over them. */
function makeBrushRig(profileFor: (colorIndex: number) => MaterialProfile) {
  const engine = new StubCartEngine();
  const sheet = new SpriteSheet(engine);
  const normals = new NormalMap(engine);
  const height = new MaterialMap(engine, "height");
  const specular = new MaterialMap(engine, "specular");
  const roughness = new MaterialMap(engine, "roughness");
  const emissive = new MaterialMap(engine, "emissive");

  const brush = new MaterialBrushSurface(
    sheet,
    {
      normal: new NormalSurface(normals, sheet.tileSize),
      height: new MaterialSurface(height, sheet.tileSize),
      specular: new MaterialSurface(specular, sheet.tileSize),
      roughness: new MaterialSurface(roughness, sheet.tileSize),
      emissive: new MaterialSurface(emissive, sheet.tileSize),
    },
    profileFor,
  );

  const readChannels = (x: number, y: number): ChannelReadout => ({
    albedo: sheet.getPixel(PAGE, TILE, x, y),
    normal: normals.getDirection(PAGE, TILE, x, y),
    height: height.getValue(PAGE, TILE, x, y),
    specular: specular.getValue(PAGE, TILE, x, y),
    roughness: roughness.getValue(PAGE, TILE, x, y),
    emissive: emissive.getValue(PAGE, TILE, x, y),
  });

  return { engine, sheet, normals, height, specular, roughness, emissive, brush, readChannels };
}

describe("MaterialSwatches model", () => {
  it("resolves unconfigured colours to a disabled, albedo-only default", () => {
    const swatches = defaultMaterialSwatches();
    const profile = materialProfileAt(swatches, 5);

    expect(profile.enabled).toBe(false);
    expect(isMaterialSwatchEnabled(swatches, 5)).toBe(false);
    // Every channel resolves to a neutral zero for an unset colour.
    expect([profile.normal, profile.height, profile.specular, profile.roughness, profile.emissive]).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it("grows the profile array to cover a set colour, leaving the gap at defaults", () => {
    const configured: MaterialProfile = {
      enabled: true,
      normal: 3,
      height: 12,
      specular: 9,
      roughness: 4,
      emissive: 15,
    };
    const swatches = setMaterialProfile(defaultMaterialSwatches(), 5, configured);

    expect(materialProfileAt(swatches, 5)).toEqual(configured);
    // A colour below the set index was padded, not left undefined.
    expect(materialProfileAt(swatches, 2)).toEqual(materialProfileAt(defaultMaterialSwatches(), 0));
  });

  it("clamps out-of-range channel values into their valid 4-bit ranges", () => {
    const normalized = normalizeMaterialProfile({
      enabled: 1 as unknown as boolean,
      normal: 99, // above the 16 directions
      height: -3, // below zero
      specular: 2.6, // fractional
      roughness: Number.NaN, // not a number
      emissive: 15, // already valid, at the top
    });

    expect(normalized.enabled).toBe(true);
    expect(normalized.normal).toBe(15);
    expect(normalized.height).toBe(0);
    expect(normalized.specular).toBe(3); // rounded
    expect(normalized.roughness).toBe(0);
    expect(normalized.emissive).toBe(15);
  });

  it("ignores writes to invalid colour indices", () => {
    const base = defaultMaterialSwatches();
    const profile: MaterialProfile = { enabled: true, normal: 1, height: 1, specular: 1, roughness: 1, emissive: 1 };

    expect(setMaterialProfile(base, -1, profile)).toBe(base);
    expect(setMaterialProfile(base, 1.5, profile)).toBe(base);
  });
});

describe("MaterialBrushSurface", () => {
  const highlight: MaterialProfile = {
    enabled: true,
    normal: 3,
    height: 12,
    specular: 9,
    roughness: 4,
    emissive: 15,
  };
  const HIGHLIGHT_COLOR = 5;

  it("stamps albedo and every channel from an enabled colour's profile", () => {
    const swatches = setMaterialProfile(defaultMaterialSwatches(), HIGHLIGHT_COLOR, highlight);
    const { brush, readChannels } = makeBrushRig((index) => materialProfileAt(swatches, index));

    brush.setPixel(PAGE, TILE, 2, 3, HIGHLIGHT_COLOR);

    // The single stroke wrote the albedo index and each channel from the swatch.
    expect(readChannels(2, 3)).toEqual({
      albedo: HIGHLIGHT_COLOR,
      normal: highlight.normal,
      height: highlight.height,
      specular: highlight.specular,
      roughness: highlight.roughness,
      emissive: highlight.emissive,
    });
  });

  it("reads back and displays as albedo, so tools key off colour identity", () => {
    const swatches = setMaterialProfile(defaultMaterialSwatches(), HIGHLIGHT_COLOR, highlight);
    const { sheet, brush } = makeBrushRig((index) => materialProfileAt(swatches, index));

    brush.setPixel(PAGE, TILE, 4, 4, HIGHLIGHT_COLOR);

    expect(brush.getPixel(PAGE, TILE, 4, 4)).toBe(HIGHLIGHT_COLOR);
    expect(brush.cssColor(HIGHLIGHT_COLOR)).toBe(sheet.cssColor(HIGHLIGHT_COLOR));
  });

  it("leaves material channels untouched when painting a disabled colour", () => {
    const swatches = setMaterialProfile(defaultMaterialSwatches(), HIGHLIGHT_COLOR, highlight);
    const { brush, readChannels } = makeBrushRig((index) => materialProfileAt(swatches, index));
    const plainColor = 2; // never configured — paints albedo only

    // Lay down the highlight, then overpaint with an unconfigured colour.
    brush.setPixel(PAGE, TILE, 6, 6, HIGHLIGHT_COLOR);
    brush.setPixel(PAGE, TILE, 6, 6, plainColor);

    const after = readChannels(6, 6);
    expect(after.albedo).toBe(plainColor); // albedo changed
    // …but the material channels still carry the highlight's values.
    expect(after.normal).toBe(highlight.normal);
    expect(after.height).toBe(highlight.height);
    expect(after.emissive).toBe(highlight.emissive);
  });

  it("fans the profile across a flood fill", () => {
    const swatches = setMaterialProfile(defaultMaterialSwatches(), HIGHLIGHT_COLOR, highlight);
    const { sheet, brush, readChannels } = makeBrushRig((index) => materialProfileAt(swatches, index));

    // Flatten the albedo to one value so the tile is a single contiguous region
    // the fill covers entirely (the stub seeds a non-uniform demo sprite).
    for (let y = 0; y < sheet.tileSize; y += 1) {
      for (let x = 0; x < sheet.tileSize; x += 1) sheet.setPixel(PAGE, TILE, x, y, 0);
    }

    brush.fill(PAGE, TILE, 0, 0, HIGHLIGHT_COLOR);

    const corner = sheet.tileSize - 1;
    expect(readChannels(corner, corner)).toEqual({
      albedo: HIGHLIGHT_COLOR,
      normal: highlight.normal,
      height: highlight.height,
      specular: highlight.specular,
      roughness: highlight.roughness,
      emissive: highlight.emissive,
    });
  });

  it("addresses the right sub-tile when composed under a sprite block", () => {
    const swatches = setMaterialProfile(defaultMaterialSwatches(), HIGHLIGHT_COLOR, highlight);
    const { sheet, height, brush } = makeBrushRig((index) => materialProfileAt(swatches, index));

    // Wrap both the brush and a bare height view as 2×2 blocks over the same
    // engine; a block pixel in the second sub-tile must fan out to that tile.
    const blockBrush = new SpriteBlockSurface(brush, sheet.sheetCols, 2);
    const blockHeight = new SpriteBlockSurface(new MaterialSurface(height, sheet.tileSize), sheet.sheetCols, 2);
    const x = sheet.tileSize + 1; // past the first sub-tile's right edge
    const y = 3;

    blockBrush.setPixel(PAGE, TILE, x, y, HIGHLIGHT_COLOR);

    expect(blockBrush.getPixel(PAGE, TILE, x, y)).toBe(HIGHLIGHT_COLOR);
    expect(blockHeight.getPixel(PAGE, TILE, x, y)).toBe(highlight.height);
  });
});
