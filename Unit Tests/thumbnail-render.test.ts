/**
 * Unit tests for the thumbnail render worker's pure/injectable core:
 *   - upscaleNearestNeighbor (pixel scaling)
 *   - encodePng/decodePng round-trip
 *   - renderThumbnail (warmup + capture + upscale + encode) via a fake console
 *
 * The render pipeline is exercised end-to-end with a real PNG encode/decode and
 * a fake console that returns a known pattern, so we assert on actual output
 * pixels — not mocks of the behaviour.
 *
 * Run with:
 *   npx vitest run
 */

import { describe, expect, it, vi } from "vitest";

import { MODELS } from "@cartbox/player";

import { upscaleNearestNeighbor } from "../services/render/src/framebuffer";
import { decodePng, encodePng } from "../services/render/src/png";
import { renderThumbnail } from "../services/render/src/renderThumbnail";

// The classic model's native resolution, used to size the fake framebuffers.
const CLASSIC = MODELS.classic;
const NATIVE_WIDTH = CLASSIC.width;
const NATIVE_HEIGHT = CLASSIC.height;

/** Builds a deterministic RGBA test pattern so pixels are individually checkable. */
function makePattern(width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = x & 0xff;
      rgba[i + 1] = y & 0xff;
      rgba[i + 2] = (x + y) & 0xff;
      rgba[i + 3] = 0xff;
    }
  }
  return rgba;
}

/** Minimal ConsoleInstance stand-in that counts ticks and returns a fixed frame. */
function makeFakeConsole(frame: Uint8Array) {
  let tickCount = 0;
  return {
    loadCartridge: () => true,
    tick: () => {
      tickCount += 1;
    },
    readFramebuffer: () => frame,
    readAudioSamples: () => new Int16Array(0),
    dispose: () => {},
    get tickCount() {
      return tickCount;
    },
  };
}

describe("upscaleNearestNeighbor", () => {
  it("returns an identical-size copy at factor 1", () => {
    const source = makePattern(4, 3);
    const result = upscaleNearestNeighbor(source, 4, 3, 1);
    expect(result).toEqual(source);
    expect(result).not.toBe(source); // a copy, not the same reference
  });

  it("scales dimensions by the factor and replicates each source pixel into a block", () => {
    const width = 3;
    const height = 2;
    const factor = 4;
    const source = makePattern(width, height);
    const result = upscaleNearestNeighbor(source, width, height, factor);

    expect(result.length).toBe(width * factor * height * factor * 4);

    // Every destination pixel must equal its nearest source pixel.
    const dstWidth = width * factor;
    for (let dstY = 0; dstY < height * factor; dstY++) {
      for (let dstX = 0; dstX < dstWidth; dstX++) {
        const srcX = Math.floor(dstX / factor);
        const srcY = Math.floor(dstY / factor);
        const srcIndex = (srcY * width + srcX) * 4;
        const dstIndex = (dstY * dstWidth + dstX) * 4;
        expect(result.slice(dstIndex, dstIndex + 4)).toEqual(source.slice(srcIndex, srcIndex + 4));
      }
    }
  });

  it("rejects a bad factor or mismatched source length", () => {
    const source = makePattern(2, 2);
    expect(() => upscaleNearestNeighbor(source, 2, 2, 0)).toThrow(RangeError);
    expect(() => upscaleNearestNeighbor(source, 2, 2, 1.5)).toThrow(RangeError);
    expect(() => upscaleNearestNeighbor(source, 3, 3, 2)).toThrow(RangeError);
  });
});

describe("encodePng / decodePng", () => {
  it("round-trips RGBA pixels without loss", () => {
    const width = 8;
    const height = 5;
    const pixels = makePattern(width, height);

    const decoded = decodePng(encodePng(pixels, width, height));

    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(Uint8Array.from(decoded.data)).toEqual(pixels);
  });
});

describe("renderThumbnail", () => {
  it("advances the requested warmup frames before capturing", () => {
    const frame = makePattern(NATIVE_WIDTH, NATIVE_HEIGHT);
    const console = makeFakeConsole(frame);

    renderThumbnail(console, CLASSIC, { warmupFrames: 7, upscale: 1 });

    expect(console.tickCount).toBe(7);
  });

  it("produces a PNG upscaled from the captured frame, pixel-accurate", () => {
    const frame = makePattern(NATIVE_WIDTH, NATIVE_HEIGHT);
    const console = makeFakeConsole(frame);
    const upscale = 2;

    const png = renderThumbnail(console, CLASSIC, { warmupFrames: 1, upscale });
    const decoded = decodePng(png);

    expect(decoded.width).toBe(NATIVE_WIDTH * upscale);
    expect(decoded.height).toBe(NATIVE_HEIGHT * upscale);

    // Spot-check that the top-left source pixel fills its upscaled block.
    const dstWidth = NATIVE_WIDTH * upscale;
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const index = (dy * dstWidth + dx) * 4;
      expect(Array.from(decoded.data.slice(index, index + 4))).toEqual([0, 0, 0, 0xff]);
    }
  });

  it("uses an injected encoder with the upscaled dimensions", () => {
    const frame = makePattern(NATIVE_WIDTH, NATIVE_HEIGHT);
    const console = makeFakeConsole(frame);
    const encode = vi.fn(() => Buffer.from([1, 2, 3]));

    const output = renderThumbnail(console, CLASSIC, { warmupFrames: 1, upscale: 3, encode });

    expect(output).toEqual(Buffer.from([1, 2, 3]));
    expect(encode).toHaveBeenCalledWith(expect.any(Uint8Array), NATIVE_WIDTH * 3, NATIVE_HEIGHT * 3);
  });

  it("rejects a non-positive warmup frame count", () => {
    const console = makeFakeConsole(makePattern(NATIVE_WIDTH, NATIVE_HEIGHT));
    expect(() => renderThumbnail(console, CLASSIC, { warmupFrames: 0 })).toThrow(RangeError);
  });
});
