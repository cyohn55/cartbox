/**
 * The imported sky (HALO_INFINITE_STYLE_ROADMAP.md I6): panoramas (PNG/JPEG and
 * Radiance HDR), sky objects at infinity (a ring, a planet), and cloud layers
 * that drift — their stored form, the decoders, the bake and the backdrop.
 */

import { describe, expect, it } from "vitest";
import {
  CLOUD_TILE,
  LOCKOUT_LIGHTING,
  MAX_SKY_PANORAMA_CHARS,
  bakeCloudLayer,
  bakeSkyPanorama,
  bytesToBase64,
  cloudDensity,
  decodeRadianceHdr,
  defaultProceduralSky,
  hdrToTexture,
  panoramaWithClouds,
  parseSky,
  projectionMatrix,
  renderSkyBackground,
  resamplePanorama,
  viewMatrix,
  type DecodedTexture,
  type ProceduralSky,
  type SkyCloudLayer,
} from "@cartbox/editor";

const W = 256;
const H = 128;
const sky = (extra: Partial<ProceduralSky> = {}): ProceduralSky => ({ ...defaultProceduralSky(), clouds: 0, mountains: [], ...extra });
const layer: SkyCloudLayer = { cover: 0.5, scale: 0.4, wind: [0.05, 0.02], color: [1, 1, 1], opacity: 0.9, seed: 3 };

/** Texel (x, y) of a panorama, as [r, g, b]. */
const at = (map: DecodedTexture, x: number, y: number) => Array.from(map.data.subarray((y * map.width + x) * 4, (y * map.width + x) * 4 + 3));
/** The panorama texel a unit direction lands on (the projection sampleEnvironmentDir reads). */
function texelOf(map: DecodedTexture, d: readonly [number, number, number]): [number, number] {
  const l = Math.hypot(...d);
  const u = Math.atan2(d[2] / l, d[0] / l) / (2 * Math.PI) + 0.5;
  const v = Math.acos(d[1] / l) / Math.PI;
  return [Math.min(map.width - 1, Math.floor(u * map.width)), Math.min(map.height - 1, Math.floor(v * map.height))];
}
const differs = (a: number[], b: number[]) => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!) > 12;

describe("stored sky", () => {
  it("reads objects, cloud layers and a panorama, clamping and dropping the malformed", () => {
    const read = parseSky({
      ...defaultProceduralSky(),
      objects: [{ kind: "ring", axis: [1, 0, 0], width: 99 }, { kind: "planet", radius: -3 }, { kind: "comet" }, null],
      cloudLayers: [{ cover: 2, wind: [9, -9] }, "x"],
      panorama: { mime: "image/vnd.radiance", data: "AAAA", exposure: 999, yaw: -90 },
    })!;
    expect(read.objects).toHaveLength(2);
    expect(read.objects![0]).toMatchObject({ kind: "ring", width: 30 });
    expect(read.objects![1]).toMatchObject({ kind: "planet", radius: 0.2 });
    expect(read.cloudLayers).toEqual([{ cover: 1, scale: 0.35, wind: [2, -2], color: [0.95, 0.96, 0.98], opacity: 0.85, seed: 1 }]);
    expect(read.panorama).toEqual({ mime: "image/vnd.radiance", data: "AAAA", exposure: 64, yaw: 270 });
  });

  it("refuses a panorama that isn't an image it can decode, or is too large", () => {
    const base = defaultProceduralSky();
    expect(parseSky({ ...base, panorama: { mime: "image/gif", data: "AAAA" } })!.panorama).toBeUndefined();
    expect(parseSky({ ...base, panorama: { mime: "image/png", data: "not base64!" } })!.panorama).toBeUndefined();
    expect(parseSky({ ...base, panorama: { mime: "image/png", data: "A".repeat(MAX_SKY_PANORAMA_CHARS + 4) } })!.panorama).toBeUndefined();
  });

  it("round-trips through JSON as the lighting rig is stored", () => {
    const authored = sky({ objects: [{ kind: "ring", axis: [0.8, 0.3, 0.5], width: 4, color: [0.5, 0.6, 0.5], edge: [0.9, 0.9, 0.9], haze: 0.4, seed: 2 }], cloudLayers: [layer], panorama: { mime: "image/png", data: bytesToBase64(new Uint8Array([1, 2, 3])), exposure: 1.5, yaw: 30 } });
    expect(parseSky(JSON.parse(JSON.stringify(authored)))).toEqual(authored);
  });

  it("gives Lockout its ring, a moon and two drifting decks of cloud", () => {
    const lockout = LOCKOUT_LIGHTING.sky!;
    expect(lockout.objects!.map((o) => o.kind)).toEqual(["ring", "planet"]);
    expect(lockout.cloudLayers).toHaveLength(2);
  });
});

