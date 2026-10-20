/**
 * The sun's shadow cascades (AAA_FIDELITY_ROADMAP.md F2a): practical splits,
 * a bounding sphere per slice that never resizes as the camera turns, centres
 * snapped to the light's texel grid so edges never shimmer as it moves, and
 * every point of a slice (and the casters between it and the sun) inside its
 * cascade.
 */

import { describe, expect, it } from "vitest";

import { projectionMatrix, viewMatrix } from "@cartbox/editor";
import { CASCADE_COUNT, cascadeSplits, fitCascades, perspectiveLens, sliceSphere } from "../packages/player/src/render/cascades";

const project = (m: Float64Array, p: readonly number[]) => {
  const x = m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!;
  const y = m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!;
  const z = m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!;
  const w = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!;
  return [x / w, y / w, z / w];
};

const PROJECTION = projectionMatrix(1.0, 16 / 9, 0.1, 500);
const SUN: [number, number, number] = [0.42, 0.8, -0.46];

/** The world-space corners of the view slice from depth d0 to d1. */
function sliceCorners(eye: number[], target: number[], d0: number, d1: number): number[][] {
  const lens = perspectiveLens(PROJECTION);
  const f = [0, 1, 2].map((i) => target[i]! - eye[i]!);
  const fl = Math.hypot(f[0]!, f[1]!, f[2]!);
  const fw = f.map((v) => v / fl);
  // Right is forward × world up, and up completes the frame.
  const r = [-fw[2]!, 0, fw[0]!];
  const rl = Math.hypot(r[0]!, r[2]!) || 1;
  const rn = r.map((v) => v / rl);
  const u = [rn[1]! * fw[2]! - rn[2]! * fw[1]!, rn[2]! * fw[0]! - rn[0]! * fw[2]!, rn[0]! * fw[1]! - rn[1]! * fw[0]!];
  const out: number[][] = [];
  for (const d of [d0, d1]) for (const sx of [-1, 1]) for (const sy of [-1, 1]) out.push([0, 1, 2].map((i) => eye[i]! + fw[i]! * d + rn[i]! * sx * d * lens.tanX + u[i]! * sy * d * lens.tanY));
  return out;
}

describe("the cascades' splits", () => {
  it("cut the range from near to far, leaning logarithmic", () => {
    const s = cascadeSplits(0.1, 100);
    expect(s).toHaveLength(CASCADE_COUNT);
    expect(s[CASCADE_COUNT - 1]).toBeCloseTo(100, 9);
    for (let i = 1; i < s.length; i += 1) expect(s[i]!).toBeGreaterThan(s[i - 1]!);
    // Nearer than a uniform split's, farther than a logarithmic one's.
    expect(s[0]!).toBeLessThan(25);
    expect(s[0]!).toBeGreaterThan(0.1 * 1000 ** 0.25);
    // lambda 0 is the uniform split.
    expect(cascadeSplits(0, 100, 4, 0).map((v) => Math.round(v))).toEqual([25, 50, 75, 100]);
  });

  it("reads the lens off a perspective projection", () => {
    const lens = perspectiveLens(PROJECTION);
    expect(lens.near).toBeCloseTo(0.1, 6);
    expect(lens.far).toBeCloseTo(500, 3);
    expect(lens.tanY).toBeCloseTo(Math.tan(0.5), 9);
    expect(lens.tanX).toBeCloseTo(Math.tan(0.5) * (16 / 9), 9);
  });

  it("bounds each slice in a sphere holding all eight of its corners", () => {
    const lens = perspectiveLens(PROJECTION);
    for (const [d0, d1] of [[0.1, 5], [5, 20], [20, 60]] as const) {
      const s = sliceSphere(d0, d1, lens.tanX, lens.tanY);
      for (const d of [d0, d1]) {
        const dist = Math.hypot(d * Math.hypot(lens.tanX, lens.tanY), d - s.depth);
        expect(dist).toBeLessThanOrEqual(s.radius + 1e-9);
      }
    }
  });
});

describe("fitting the cascades", () => {
  const fit = (eye: [number, number, number], target: [number, number, number]) =>
    fitCascades({ view: viewMatrix(eye, target), projection: PROJECTION, toLight: SUN, distance: 80, size: 2048, reach: 60 });

  it("holds every point of each slice inside its cascade, depth in 0..1", () => {
    const eye: [number, number, number] = [3, 2, 8];
    const target: [number, number, number] = [0, 1, 0];
    const cascades = fit(eye, target);
    let d0 = 0.1;
    for (const c of cascades) {
      for (const p of sliceCorners(eye, target, d0, c.far)) {
        const [x, y, z] = project(c.viewProj, p);
        expect(Math.abs(x!)).toBeLessThanOrEqual(1);
        expect(Math.abs(y!)).toBeLessThanOrEqual(1);
        expect(z!).toBeGreaterThan(0);
        expect(z!).toBeLessThan(1);
      }
      d0 = c.far;
    }
    expect(cascades[CASCADE_COUNT - 1]!.far).toBeCloseTo(80, 6);
  });

  it("spans each cascade's depth over the world distance it gives (F2a-2)", () => {
    const cascades = fit([0, 2, 10], [0, 1, 0]);
    const l = Math.hypot(...SUN);
    const p = [0.3, 0.5, 4];
    for (const c of cascades) {
      // A step of a metre toward the sun moves a point's depth by one metre's share of the cascade's span.
      const q = p.map((v, i) => v + SUN[i]! / l);
      expect(project(c.viewProj, p)[2]! - project(c.viewProj, q)[2]!).toBeCloseTo(1 / c.depth, 9);
      expect(c.depth).toBeGreaterThan(60); // the reach and more
    }
  });

  it("keeps a caster between the slice and the sun in front of the light", () => {
    const eye: [number, number, number] = [0, 2, 10];
    const cascades = fit(eye, [0, 1, 0]);
    // A tower 50 m toward the sun from the first slice's centre.
    const l = Math.hypot(...SUN);
    const p = [0, 1, 2].map((i) => [0, 2, 9][i]! + (SUN[i]! / l) * 50);
    expect(project(cascades[0]!.viewProj, p)[2]!).toBeGreaterThan(0);
  });

  it("never resizes as the camera turns, and moves only in whole texels as it moves", () => {
    const a = fit([0, 2, 10], [0, 1, 0]);
    const b = fit([0, 2, 10], [7, 0, -3]);
    a.forEach((c, i) => expect(b[i]!.texel).toBeCloseTo(c.texel, 12));
    // A world point, seen by the first cascade before and after a small step: it lands on the same sub-texel spot.
    const before = fit([0, 2, 10], [0, 1, 0]);
    const after = fit([0.013, 2, 10.007], [0.013, 1, 0.007]);
    const p = [1.234, 0.5, 4.321];
    for (const k of [0, 1]) {
      const [x0, y0] = project(before[k]!.viewProj, p);
      const [x1, y1] = project(after[k]!.viewProj, p);
      const texels = (v: number) => ((v * 2048) / 2) % 1;
      expect(Math.abs(((texels(x0!) - texels(x1!) + 1.5) % 1) - 0.5)).toBeLessThan(1e-3);
      expect(Math.abs(((texels(y0!) - texels(y1!) + 1.5) % 1) - 0.5)).toBeLessThan(1e-3);
    }
  });
});
