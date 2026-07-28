/**
 * Unit tests for handheld colour behaviour:
 *  - the pure contrast helpers (`ensureContrast` and friends),
 *  - the two-tone contract that shoulder labels match the button letters, and
 *  - the marquee scene, which is drawn in a chosen colour (falling back to the
 *    button accent) and always lightened to stay legible on the near-black panel.
 *
 * Assertions measure actual scheme colours and actual rendered marquee pixels,
 * not hard-coded expectations.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it } from "vitest";

import {
  HANDHELD_PRESETS,
  contrastRatio,
  ensureContrast,
  hexToRgb,
  renderAnimatedFrame,
  twoTone,
  type HandheldAnimatedPreset,
  type HandheldTemplate,
} from "@cartbox/editor";

/** The marquee panel background the scene is drawn on (PANEL_BG). */
const MARQUEE_PANEL_RGB = [13, 16, 32] as const;
/** The readability floor the marquee scene is held to on that panel. */
const READABLE_CONTRAST = 3;

/**
 * A minimal solid-face template: a chassis-coloured rectangle with a marquee
 * hole punched in its lower half, so `renderAnimatedFrame` finds a real panel
 * and the drawn scene can be sampled. Built from the caller's dimensions so no
 * pixel geometry is hard-coded into the assertions.
 */
function makeTemplate(width: number, height: number): HandheldTemplate {
  const base = new Uint8ClampedArray(width * height * 4);
  const regionMask = new Uint8Array(width * height); // 1 = face everywhere solid
  const holeX0 = Math.floor(width * 0.15);
  const holeX1 = Math.ceil(width * 0.85);
  const holeY0 = Math.floor(height * 0.7);
  const holeY1 = Math.ceil(height * 0.95);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const inHole = x >= holeX0 && x < holeX1 && y >= holeY0 && y < holeY1;
      if (inHole) continue; // leave transparent (alpha 0) so it reads as the panel hole
      base[pixel * 4 + 3] = 255; // opaque chrome elsewhere
      regionMask[pixel] = 1; // the face region
    }
  }
  return { width, height, base, regionMask };
}

/** Distinct colours that appear in the marquee area of a rendered frame. */
function marqueeColors(template: HandheldTemplate, frame: Uint8ClampedArray): Set<string> {
  const { width, height } = template;
  const colors = new Set<string>();
  for (let y = Math.floor(height * 0.7); y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = (y * width + x) * 4;
      if (frame[base + 3] !== 255) continue;
      colors.add(`${frame[base]},${frame[base + 1]},${frame[base + 2]}`);
    }
  }
  return colors;
}

/** Whether any drawn marquee colour clears the readability floor on the panel. */
function hasLegibleMark(colors: Set<string>): boolean {
  return [...colors].some((color) => {
    const rgb = color.split(",").map(Number) as [number, number, number];
    return contrastRatio(rgb, MARQUEE_PANEL_RGB) >= READABLE_CONTRAST;
  });
}

describe("ensureContrast", () => {
  it("leaves a colour that already meets the target unchanged", () => {
    const bright = "#a7f070"; // lime, plainly legible on dark
    expect(ensureContrast(bright, MARQUEE_PANEL_RGB, READABLE_CONTRAST)).toBe(bright);
  });

  it("lightens a dark colour until it reaches the target contrast", () => {
    const dark = "#26374d"; // navy — fails on the near-black panel
    const before = contrastRatio(hexToRgb(dark), MARQUEE_PANEL_RGB);
    const fixed = ensureContrast(dark, MARQUEE_PANEL_RGB, READABLE_CONTRAST);
    const after = contrastRatio(hexToRgb(fixed), MARQUEE_PANEL_RGB);
    expect(before).toBeLessThan(READABLE_CONTRAST);
    expect(after).toBeGreaterThanOrEqual(READABLE_CONTRAST);
  });

  it("preserves the hue while lightening (recolours toward the same family, not grey)", () => {
    const navy = hexToRgb(ensureContrast("#26374d", MARQUEE_PANEL_RGB, READABLE_CONTRAST));
    // Navy's blue channel dominates; that ordering must survive lightening.
    expect(navy[2]).toBeGreaterThan(navy[0]);
    expect(navy[2]).toBeGreaterThan(navy[1]);
  });
});