/** A Radiance file: header, size line, then scanlines (flat RGBE, or run-length encoded). */
function radiance(width: number, height: number, pixels: [number, number, number, number][], rle: boolean): Uint8Array {
  const head = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
  const body: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = pixels.slice(y * width, (y + 1) * width);
    if (!rle) {
      for (const p of row) body.push(...p);
      continue;
    }
    body.push(2, 2, width >> 8, width & 255);
    for (let ch = 0; ch < 4; ch += 1) {
      // One run of the first value, then the rest as literals.
      body.push(128 + 2, row[0]![ch]!);
      body.push(width - 2, ...row.slice(2).map((p) => p[ch]!));
    }
  }
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

describe("Radiance HDR", () => {
  it("decodes flat scanlines to linear floats", () => {
    // Mantissa 128 with exponent 129 is 1.0; exponent 131 is 4.0.
    const hdr = decodeRadianceHdr(radiance(2, 1, [[128, 64, 0, 129], [128, 128, 128, 131]], false))!;
    expect([hdr.width, hdr.height]).toEqual([2, 1]);
    expect(Array.from(hdr.data)).toEqual([1, 0.5, 0, 4, 4, 4]);
  });

  it("decodes run-length encoded scanlines", () => {
    const pixels = Array.from({ length: 16 }, (_, i) => [i < 2 ? 128 : 64, i, 200 - i, 129] as [number, number, number, number]);
    // The encoder repeats the first pixel's value for the run of two.
    pixels[1] = [...pixels[0]!] as [number, number, number, number];
    const hdr = decodeRadianceHdr(radiance(8, 2, pixels, true))!;
    expect(hdr.data[0]).toBe(1);
    expect(hdr.data[3 * 5 + 1]).toBeCloseTo(5 / 128, 9);
    expect(hdr.data[3 * 15 + 2]).toBeCloseTo(185 / 128, 9);
  });

  it("refuses what isn't one, and a truncated one", () => {
    expect(decodeRadianceHdr(new TextEncoder().encode("PNG..."))).toBeNull();
    const file = radiance(8, 2, Array.from({ length: 16 }, () => [1, 2, 3, 129] as [number, number, number, number]), true);
    expect(decodeRadianceHdr(file.subarray(0, file.length - 5))).toBeNull();
  });

  it("is exposed into 8 bits with a gamma", () => {
    const tex = hdrToTexture({ width: 2, height: 1, data: Float32Array.from([1, 0.25, 0, 8, 8, 8]) }, 1);
    expect(Array.from(tex.data)).toEqual([255, Math.round(255 * Math.pow(0.25, 1 / 2.2)), 0, 255, 255, 255, 255, 255]);
  });
});

describe("imported panoramas", () => {
  it("are resampled to the sky's size and turned about the vertical", () => {
    const source: DecodedTexture = { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4) };
    for (let x = 0; x < 8; x += 1) for (let y = 0; y < 4; y += 1) source.data.set([x * 30, 0, 0, 255], (y * 8 + x) * 4);
    const plain = resamplePanorama(source, 16, 8, 0);
    const turned = resamplePanorama(source, 16, 8, 90);
    // A quarter turn moves the image a quarter of the way round.
    expect(at(turned, 3, 4)).toEqual(at(plain, 7, 4));
    // A gain of 2 doubles it (before rounding to a byte).
    expect(Math.abs(resamplePanorama(source, 16, 8, 0, 2).data[(4 * 16 + 4) * 4]! - plain.data[(4 * 16 + 4) * 4]! * 2)).toBeLessThanOrEqual(1);
  });

  it("stand in for the procedural sky, with the sky's objects laid over them", () => {
    const grey: DecodedTexture = { width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4).fill(100) };
    const ring = { kind: "ring" as const, axis: [1, 0, 0] as [number, number, number], width: 10, color: [0.2, 0.8, 0.2] as [number, number, number], edge: [1, 1, 1] as [number, number, number], haze: 0, seed: 1 };
    const map = bakeSkyPanorama(sky({ objects: [ring] }), W, H, grey);
    const [ox, oy] = texelOf(map, [0, 0.95, -0.3]); // on the ring's band (the great circle through the zenith, along z)
    const [sx, sy] = texelOf(map, [0.95, 0.2, 0.2]); // well off it
    expect(at(map, sx, sy)).toEqual([100, 100, 100]);
    expect(differs(at(map, ox, oy), [100, 100, 100])).toBe(true);
  });
});

