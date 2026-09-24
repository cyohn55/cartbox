/**
 * Lockout graphics pass 3 — materials & lighting. Covers the compressed PNG
 * path (real DEFLATE, verified by Node's zlib), the slope-scaled + PCF shadow
 * test that removed the acne on sloped Forerunner faces, and the arena's
 * 256² weathered PBR texture sets and cold grade.
 */

import { inflateSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  LOCKOUT_FX,
  lockoutMeshSidecar,
  deserializeMeshAsset,
  encodeRgbaPng,
  shadowVisibility,
  type ShadowInput,
} from "@cartbox/editor";
import { deflateFixed } from "../packages/editor/src/model/png";

/** Decode an 8-bit RGBA PNG (any row filter) with Node's zlib. */
function decodePng(png: Uint8Array): { width: number; height: number; data: Uint8Array } {
  const b = Buffer.from(png);
  let o = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString("ascii", o + 4, o + 8);
    const d = b.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = d.readUInt32BE(0);
      height = d.readUInt32BE(4);
    }
    if (type === "IDAT") idat.push(d);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? out[y * stride + x - 4]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4]! : 0;
      let v = raw[y * (stride + 1) + 1 + x]!;
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, data: out };
}

describe("compressed PNG encoding", () => {
  it("deflates losslessly (zlib inflates it back byte for byte)", () => {
    const data = Uint8Array.from({ length: 50000 }, (_, i) => (i % 251) ^ ((i >> 7) & 15));
    const packed = deflateFixed(data);
    expect(Buffer.compare(inflateRawSync(Buffer.from(packed)), Buffer.from(data))).toBe(0);
    expect(packed.length).toBeLessThan(data.length);
  });

  it("round-trips an image through row filters + DEFLATE, much smaller than stored", () => {
    const w = 64;
    const h = 48;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      rgba[i * 4] = (i % w) * 3;
      rgba[i * 4 + 1] = Math.floor(i / w) * 5;
      rgba[i * 4 + 2] = 90;
      rgba[i * 4 + 3] = 255;
    }
    const png = encodeRgbaPng(rgba, w, h, { compress: true });
    const decoded = decodePng(png);
    expect(decoded.width).toBe(w);
    expect(Array.from(decoded.data)).toEqual(Array.from(rgba));
    expect(png.length).toBeLessThan(encodeRgbaPng(rgba, w, h).length / 4);
  });
});

describe("shadowVisibility", () => {
  // A 4x4 map whose stored depth is 0.5 everywhere.
  const base: ShadowInput = {
    lightViewProj: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    depth: new Float32Array(16).fill(0.5),
    size: 4,
    bias: 0.003,
  };

  it("keeps the constant-bias, hard-edged behaviour by default", () => {
    expect(shadowVisibility(base, 0, 0, 0.4, 1)).toBe(1); // in front of the stored surface
    expect(shadowVisibility(base, 0, 0, 0.6, 1)).toBe(0); // behind it: fully shadowed
    expect(shadowVisibility({ ...base, strength: 0.7 }, 0, 0, 0.6, 1)).toBeCloseTo(0.3);
    expect(shadowVisibility(base, 2, 0, 0.9, 1)).toBe(1); // outside the map: lit
  });

  it("scales the bias with slope, so grazing faces stop self-shadowing (acne)", () => {
    // A fragment a hair behind the stored depth: acne on a grazing face…
    expect(shadowVisibility(base, 0, 0, 0.506, 0.1)).toBe(0);
    // …cured by the slope-scaled bias, while a face square to the light is unaffected.
    const sloped = { ...base, slopeBias: 0.0012 };
    expect(shadowVisibility(sloped, 0, 0, 0.506, 0.1)).toBe(1);
    expect(shadowVisibility(sloped, 0, 0, 0.506, 1)).toBe(0);
  });

  it("softens edges with 2x2 PCF", () => {
    const depth = new Float32Array(16).fill(1);
    depth[1 * 4 + 1] = 0; // one occluding texel
    const pcf: ShadowInput = { ...base, depth, pcf: true };
    // On the texel corner shared with the occluder: one of four taps is shadowed.
    const lx = (2 / 4) * 2 - 1; // texel (2,·) left edge in NDC
    const ly = 1 - (2 / 4) * 2;
    expect(shadowVisibility(pcf, lx, ly, 0.5, 1)).toBeCloseTo(0.75);
  });
});

describe("the Lockout materials", () => {
  const map = deserializeMeshAsset((JSON.parse(lockoutMeshSidecar()) as { meshes: { mesh: string }[] }).meshes[0]!.mesh);

  it("gives walls, decks and snow their own 256² PBR texture sets", () => {
    for (const name of ["forerunner", "forerunner-deck", "snow"]) {
      const prim = map.primitives.find((p) => p.material.name === name)!;
      expect(prim, name).toBeTruthy();
      const albedo = decodePng(prim.material.baseColorImage!.bytes);
      expect(albedo.width).toBe(256);
      expect(prim.material.normalImage).toBeTruthy();
      expect(prim.material.metallicRoughnessImage).toBeTruthy();
    }
  });

  it("paints weathering: the wall albedo varies within a panel, not just at seams", () => {
    const wall = map.primitives.find((p) => p.material.name === "forerunner")!;
    const { data } = decodePng(wall.material.baseColorImage!.bytes);
    const distinct = new Set<number>();
    // Sample the middle of the top band's sub-panel.
    for (let y = 30; y < 60; y += 1) for (let x = 40; x < 90; x += 1) distinct.add(data[(y * 256 + x) * 4]!);
    expect(distinct.size).toBeGreaterThan(12);
  });

  it("stays compact: the whole sidecar (arena + 7 soldiers + 6 weapons + textures) under ~1.2 MB", () => {
    // The sidecar format has no mesh sharing, so each of the 7 soldiers is its
    // own copy; this bound keeps a cart save well inside a request body limit.
    expect(lockoutMeshSidecar().length).toBeLessThan(1_200_000);
  });

  it("ships a cold grade: bloom, contrast, cool split tone, vignette", () => {
    expect(LOCKOUT_FX.enabled).toMatchObject({ bloom: true, grade: true, splittone: true, vignette: true });
    const [r, , b] = [1, 3, 5].map((i) => parseInt(LOCKOUT_FX.colors["splittone.shadows"].slice(i, i + 2), 16));
    expect(b!).toBeGreaterThan(r!); // shadows pushed toward blue
  });
});