describe("twoTone shoulder labels", () => {
  it("defaults the shoulder labels to the same colour as the button letters", () => {
    const scheme = twoTone("#e8792b", "#26374d");
    expect(scheme.shoulderText).toBe(scheme.buttonLetter);
  });

  it("honours an explicit ink for both button letters and shoulder labels", () => {
    const scheme = twoTone("#111111", "#eeeeee", "#00ff00");
    expect(scheme.shoulderText).toBe("#00ff00");
    expect(scheme.shoulderText).toBe(scheme.buttonLetter);
  });
});

describe("premade shoulder labels", () => {
  const scheme = (id: string) => HANDHELD_PRESETS.find((preset) => preset.id === id)!.scheme;

  it("gives every premade a shoulder colour that is already used elsewhere on the shell", () => {
    for (const preset of HANDHELD_PRESETS) {
      const others = (Object.entries(preset.scheme) as [string, string][])
        .filter(([region]) => region !== "shoulderText")
        .map(([, color]) => color);
      expect(others, preset.id).toContain(preset.scheme.shoulderText);
    }
  });

  it("points each requested premade's shoulder label at the intended on-shell colour", () => {
    // Each expectation references another region of the same scheme, so it asserts
    // the *relationship* (shoulders match that colour) rather than a fixed hex.
    expect(scheme("red").shoulderText).toBe(scheme("red").buttonColor); // cream accent
    expect(scheme("yellow").shoulderText).toBe(scheme("yellow").face); // yellow body
    expect(scheme("green").shoulderText).toBe(scheme("green").buttonColor); // white accent
    expect(scheme("blue").shoulderText).toBe(scheme("blue").buttonColor); // gold accent
    expect(scheme("indigo").shoulderText).toBe(scheme("indigo").buttonColor); // sky-blue accent
    expect(scheme("violet").shoulderText).toBe(scheme("violet").buttonColor); // lime accent
    expect(scheme("graphite").shoulderText).toBe(scheme("graphite").buttonColor); // silver accent
  });
});

describe("marquee scene colour", () => {
  const template = makeTemplate(120, 220);

  const presetWith = (overrides: Partial<HandheldAnimatedPreset>): HandheldAnimatedPreset => ({
    id: "test",
    label: "Test",
    game: "equalizer",
    scheme: twoTone("#7a3fa6", "#a7f070"), // bright lime button accent
    frames: 4,
    durationMs: 100,
    ...overrides,
  });

  it("follows the button accent when no marquee colour is set", () => {
    const frame = renderAnimatedFrame(template, presetWith({}), 1);
    // The bright lime accent is legible as-is, so it appears verbatim.
    expect(marqueeColors(template, frame).has("167,240,112")).toBe(true);
  });

  it("draws the scene in an explicit marquee colour, overriding the button accent", () => {
    const magenta: [number, number, number] = [255, 0, 255];
    const frame = renderAnimatedFrame(template, presetWith({ marqueeColor: "#ff00ff" }), 1);
    const colors = marqueeColors(template, frame);
    expect(colors.has("255,0,255")).toBe(true); // the chosen colour is used
    expect(colors.has("167,240,112")).toBe(false); // the button accent is not
    expect(contrastRatio(magenta, MARQUEE_PANEL_RGB)).toBeGreaterThanOrEqual(READABLE_CONTRAST);
  });

  it("still lightens a dark chosen colour so it reads on the panel", () => {
    const dark = "#1a1030"; // near-panel purple, illegible as-is
    expect(contrastRatio(hexToRgb(dark), MARQUEE_PANEL_RGB)).toBeLessThan(READABLE_CONTRAST);
    const frame = renderAnimatedFrame(template, presetWith({ marqueeColor: dark }), 1);
    expect(hasLegibleMark(marqueeColors(template, frame))).toBe(true);
  });

  it("lightens a dark button accent when the scene follows it", () => {
    const preset = presetWith({ scheme: twoTone("#e8792b", "#26374d") }); // dark navy accent
    const frame = renderAnimatedFrame(template, preset, 1);
    expect(hasLegibleMark(marqueeColors(template, frame))).toBe(true);
  });
});