describe("sky objects", () => {
  it("draw a ring's band along its great circle and nowhere else", () => {
    const ring = { kind: "ring" as const, axis: [0, 0.3, 1] as [number, number, number], width: 6, color: [0.3, 0.7, 0.3] as [number, number, number], edge: [1, 1, 1] as [number, number, number], haze: 0.2, seed: 4 };
    const plain = bakeSkyPanorama(sky(), W, H);
    const ringed = bakeSkyPanorama(sky({ objects: [ring] }), W, H);
    // Directions on the circle perpendicular to the axis, above the horizon.
    const n = Math.hypot(0, 0.3, 1);
    const onRing: [number, number, number][] = [[1, 0, 0], [0.6, 0.76, -0.23], [-0.8, 0.57, -0.17]].map((d) => {
      const k = (d[1]! * 0.3 + d[2]! * 1) / (n * n);
      return [d[0]!, d[1]! - 0.3 * k, d[2]! - k];
    });
    for (const d of onRing) {
      const [x, y] = texelOf(ringed, d);
      if (d[1] > 0.05) expect(differs(at(ringed, x, y), at(plain, x, y))).toBe(true);
    }
    const [fx, fy] = texelOf(ringed, [0, 0.3, 1]); // the axis itself: 90° off the band
    expect(at(ringed, fx, fy)).toEqual(at(plain, fx, fy));
  });

  it("draw a planet's disc, lit on the sun's side", () => {
    const planet = { kind: "planet" as const, direction: [0, 0.4, -1] as [number, number, number], radius: 12, color: [0.8, 0.6, 0.4] as [number, number, number], atmosphere: [0.5, 0.6, 1] as [number, number, number], seed: 2 };
    // The sun off to the planet's +x side.
    const lit = bakeSkyPanorama(sky({ objects: [planet], sunDirection: [1, 0.4, -0.6] }), W, H);
    const plain = bakeSkyPanorama(sky({ sunDirection: [1, 0.4, -0.6] }), W, H);
    const [cx, cy] = texelOf(lit, [0, 0.4, -1]);
    expect(differs(at(lit, cx, cy), at(plain, cx, cy))).toBe(true);
    const lum = (p: number[]) => p[0]! + p[1]! + p[2]!;
    const [ex, ey] = texelOf(lit, [0.15, 0.4, -1]); // toward the sun
    const [wx, wy] = texelOf(lit, [-0.15, 0.4, -1]); // away from it
    expect(lum(at(lit, ex, ey))).toBeGreaterThan(lum(at(lit, wx, wy)) + 40);
  });
});

describe("drifting clouds", () => {
  it("bake to a tile that wraps seamlessly", () => {
    const baked = bakeCloudLayer(layer);
    expect(baked.density.length).toBe(CLOUD_TILE * CLOUD_TILE);
    let jump = 0;
    let inner = 0;
    for (let y = 0; y < CLOUD_TILE; y += 1) {
      jump = Math.max(jump, Math.abs(baked.density[y * CLOUD_TILE]! - baked.density[y * CLOUD_TILE + CLOUD_TILE - 1]!));
      inner = Math.max(inner, Math.abs(baked.density[y * CLOUD_TILE + 100]! - baked.density[y * CLOUD_TILE + 101]!));
    }
    // Across the wrap the density steps no more than between any two neighbours inside.
    expect(jump).toBeLessThanOrEqual(inner + 0.05);
  });

  it("drift with the wind and repeat after a tile", () => {
    const baked = bakeCloudLayer(layer);
    const tile = 1 / layer.scale;
    expect(cloudDensity(baked, 0.3, 0.7, 0)).toBeCloseTo(cloudDensity(baked, 0.3 + tile, 0.7 - tile, 0), 9);
    // Moving with the wind for t seconds is the same as standing upwind of it.
    expect(cloudDensity(baked, 0.3, 0.7, 10)).toBeCloseTo(cloudDensity(baked, 0.3 + 0.5, 0.7 + 0.2, 0), 6);
  });

  it("lay over the reflections' copy above the horizon only", () => {
    const map = bakeSkyPanorama(sky(), W, H);
    const clouded = panoramaWithClouds(map, [bakeCloudLayer({ ...layer, cover: 0.9 })], 0);
    let above = 0;
    let below = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        if (!differs(at(clouded, x, y), at(map, x, y))) continue;
        if (y < H / 2) above += 1;
        else below += 1;
      }
    }
    expect(above).toBeGreaterThan(W * 5);
    expect(below).toBe(0);
  });

  it("move across the backdrop from frame to frame, and leave it as it was without them", () => {
    const map = bakeSkyPanorama(sky(), W, H);
    const draw = (clouds: Parameters<typeof renderSkyBackground>[8]) => {
      const out = new Uint8ClampedArray(160 * 90 * 4);
      renderSkyBackground(out, 160, 90, viewMatrix([0, 0, 0], [1, 1.2, 0.3]), projectionMatrix(1.2, 160 / 90, 0.1, 100), map, 8, 2, clouds);
      return out;
    };
    const baked = [bakeCloudLayer(layer)];
    const none = draw(null);
    expect(Array.from(draw({ layers: [], time: 5 }))).toEqual(Array.from(none));
    const early = draw({ layers: baked, time: 0 });
    const later = draw({ layers: baked, time: 30 });
    const changed = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) > 6) n += 1;
      return n;
    };
    expect(changed(early, none)).toBeGreaterThan(500);
    expect(changed(early, later)).toBeGreaterThan(500);
    expect(Array.from(draw({ layers: baked, time: 30 }))).toEqual(Array.from(later));
  });
});
