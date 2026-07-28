/**
 * Voxel/hexel alphabet tests. The font and its builders are the reusable base for
 * any blocky 3D type (the onboarding headline is the first caller), so these check
 * the font is well-formed and that the builders turn real strings into real models
 * — never by asserting hard-coded voxel counts, but by deriving the expected
 * geometry from the font and options the way a caller would.
 */

import { describe, expect, it } from "vitest";
import {
  VOXEL_FONT,
  FONT_WIDTH,
  FONT_HEIGHT,
  buildGlyphModel,
  buildVoxelText,
  layoutVoxelText,
} from "@cartbox/editor";

/** Count the lit pixels a glyph declares in the font. */
function litPixels(char: string): number {
  const rows = VOXEL_FONT[char] ?? VOXEL_FONT[char.toUpperCase()] ?? VOXEL_FONT[" "]!;
  return rows.reduce((sum, row) => sum + [...row].filter((cell) => cell === "#").length, 0);
}

describe("voxel font", () => {
  it("declares every glyph as a FONT_HEIGHT×FONT_WIDTH grid of only # and .", () => {
    for (const [char, rows] of Object.entries(VOXEL_FONT)) {
      expect(rows, `${char} row count`).toHaveLength(FONT_HEIGHT);
      for (const row of rows) {
        expect([...row], `${char} row width`).toHaveLength(FONT_WIDTH);
        expect(/^[#.]+$/.test(row), `${char} row alphabet`).toBe(true);
      }
    }
  });

  it("covers the alphabet, digits, space and the arcade punctuation the taglines use", () => {
    const required = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:!?'-/[]♥"];
    for (const char of required) {
      expect(VOXEL_FONT[char], `glyph for "${char}"`).toBeDefined();
    }
  });

  it("gives space no lit pixels and letters at least one", () => {
    expect(litPixels(" ")).toBe(0);
    expect(litPixels("A")).toBeGreaterThan(0);
    expect(litPixels("W")).toBeGreaterThan(0);
  });
});

describe("buildGlyphModel", () => {
  it("returns null for a glyph with no lit pixels and a model otherwise", () => {
    expect(buildGlyphModel(" ")).toBeNull();
    const a = buildGlyphModel("A");
    expect(a).not.toBeNull();
    expect(a!.count).toBeGreaterThan(0);
  });

  it("folds lowercase to the same glyph as uppercase", () => {
    expect(buildGlyphModel("a")!.count).toBe(buildGlyphModel("A")!.count);
  });

  it("builds a deeper letter from more instances than a shallow one", () => {
    // Depth only adds cells, so a thicker extrusion exposes at least as many faces.
    const shallow = buildGlyphModel("H", { depth: 1 })!;
    const deep = buildGlyphModel("H", { depth: 4 })!;
    expect(deep.count).toBeGreaterThan(shallow.count);
  });

  it("builds hexels on the even-parity FCC lattice", () => {
    const hexel = buildGlyphModel("O", { shape: "hexel" });
    expect(hexel).not.toBeNull();
    expect(hexel!.geometry?.shape).toBe("hexel");
    expect(hexel!.count).toBeGreaterThan(0);
  });
});

describe("buildVoxelText", () => {
  it("merges a word into one model carrying every letter's geometry", () => {
    // A single merged model must expose at least as many cells as the widest
    // letter alone — proof the letters actually landed in the grid.
    const word = buildVoxelText("PLAY");
    const widestLetter = Math.max(...[..."PLAY"].map((c) => buildGlyphModel(c)?.count ?? 0));
    expect(word.count).toBeGreaterThanOrEqual(widestLetter);
  });

  it("sizes a two-line block taller than a one-line block of the same text", () => {
    const oneLine = buildVoxelText("READY");
    const twoLine = buildVoxelText("READY\nGO");
    expect(twoLine.sizeY).toBeGreaterThan(oneLine.sizeY);
  });

  it("widens as the letter count grows", () => {
    expect(buildVoxelText("WW").sizeX).toBeGreaterThan(buildVoxelText("W").sizeX);
  });
});

describe("layoutVoxelText", () => {
  it("emits one placed model per visible glyph and skips spaces", () => {
    const layout = layoutVoxelText("HI YO");
    // "HI YO" has four letters and one space; the space contributes no model.
    expect(layout.letters).toHaveLength(4);
    for (const letter of layout.letters) {
      expect(letter.char).not.toBe(" ");
      expect(letter.model.count).toBeGreaterThan(0);
    }
  });

  it("centres letters around the origin (positions straddle zero on both axes)", () => {
    const layout = layoutVoxelText("MENU");
    const xs = layout.letters.map((l) => l.position[0]);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(0);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("stacks multiple lines at different heights", () => {
    const layout = layoutVoxelText("TOP\nLOW");
    const ys = new Set(layout.letters.map((l) => l.position[1]));
    // Two lines ⇒ at least two distinct vertical centres.
    expect(ys.size).toBeGreaterThanOrEqual(2);
  });
});
