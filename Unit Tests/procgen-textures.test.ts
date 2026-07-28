/**
 * Procedural texture tests.
 *
 * Every generator is checked against the contract the registry promises rather
 * than against a captured image: the field is in range, it is reproducible from
 * its seed, its parameters actually do something, and — for the generators that
 * claim it — the pattern joins up with itself across the tile border. The ramp
 * step is then driven through the real SpriteSheet, so what is asserted is what
 * a cart would actually contain.
 */

import { describe, expect, it } from "vitest";
import {
  SpriteSheet,
  StubCartEngine,
  TEXTURE_GENERATORS,
  defaultValues,
  findTextureGenerator,
  textureToIndices,
  type SpritePage,
  type TextureField,
  type TextureGenerator,
} from "@cartbox/editor";

const PAGE: SpritePage = 0;
const SIZE = 32;

/** Generate a field at the test size with the generator's declared defaults. */
function generate(generator: TextureGenerator, overrides: Record<string, number> = {}): TextureField {
  return generator.generate(SIZE, SIZE, { ...defaultValues(generator.params), ...overrides });
}

/** Mean absolute difference between two columns of a field. */
function columnDifference(field: TextureField, a: number, b: number): number {
  let total = 0;
  for (let y = 0; y < field.height; y += 1) {
    total += Math.abs((field.values[y * field.width + a] ?? 0) - (field.values[y * field.width + b] ?? 0));
  }
  return total / field.height;
}

/** Mean absolute difference between two rows of a field. */
function rowDifference(field: TextureField, a: number, b: number): number {
  let total = 0;
  for (let x = 0; x < field.width; x += 1) {
    total += Math.abs((field.values[a * field.width + x] ?? 0) - (field.values[b * field.width + x] ?? 0));
  }
  return total / field.width;
}

describe("the texture generator registry", () => {
  it("gives every generator a unique id and at least one parameter", () => {
    const ids = TEXTURE_GENERATORS.map((generator) => generator.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const generator of TEXTURE_GENERATORS) {
      expect(generator.params.length, generator.id).toBeGreaterThan(0);
      expect(generator.label.length, generator.id).toBeGreaterThan(0);
      expect(generator.description.length, generator.id).toBeGreaterThan(0);
    }
  });

  it("declares every parameter with a default inside its own range", () => {
    for (const generator of TEXTURE_GENERATORS) {
      for (const param of generator.params) {
        expect(param.min, `${generator.id}.${param.key}`).toBeLessThan(param.max);
        expect(param.value, `${generator.id}.${param.key}`).toBeGreaterThanOrEqual(param.min);
        expect(param.value, `${generator.id}.${param.key}`).toBeLessThanOrEqual(param.max);
        expect(param.hint.length, `${generator.id}.${param.key}`).toBeGreaterThan(0);
      }
    }
  });

  it("falls back to the first generator for an unknown id", () => {
    expect(findTextureGenerator("no-such-texture")).toBe(TEXTURE_GENERATORS[0]);
    for (const generator of TEXTURE_GENERATORS) {
      expect(findTextureGenerator(generator.id)).toBe(generator);
    }
  });
});

