/**
 * Cart→host parallax-camera protocol tests (cinematic gap #3, item 3).
 *
 * A scene cart pans its backdrop by calling cartbox.camera(x, y), which writes a
 * signed fixed-point (x, y) into the two mailbox words past the lights block; the
 * host decodes it each frame and feeds it to the backdrop surface as the camera
 * base. These tests:
 *   - encode a camera exactly as the SDK Lua does and prove decodeCamera inverts
 *     it across signs and fractions (what the cart writes is what the host reads)
 *   - prove the camera shares the 64-word mailbox with lights without collision
 *   - prove SceneBackdropSurface actually shifts the backdrop by the camera base,
 *     and that the default (0,0) leaves an auto-scroll-only cart unchanged
 */

import { describe, expect, it } from "vitest";
import {
  CAMERA_BASE,
  CAMERA_SCALE,
  LIGHTS_BASE,
  LIGHTS_CAPACITY,
  LIGHT_STRIDE,
  MAILBOX_WORDS,
  CARTBOX_SDK_LUA,
  decodeCamera,
  decodeLights,
  SceneBackdropSurface,
  type SceneSpec,
} from "@cartbox/player";

/** Mirrors the SDK Lua: `pmem(_CB, math.floor(v*16+0.5) & 0xffffffff)`. */
function encodeCamera(words: Uint32Array, x: number, y: number): void {
  words[CAMERA_BASE] = Math.floor(x * CAMERA_SCALE + 0.5) >>> 0;
  words[CAMERA_BASE + 1] = Math.floor(y * CAMERA_SCALE + 0.5) >>> 0;
}

describe("decodeCamera", () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [120, -40],
    [-3.5, 7.25],
    [-1000.0625, 999.9375],
  ];
  for (const [x, y] of cases) {
    it(`round-trips (${x}, ${y}) through the SDK encoding`, () => {
      const words = new Uint32Array(MAILBOX_WORDS);
      encodeCamera(words, x, y);
      const camera = decodeCamera(words);
      // 1/CAMERA_SCALE is the fixed-point resolution; values land within half of it.
      expect(camera.x).toBeCloseTo(x, 1);
      expect(camera.y).toBeCloseTo(y, 1);
    });
  }

  it("reads an unset camera as the origin, leaving auto-scroll untouched", () => {
    expect(decodeCamera(new Uint32Array(MAILBOX_WORDS))).toEqual({ x: 0, y: 0 });
  });

  it("returns the origin rather than reading out of bounds on a short window", () => {
    expect(decodeCamera(new Uint32Array(CAMERA_BASE))).toEqual({ x: 0, y: 0 });
  });

  it("keeps the camera inside the reserved mailbox window", () => {
    expect(CAMERA_BASE).toBe(LIGHTS_BASE + 1 + LIGHTS_CAPACITY * LIGHT_STRIDE);
    expect(CAMERA_BASE + 1).toBeLessThan(MAILBOX_WORDS);
  });

  it("does not collide with a full lights block", () => {
    const words = new Uint32Array(MAILBOX_WORDS);
    // Fill every lights slot, then publish a camera: decoding one must not disturb
    // the other (they own disjoint words).
    words[LIGHTS_BASE] = LIGHTS_CAPACITY;
    for (let i = 0; i < LIGHTS_CAPACITY; i += 1) {
      const base = LIGHTS_BASE + 1 + i * LIGHT_STRIDE;
      words[base + 4] = 0xffffff; // white
      words[base + 5] = CAMERA_SCALE; // any intensity
    }
    encodeCamera(words, 42, -17);
    expect(decodeLights(words)).toHaveLength(LIGHTS_CAPACITY);
    expect(decodeCamera(words)).toEqual({ x: 42, y: -17 });
  });

  it("is exposed to carts through the injected SDK", () => {
    expect(CARTBOX_SDK_LUA).toContain("camera = function");
    expect(CARTBOX_SDK_LUA).toContain("pmem(_CB");
  });
});

/** A DisplaySurface that just keeps the last frame it was handed. */
function recordingSurface() {
  let last: Uint8Array | null = null;
  return {
    surface: { blit: (rgba: Uint8Array) => { last = rgba.slice(); }, destroy: () => {} },
    get last() {
      return last;
    },
  };
}

/** A single opaque red column at x=col, transparent elsewhere. */
function stripeLayer(width: number, height: number, col: number) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const i = (y * width + col) * 4;
    pixels[i] = 255;
    pixels[i + 3] = 255;
  }
  return { pixels, width, height, depth: 0, wrapX: false, offsetY: 0 };
}

describe("SceneBackdropSurface camera base", () => {
  const W = 32;
  const H = 8;
  const spec: SceneSpec = {
    layers: [],
    atmosphere: { fog: [0, 0, 0], density: 0, desaturate: 0, lift: 0 },
    camera: { autoScrollX: 0, autoScrollY: 0 },
    keyColor: 0,
  };
  const keyRgb: [number, number, number] = [0, 0, 0];

  /** Column of the first bright-red pixel in row 0 of a rendered frame, or -1. */
  function redColumn(frame: Uint8Array): number {
    for (let x = 0; x < W; x += 1) {
      if (frame[x * 4]! > 128) return x;
    }
    return -1;
  }

  /** Render one frame with the given camera base over an all-key cart frame. */
  function renderAt(baseX: number, startCol: number): number {
    const rec = recordingSurface();
    // depth 0 → parallax factor 1, so the layer shifts by exactly the camera x.
    const surface = new SceneBackdropSurface(rec.surface, W, H, [stripeLayer(W, H, startCol)], spec, keyRgb);
    surface.setCameraBase({ x: baseX, y: 0 });
    surface.blit(new Uint8Array(W * H * 4)); // all key colour → whole frame is backdrop
    return redColumn(rec.last!);
  }

  it("shifts the backdrop horizontally by the camera base for a full-parallax layer", () => {
    const start = 20;
    const atZero = renderAt(0, start);
    const atTen = renderAt(10, start);
    expect(atZero).toBe(start); // no base → layer sits where it was authored
    expect(atTen).toBe(start - 10); // camera x moves the near layer by the same amount
  });

  it("leaves the frame identical to no-camera when the base is the origin", () => {
    const rec = recordingSurface();
    const surface = new SceneBackdropSurface(rec.surface, W, H, [stripeLayer(W, H, 12)], spec, keyRgb);
    surface.blit(new Uint8Array(W * H * 4)); // never called setCameraBase
    const withoutBase = redColumn(rec.last!);
    expect(withoutBase).toBe(renderAt(0, 12));
  });
});
