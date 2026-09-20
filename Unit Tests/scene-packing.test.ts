/**
 * WebGPU scene-renderer packing.
 *
 * A GPU renderer cannot be exercised in CI — there is no adapter on a build
 * machine. But the bugs a GPU renderer actually ships are layout bugs: a
 * uniform at the wrong offset, a vertex stride disagreeing with the pipeline,
 * a readback row copied without stripping WebGPU's 256-byte padding. None of
 * those throw. They render a sheared, mis-lit picture that looks plausible
 * until someone compares it against the software path.
 *
 * So the layout lives in a pure module and is pinned here.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_AMBIENT,
  DEFAULT_LIGHT,
  UNIFORM_FLOATS,
  UNIFORM_STRIDE,
  VERTEX_FLOATS,
  alignBytesPerRow,
  interleaveVertices,
  normalBasis3x3,
  resolveLight,
  resolvePbr,
  unpadRows,
  viewDirection,
  writeInstanceUniform,
} from "@cartbox/player";
import { viewMatrix, type Mat4 } from "@cartbox/editor";

/** A matrix whose every entry is its own index, so misplacement is visible. */
const COUNTING_MAT4 = Array.from({ length: 16 }, (_, i) => i) as unknown as Mat4;

const light = { direction: [0, 1, 0] as const, ambient: 0.25 };

/** A non-PBR draw's extra fields (the fantasy path leaves pbr.z at 0). */
const NON_PBR = {
  viewDir: [0, 0, 1] as const,
  pbr: { isPbr: false, metallic: 1, roughness: 1, emissive: [0, 0, 0] as const },
  hasMrMap: false,
  hasOcclusionMap: false,
  hasEmissiveMap: false,
};

describe("uniform layout", () => {
  it("uses a stride WebGPU can address with a dynamic offset", () => {
    // 256 is the minimum alignment for a dynamic uniform offset. A smaller
    // stride packs tighter and is rejected at bind time on real hardware.
    expect(UNIFORM_STRIDE).toBe(256);
    expect(UNIFORM_STRIDE % 256).toBe(0);
    expect(UNIFORM_FLOATS).toBe(UNIFORM_STRIDE / 4);
  });

  it("writes the mvp as a contiguous column-major mat4", () => {
    const data = new Float32Array(UNIFORM_FLOATS);
    writeInstanceUniform(data, 0, {
      mvp: COUNTING_MAT4,
      normalBasis: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      baseColor: [0, 0, 0, 0],
      hasTexture: false,
      light,
      ...NON_PBR,
    });
    expect(Array.from(data.subarray(0, 16))).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it("pads each mat3x3 column to 16 bytes", () => {
    // The subtle one. WGSL gives every mat3x3 column a vec4's alignment, so the
    // nine values sit at float offsets 0,1,2 / 4,5,6 / 8,9,10 — never packed
    // tight. Packing them tight silently shears every normal in the scene.
    const data = new Float32Array(UNIFORM_FLOATS);
    writeInstanceUniform(data, 0, {
      mvp: COUNTING_MAT4,
      normalBasis: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      baseColor: [0, 0, 0, 0],
      hasTexture: false,
      light,
      ...NON_PBR,
    });
    const nrm = Array.from(data.subarray(16, 28));
    expect(nrm).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0]);
  });

  it("places base colour, light and the base-texture flag after the padded matrix", () => {
    const data = new Float32Array(UNIFORM_FLOATS);
    writeInstanceUniform(data, 0, {
      mvp: COUNTING_MAT4,
      normalBasis: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      baseColor: [0.1, 0.2, 0.3, 0.4],
      hasTexture: true,
      light,
      ...NON_PBR,
    });
    expect(Array.from(data.subarray(28, 32))).toEqual([
      Math.fround(0.1),
      Math.fround(0.2),
      Math.fround(0.3),
      Math.fround(0.4),
    ]);
    expect(Array.from(data.subarray(32, 36))).toEqual([0, 1, 0, 0.25]);
    // texflags now lives at float 48; x = base texture bound.
    expect(data[48]).toBe(1);
  });

  it("packs the Modern-tier view, pbr, emissive and texture-flag vec4s", () => {
    const data = new Float32Array(UNIFORM_FLOATS);
    writeInstanceUniform(data, 0, {
      mvp: COUNTING_MAT4,
      normalBasis: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      baseColor: [0, 0, 0, 1],
      hasTexture: true,
      light,
      viewDir: [0, 0, 1],
      pbr: { isPbr: true, metallic: 1, roughness: 0.3, emissive: [1, 0, 0] },
      hasMrMap: true,
      hasOcclusionMap: false,
      hasEmissiveMap: true,
    });
    // view (36..40): xyz direction, w unused.
    expect(Array.from(data.subarray(36, 40))).toEqual([0, 0, 1, 0]);
    // pbr (40..44): metallic, roughness, isPbr flag, unused.
    expect(Array.from(data.subarray(40, 44))).toEqual([1, Math.fround(0.3), 1, 0]);
    // emissive factor (44..48): rgb, unused.
    expect(Array.from(data.subarray(44, 48))).toEqual([1, 0, 0, 0]);
    // texflags (48..52): base, mr, occlusion, emissive.
    expect(Array.from(data.subarray(48, 52))).toEqual([1, 1, 0, 1]);
  });

  it("addresses each draw at its own stride", () => {
    const data = new Float32Array(UNIFORM_FLOATS * 3);
    writeInstanceUniform(data, 2, {
      mvp: COUNTING_MAT4,
      normalBasis: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      baseColor: [1, 1, 1, 1],
      hasTexture: false,
      light,
      ...NON_PBR,
    });
    // The third draw's mvp starts exactly two strides in, and the first two
    // slots are untouched — the property the dynamic offsets rely on.
    expect(data[UNIFORM_FLOATS * 2 + 1]).toBe(1);
    expect(data.subarray(0, UNIFORM_FLOATS * 2).every((v) => v === 0)).toBe(true);
  });
});

