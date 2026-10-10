/**
 * The grading LUT's model (HALO_INFINITE_STYLE_ROADMAP.md I8): the built-in
 * looks, reading `.cube` files, storing a table on the effect stack, the
 * trilinear lookup the shader mirrors (checked in a real browser by
 * postfx-lut-webgl.test.ts), and the effect's place in the stack.
 */

import { describe, expect, it } from "vitest";
import {
  IMPORTED_LOOK,
  LUT_LOOKS,
  applyLut,
  decodeLut,
  defaultPostFxSettings,
  encodeLut,
  identityLut,
  lookLut,
  lutStrip,
  parseCubeLut,
  parsePostFxSettings,
  uniformsFromSettings,
} from "@cartbox/player";

const saturation = (c: readonly number[]) => Math.max(...c) - Math.min(...c);

describe("the lookup", () => {
  it("leaves every colour alone through the identity table", () => {
    const lut = identityLut();
    for (const c of [[0, 0, 0], [1, 1, 1], [0.3, 0.6, 0.9], [0.123, 0.987, 0.5]] as const) {
      applyLut(lut, c[0], c[1], c[2]).forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 2));
    }
  });

  it("hits the table exactly on its lattice and interpolates between", () => {
    const lut = lookLut(0, 3);
    const at = (r: number, g: number, b: number) => Array.from(lut.data.subarray(((b * 3 + g) * 3 + r) * 3, ((b * 3 + g) * 3 + r) * 3 + 3)).map((v) => v / 255);
    expect(applyLut(lut, 0.5, 1, 0)).toEqual(at(1, 2, 0));
    const mid = applyLut(lut, 0.25, 1, 0);
    mid.forEach((v, i) => expect(v).toBeCloseTo((at(0, 2, 0)[i]! + at(1, 2, 0)[i]!) / 2, 9));
  });

  it("clamps colours outside 0..1", () => {
    const lut = lookLut(0);
    expect(applyLut(lut, -1, 2, 0.5)).toEqual(applyLut(lut, 0, 1, 0.5));
  });

  it("lays the table out as a strip of blue slices for the shader", () => {
    const lut = lookLut(1, 4);
    const strip = lutStrip(lut);
    expect([strip.width, strip.height]).toEqual([16, 4]);
    // Red 3, green 1, blue 2: slice 2, column 3, row 1.
    const from = ((2 * 4 + 1) * 4 + 3) * 3;
    const to = (1 * 16 + 2 * 4 + 3) * 4;
    expect(Array.from(strip.data.subarray(to, to + 4))).toEqual([...lut.data.subarray(from, from + 3), 255]);
  });
});

describe("the built-in looks", () => {
  it("offers four, then the imported table", () => {
    expect(LUT_LOOKS).toHaveLength(5);
    expect(LUT_LOOKS[IMPORTED_LOOK]).toBe("Imported");
  });

  it("Infinite: lifts dull colour, warms the highlights and cools the shade", () => {
    const lut = lookLut(0);
    const dull = [0.5, 0.45, 0.4] as const;
    expect(saturation(applyLut(lut, ...dull))).toBeGreaterThan(saturation(dull));
    const [hr, , hb] = applyLut(lut, 0.85, 0.85, 0.85);
    expect(hr - hb).toBeGreaterThan(0.03);
    const [sr, , sb] = applyLut(lut, 0.15, 0.15, 0.15);
    expect(sb - sr).toBeGreaterThan(0.02);
    // Contrast: shadows a little deeper, highlights a little brighter.
    expect(applyLut(lut, 0.2, 0.2, 0.2)[1]).toBeLessThan(0.2);
    expect(applyLut(lut, 0.8, 0.8, 0.8)[1]).toBeGreaterThan(0.8);
  });

  it("Cold steel mutes and Bleach bypass drains colour, harder", () => {
    const vivid = [0.8, 0.3, 0.2] as const;
    const cold = applyLut(lookLut(2), ...vivid);
    const bleach = applyLut(lookLut(3), ...vivid);
    expect(saturation(cold)).toBeLessThan(saturation(vivid));
    expect(saturation(bleach)).toBeLessThan(saturation(cold));
  });
});

describe(".cube files", () => {
  const swap = ["# a comment", 'TITLE "swap"', "LUT_3D_SIZE 2", "", ...[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${b} ${g} ${r}`)))].join("\r\n");

  it("read, red fastest", () => {
    const lut = parseCubeLut(swap)!;
    expect(lut.size).toBe(2);
    const [r, g, b] = applyLut(lut, 1, 0.5, 0);
    expect([r, g, b].map((v) => Math.round(v * 255))).toEqual([0, 128, 255]);
  });

  it("honour a domain", () => {
    const text = ["LUT_3D_SIZE 2", "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 2 2 2", ...Array.from({ length: 8 }, () => "1 1 1")].join("\n");
    expect(Array.from(parseCubeLut(text)!.data.subarray(0, 3))).toEqual([128, 128, 128]);
  });

  it("refuse 1D tables, wrong counts, bad numbers and sizes out of range", () => {
    expect(parseCubeLut("LUT_1D_SIZE 2\n0 0 0\n1 1 1")).toBeNull();
    expect(parseCubeLut("LUT_3D_SIZE 2\n0 0 0")).toBeNull();
    expect(parseCubeLut(swap.replace("1 1 1", "1 x 1"))).toBeNull();
    expect(parseCubeLut("LUT_3D_SIZE 64\n0 0 0")).toBeNull();
    expect(parseCubeLut("hello")).toBeNull();
  });

  it("pack into the settings and back", () => {
    const lut = lookLut(0, 5);
    expect(decodeLut(encodeLut(lut))).toEqual(lut);
    expect(decodeLut({ size: 5, data: "AAAA" })).toBeNull();
    expect(decodeLut({ size: 99, data: encodeLut(lut).data })).toBeNull();
    expect(decodeLut(null)).toBeNull();
  });
});

describe("the effect", () => {
  it("is neutral when off and grades when on", () => {
    const off = uniformsFromSettings(defaultPostFxSettings());
    expect(off.lutStrength).toBe(0);
    expect(off.lut).toBeNull();
    const settings = defaultPostFxSettings();
    settings.enabled.lut = true;
    const on = uniformsFromSettings(settings);
    expect(on.lutStrength).toBe(1);
    expect(on.lut!.data).toEqual(lookLut(0).data);
  });

  it("reads the imported table on the last look, and the identity without one", () => {
    const settings = defaultPostFxSettings();
    settings.enabled.lut = true;
    settings.values["lut.look"] = IMPORTED_LOOK;
    expect(uniformsFromSettings(settings).lut!.data).toEqual(identityLut().data);
    const imported = lookLut(3, 4);
    settings.lut = encodeLut(imported);
    expect(uniformsFromSettings(settings).lut).toEqual(imported);
  });

  it("keeps an imported table through a save and load, and drops a malformed one", () => {
    const settings = defaultPostFxSettings();
    settings.lut = encodeLut(lookLut(0, 3));
    expect(parsePostFxSettings(JSON.parse(JSON.stringify(settings)))!.lut).toEqual(settings.lut);
    expect(parsePostFxSettings({ ...settings, lut: { size: 3, data: "nope" } })!.lut).toBeUndefined();
  });
});