describe.each(TEXTURE_GENERATORS.map((generator) => [generator.id, generator] as const))(
  "%s texture",
  (id, generator) => {
    it("fills the requested size with values in range", () => {
      const field = generate(generator);
      expect(field.width).toBe(SIZE);
      expect(field.height).toBe(SIZE);
      expect(field.values.length).toBe(SIZE * SIZE);
      for (const value of field.values) {
        expect(Number.isFinite(value), id).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    });

    it("is reproducible from the same settings", () => {
      expect(Array.from(generate(generator).values)).toEqual(Array.from(generate(generator).values));
    });

    it("produces a pattern rather than a flat fill", () => {
      const values = Array.from(generate(generator).values);
      expect(Math.max(...values) - Math.min(...values), id).toBeGreaterThan(0);
    });

    it("clamps a wild parameter instead of producing nonsense", () => {
      const wild: Record<string, number> = {};
      for (const param of generator.params) wild[param.key] = Number.POSITIVE_INFINITY;
      const field = generate(generator, wild);
      for (const value of field.values) expect(Number.isFinite(value), id).toBe(true);
    });

    if (generator.params.some((param) => param.key === "seed")) {
      it("gives a different pattern for a different seed", () => {
        const first = Array.from(generate(generator, { seed: 1 }).values);
        const second = Array.from(generate(generator, { seed: 2 }).values);
        expect(second, id).not.toEqual(first);
      });
    }

    if (generator.tiles) {
      it("joins up with itself at the tile border", () => {
        const field = generate(generator);

        // The wrap-around pair is just another adjacent pair when the pattern
        // tiles, so its difference cannot exceed the largest interior one. A
        // seam shows up here as a difference far outside that range.
        let widestColumns = 0;
        let widestRows = 0;
        for (let index = 1; index < SIZE; index += 1) {
          widestColumns = Math.max(widestColumns, columnDifference(field, index - 1, index));
          widestRows = Math.max(widestRows, rowDifference(field, index - 1, index));
        }

        expect(columnDifference(field, SIZE - 1, 0), `${id} horizontal seam`).toBeLessThanOrEqual(
          widestColumns + 1e-6,
        );
        expect(rowDifference(field, SIZE - 1, 0), `${id} vertical seam`).toBeLessThanOrEqual(widestRows + 1e-6);
      });
    }
  },
);

describe("textureToIndices", () => {
  const flat = (value: number): TextureField => ({
    width: 8,
    height: 8,
    values: new Float32Array(64).fill(value),
  });

  it("maps the ends of the range to the ends of the ramp", () => {
    const ramp = [2, 5, 9, 14];
    const dark = textureToIndices(flat(0), { ramp, dither: "none", strength: 1 });
    const light = textureToIndices(flat(1), { ramp, dither: "none", strength: 1 });

    expect(new Set(dark.indices)).toEqual(new Set([ramp[0]]));
    expect(new Set(light.indices)).toEqual(new Set([ramp[ramp.length - 1]]));
  });

  it("produces nothing but colour 0 when handed no ramp", () => {
    const result = textureToIndices(flat(0.5), { ramp: [], dither: "bayer4", strength: 1 });
    expect(new Set(result.indices)).toEqual(new Set([0]));
  });

  it("dithers a value between two shades into both of them", () => {
    // Exactly halfway between the two ramp entries, where no single one is right.
    const ramp = [1, 2];
    const undithered = textureToIndices(flat(0.5), { ramp, dither: "none", strength: 1 });
    const dithered = textureToIndices(flat(0.5), { ramp, dither: "bayer4", strength: 1 });

    expect(new Set(undithered.indices).size).toBe(1);
    expect(new Set(dithered.indices).size).toBe(2);
  });

  it("treats diffusion as ordered noise, since a scalar ramp has no colour error to spread", () => {
    const ramp = [1, 2];
    const asFloyd = textureToIndices(flat(0.5), { ramp, dither: "floyd", strength: 1 });
    const asNoise = textureToIndices(flat(0.5), { ramp, dither: "noise", strength: 1 });
    expect(Array.from(asFloyd.indices)).toEqual(Array.from(asNoise.indices));
  });

  it("respects the ramp's own order, not the palette's", () => {
    // A ramp given light-to-dark must come out light-to-dark.
    const ramp = [14, 9, 5, 2];
    const dark = textureToIndices(flat(0), { ramp, dither: "none", strength: 1 });
    expect(dark.indices[0]).toBe(14);
  });
});

describe("a generated texture landing in a cart", () => {
  it("writes only palette indices the ramp names", () => {
    const engine = new StubCartEngine();
    const sheet = new SpriteSheet(engine);
    const generator = findTextureGenerator("brick");
    const edge = sheet.tileSize;
    const ramp = [1, 4, 7];

    const field = generator.generate(edge, edge, defaultValues(generator.params));
    const written = sheet.importIndexedAt(textureToIndices(field, { ramp, dither: "bayer4", strength: 1 }), PAGE, 0, 0);
    expect(written).toBe(edge * edge);

    const seen = new Set<number>();
    for (let y = 0; y < edge; y += 1) {
      for (let x = 0; x < edge; x += 1) seen.add(sheet.getPixel(PAGE, 0, x, y));
    }
    for (const index of seen) expect(ramp).toContain(index);
    // A brick wall uses more than one shade, or the mortar would be invisible.
    expect(seen.size).toBeGreaterThan(1);
  });
});