describe("normalBasis3x3", () => {
  it("takes the upper-left 3x3 in column-major order", () => {
    // Deliberately the model's rotation+scale, not its inverse-transpose — the
    // software rasteriser does the same, and parity is the contract.
    expect(normalBasis3x3(COUNTING_MAT4)).toEqual([0, 1, 2, 4, 5, 6, 8, 9, 10]);
  });
});

describe("resolveLight", () => {
  it("normalises the direction the shader dots against", () => {
    const resolved = resolveLight([0, 5, 0], 0.5);
    expect(resolved.direction).toEqual([0, 1, 0]);
    expect(resolved.ambient).toBe(0.5);
  });

  it("falls back to the rasteriser's own defaults", () => {
    const resolved = resolveLight(undefined, undefined);
    const length = Math.hypot(...DEFAULT_LIGHT);
    expect(resolved.ambient).toBe(DEFAULT_AMBIENT);
    expect(resolved.direction[0]).toBeCloseTo(DEFAULT_LIGHT[0] / length, 10);
  });

  it("survives a zero-length direction rather than producing NaN", () => {
    // renderMeshScene guards with `|| 1`; a NaN light would blank every pixel.
    const resolved = resolveLight([0, 0, 0], 0.3);
    expect(resolved.direction.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("resolvePbr", () => {
  it("treats a material with no metallic-roughness signal as non-PBR", () => {
    // Matches buildPbrFrag's gate: a fantasy material lights on the Lambert path.
    const resolved = resolvePbr({}, false, false, false);
    expect(resolved.isPbr).toBe(false);
  });

  it("is PBR when any map is bound", () => {
    expect(resolvePbr({}, true, false, false).isPbr).toBe(true);
    expect(resolvePbr({}, false, true, false).isPbr).toBe(true);
    expect(resolvePbr({}, false, false, true).isPbr).toBe(true);
  });

  it("is PBR when a metallic or roughness factor is set, even to zero", () => {
    expect(resolvePbr({ metallicFactor: 0 }, false, false, false).isPbr).toBe(true);
    expect(resolvePbr({ roughnessFactor: 0 }, false, false, false).isPbr).toBe(true);
  });

  it("treats an all-zero emissive factor as no signal, a positive one as PBR", () => {
    expect(resolvePbr({ emissiveFactor: [0, 0, 0] }, false, false, false).isPbr).toBe(false);
    expect(resolvePbr({ emissiveFactor: [0, 0, 0.2] }, false, false, false).isPbr).toBe(true);
  });

  it("defaults the factors to glTF's own (metallic 1, roughness 1, emissive 0)", () => {
    const resolved = resolvePbr({}, true, false, false);
    expect(resolved.metallic).toBe(1);
    expect(resolved.roughness).toBe(1);
    expect(resolved.emissive).toEqual([0, 0, 0]);
  });
});

describe("viewDirection", () => {
  it("is the third row of the view rotation (direction towards the viewer)", () => {
    // A camera looking down -Z from +Z: the view's third row is world +Z.
    const view = viewMatrix([0, 0, 5], [0, 0, 0]);
    const dir = viewDirection(view);
    expect(dir[0]).toBeCloseTo(0, 10);
    expect(dir[1]).toBeCloseTo(0, 10);
    expect(dir[2]).toBeCloseTo(1, 10);
  });

  it("is unit length so the shader can dot against it directly", () => {
    const view = viewMatrix([3, 2, 4], [0, 0, 0]);
    const dir = viewDirection(view);
    expect(Math.hypot(dir[0], dir[1], dir[2])).toBeCloseTo(1, 10);
  });
});

describe("interleaveVertices", () => {
  it("packs position, normal and uv at the pipeline's stride", () => {
    const out = interleaveVertices(
      new Float32Array([1, 2, 3, 4, 5, 6]),
      new Float32Array([0, 1, 0, 0, 0, 1]),
      new Float32Array([0.5, 0.25, 0.75, 1]),
    );
    expect(VERTEX_FLOATS).toBe(8); // arrayStride 32 in the pipeline descriptor
    expect(out.length).toBe(2 * VERTEX_FLOATS);
    expect(Array.from(out.subarray(0, 8))).toEqual([1, 2, 3, 0, 1, 0, 0.5, 0.25]);
    expect(Array.from(out.subarray(8, 16))).toEqual([4, 5, 6, 0, 0, 1, 0.75, 1]);
  });

  it("zero-fills uvs for an untextured primitive", () => {
    const out = interleaveVertices(new Float32Array([1, 2, 3]), new Float32Array([0, 1, 0]), null);
    expect(out[6]).toBe(0);
    expect(out[7]).toBe(0);
  });
});

describe("readback row padding", () => {
  it("rounds bytes-per-row up to WebGPU's 256-byte multiple", () => {
    expect(alignBytesPerRow(240)).toBe(1024); // 960 bytes of image, padded
    expect(alignBytesPerRow(64)).toBe(256); // already aligned, unchanged
    expect(alignBytesPerRow(640)).toBe(2560);
  });

  it("strips the padding instead of shearing the image", () => {
    const width = 3;
    const height = 2;
    const bytesPerRow = alignBytesPerRow(width); // 256, for 12 bytes of image
    const padded = new Uint8Array(bytesPerRow * height);
    // Row 0 = 1..12, row 1 = 101..112, with junk in the padding between them.
    for (let i = 0; i < 12; i += 1) padded[i] = i + 1;
    padded.fill(0xee, 12, bytesPerRow);
    for (let i = 0; i < 12; i += 1) padded[bytesPerRow + i] = 101 + i;

    const out = unpadRows(padded, width, height, bytesPerRow);
    expect(out.length).toBe(width * height * 4);
    expect(Array.from(out.subarray(0, 12))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(Array.from(out.subarray(12, 24))).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112]);
  });

  it("reuses a correctly-sized buffer and replaces a stale one", () => {
    const bytesPerRow = alignBytesPerRow(2);
    const padded = new Uint8Array(bytesPerRow * 2);
    const reusable = new Uint8Array(2 * 2 * 4);
    expect(unpadRows(padded, 2, 2, bytesPerRow, reusable)).toBe(reusable);
    // A buffer left over from a different framebuffer size must not be written
    // into — that would truncate or overflow the frame.
    const wrongSize = new Uint8Array(8);
    expect(unpadRows(padded, 2, 2, bytesPerRow, wrongSize)).not.toBe(wrongSize);
  });
});
