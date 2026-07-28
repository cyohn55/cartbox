/**
 * Volumetric god-ray tests for the CPU lit renderer. These drive the real
 * `renderLitRgba` over hand-built height fields and assert on the rendered RGBA
 * it returns — never on internal state or baked-in expected pixel values.
 *
 * The effect under test: light shafts marched through the height field. A pixel
 * whose straight path to the light is clear scatters fog light back to the eye
 * (a bright shaft); a pixel whose path is blocked by a taller silhouette is cut
 * short (a dark shaft). Expectations are framed as relationships between the
 * *same* renderer's outputs (fog-on vs fog-off, clear-path vs occluded-path),
 * so the tests prove the shaft geometry rather than restating a constant.
 */

import { describe, expect, it } from "vitest";
import { renderLitRgba, type Light, type FogOptions } from "@cartbox/editor";

const WIDTH = 16;
const HEIGHT = 1;
/** Column holding a full-height wall that casts the shadow/shaft. */
const WALL_X = 8;
/** A pixel on the shadow side of the wall (light is off the right edge). */
const OCCLUDED_X = 2;
/** A pixel between the wall and the light: its path to the light is clear. */
const CLEAR_X = 12;

/** Light off the right edge and high enough that the wall occludes the far side. */
const LIGHT: Light = { col: WIDTH + 4, row: 0.5, height: 2.5, ambient: 0.2 };

/** A camera-facing normal for every pixel: encodes +Z as v*0.5+0.5. */
function flatNormalField(): Uint8ClampedArray {
  const out = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
    out[i * 4] = 128;
    out[i * 4 + 1] = 128;
    out[i * 4 + 2] = 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Uniform mid-grey albedo, so brightness comparisons aren't skewed by colour. */
function greyAlbedoField(): Uint8ClampedArray {
  const out = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
    out[i * 4] = 128;
    out[i * 4 + 1] = 128;
    out[i * 4 + 2] = 128;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Flat ground (height 0) with a single full-height wall column. R=height. */
function wallMaterialField(): Uint8ClampedArray {
  const out = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let x = 0; x < WIDTH; x += 1) {
    out[x * 4] = x === WALL_X ? 255 : 0; // height
    out[x * 4 + 1] = 0; // specular
    out[x * 4 + 2] = 255; // roughness
    out[x * 4 + 3] = 0; // emissive
  }
  return out;
}

function luminanceAt(rgba: Uint8ClampedArray, x: number): number {
  const i = x * 4;
  return rgba[i]! + rgba[i + 1]! + rgba[i + 2]!;
}

const albedo = greyAlbedoField();
const normal = flatNormalField();
const material = wallMaterialField();

function render(fog?: FogOptions): Uint8ClampedArray {
  return renderLitRgba(albedo, normal, WIDTH, HEIGHT, LIGHT, { material, fog });
}

describe("god-ray light shafts through the height field", () => {
  const shaft: FogOptions = { color: [1, 1, 1], density: 0.6 };

  it("scatters more fog light onto a clear path than behind a silhouette", () => {
    const off = render(undefined);
    const on = render(shaft);

    // Isolate the shaft: how much brightness fog *added* at each pixel.
    const gainClear = luminanceAt(on, CLEAR_X) - luminanceAt(off, CLEAR_X);
    const gainOccluded = luminanceAt(on, OCCLUDED_X) - luminanceAt(off, OCCLUDED_X);

    expect(gainClear).toBeGreaterThan(gainOccluded);
  });

  it("only ever brightens — a shaft never darkens a pixel", () => {
    const off = render(undefined);
    const on = render(shaft);

    for (let x = 0; x < WIDTH; x += 1) {
      expect(luminanceAt(on, x)).toBeGreaterThanOrEqual(luminanceAt(off, x));
    }
  });

  it("treats zero density as no fog at all", () => {
    const off = render(undefined);
    const zero = render({ color: [1, 1, 1], density: 0 });

    for (let x = 0; x < WIDTH; x += 1) {
      expect(luminanceAt(zero, x)).toBe(luminanceAt(off, x));
    }
  });

  it("tints the shaft toward the fog colour", () => {
    const off = render(undefined);
    const red = render({ color: [1, 0, 0], density: 0.6 });
    const i = CLEAR_X * 4;

    // On a clear path the red channel gains; green/blue get no shaft contribution.
    expect(red[i]! - off[i]!).toBeGreaterThan(0);
    expect(red[i + 1]! - off[i + 1]!).toBe(0);
    expect(red[i + 2]! - off[i + 2]!).toBe(0);
  });

  it("scales shaft brightness with density on a clear path", () => {
    const off = render(undefined);
    const faint = luminanceAt(render({ color: [1, 1, 1], density: 0.3 }), CLEAR_X) - luminanceAt(off, CLEAR_X);
    const strong = luminanceAt(render({ color: [1, 1, 1], density: 0.6 }), CLEAR_X) - luminanceAt(off, CLEAR_X);

    expect(strong).toBeGreaterThan(faint);
  });
});
