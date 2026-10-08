/**
 * Refraction and distortion (HALO_INFINITE_STYLE_ROADMAP.md I5): the stored
 * fields, the shared offset maths, the shield effect's distortion, and what a
 * refracting surface does to a software-rendered frame. (The GPU shaders are
 * checked against these frames by webgpu-parity.test.ts and webgl-parity.test.ts.)
 */

import { describe, expect, it } from "vitest";
import {
  CAMO_BEND,
  REFRACTION_SCALE,
  SHIELD_FLARE_DISTORT,
  deserializeMeshAsset,
  materialRefracts,
  projectionMatrix,
  readSurfaceEffects,
  refractionOffset,
  refracts,
  renderMeshScene,
  resolveRefraction,
  serializeMeshAsset,
  shieldEffect,
  viewMatrix,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";

import { REFRACTION_TIME, refractionInstances, straightInstances } from "./helpers/refractionScenes";

type Material = Partial<MeshAsset["primitives"][number]["material"]>;

function quad(material: Material = {}): MeshAsset {
  return {
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.9, 0.4, 0.2, 1], baseColorImage: null, ...material },
      },
    ],
  };
}

const W = 192;
const H = 144;

function render(instances: MeshSceneInstance[], extra: Record<string, unknown> = {}): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  renderMeshScene(instances, {
    width: W,
    height: H,
    out,
    depth: new Float32Array(W * H),
    view: viewMatrix([0, 0, 4], [0, 0, 0]),
    projection: projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100),
    background: [20, 20, 30, 255],
    lightDirection: [0.3, 0.5, 1],
    time: REFRACTION_TIME,
    ...extra,
  });
  return out;
}

/** Pixels that differ between two frames inside a box (x0..x1, y0..y1 as shares of the frame). */
function changedIn(a: Uint8ClampedArray, b: Uint8ClampedArray, x0: number, x1: number, y0: number, y1: number): number {
  let n = 0;
  for (let y = Math.floor(y0 * H); y < Math.ceil(y1 * H); y += 1) {
    for (let x = Math.floor(x0 * W); x < Math.ceil(x1 * W); x += 1) {
      const p = (y * W + x) * 4;
      if (Math.abs(a[p]! - b[p]!) + Math.abs(a[p + 1]! - b[p + 1]!) + Math.abs(a[p + 2]! - b[p + 2]!) > 6) n += 1;
    }
  }
  return n;
}

describe("stored refraction", () => {
  it("clamps both fields and drops neutral ones", () => {
    expect(readSurfaceEffects({ refraction: 3, distortion: -1 })).toEqual({ refraction: 1 });
    expect(readSurfaceEffects({ refraction: 0, distortion: 0.4 })).toEqual({ distortion: 0.4 });
  });

  it("survives a save and load", () => {
    const back = deserializeMeshAsset(serializeMeshAsset(quad({ alphaMode: "blend", refraction: 0.6, distortion: 0.3 }))).primitives[0]!.material;
    expect(back.refraction).toBe(0.6);
    expect(back.distortion).toBe(0.3);
  });

  it("puts a refracting material on the PBR path", () => {
    expect(materialRefracts({})).toBe(false);
    expect(materialRefracts({ refraction: 0.2 })).toBe(true);
    expect(materialRefracts({ distortion: 0.2 })).toBe(true);
  });
});

describe("what refracts", () => {
  it("adds Active Camo's bend and a shield's distortion to the material's own", () => {
    expect(refracts(resolveRefraction({}, null))).toBe(false);
    expect(resolveRefraction({ refraction: 0.5 }, null)).toEqual({ bend: 0.5, warp: 0, edge: 0 });
    expect(resolveRefraction({}, { camo: 0.5 }).bend).toBe(CAMO_BEND);
    expect(resolveRefraction({}, { distort: 0.4 }).edge).toBe(0.4);
  });

  it("gives a shield's flare and recharge a distortion, and camo alone none", () => {
    expect(shieldEffect(1, 0, 0)!.distort).toBeCloseTo(SHIELD_FLARE_DISTORT, 9);
    expect(shieldEffect(0, 1, 0)!.distort).toBeGreaterThan(0);
    expect(shieldEffect(0, 0, 1)!.distort).toBeUndefined();
  });
});

describe("the offset", () => {
  it("bends by the normal seen from the camera, y down the screen", () => {
    const r = { bend: 1, warp: 0, edge: 0 };
    expect(refractionOffset(r, 0, 0, 1, 2, 3, 0, 100).map(Math.abs)).toEqual([0, 0]);
    const [dx, dy] = refractionOffset(r, 0.5, 0.25, 1, 2, 3, 0, 100);
    expect(dx).toBeCloseTo(0.5 * REFRACTION_SCALE * 100, 9);
    expect(dy).toBeCloseTo(-0.25 * REFRACTION_SCALE * 100, 9);
  });

  it("warps with noise that drifts over time, the same every time", () => {
    const r = { bend: 0, warp: 1, edge: 0 };
    const a = refractionOffset(r, 0, 0, 0.3, 0.7, 0.1, 0, 100);
    expect(refractionOffset(r, 0, 0, 0.3, 0.7, 0.1, 0, 100)).toEqual(a);
    expect(refractionOffset(r, 0, 0, 0.3, 0.7, 0.1, 0.5, 100)).not.toEqual(a);
    expect(Math.abs(a[0]!) + Math.abs(a[1]!)).toBeGreaterThan(0);
    expect(Math.max(Math.abs(a[0]!), Math.abs(a[1]!))).toBeLessThanOrEqual(REFRACTION_SCALE * 100);
  });
});

describe("software rendering", () => {
  const bent = render(refractionInstances(quad));
  const straight = render(straightInstances(quad));

  it("bends the stripes through the glass, the haze and the shield's edge, and nowhere else", () => {
    // The quads' boxes on screen: glass top left, haze top right, shield bottom right.
    expect(changedIn(bent, straight, 0.18, 0.43, 0.15, 0.49)).toBeGreaterThan(100); // glass (its centre faces the camera, so bends least)
    expect(changedIn(bent, straight, 0.57, 0.82, 0.15, 0.49)).toBeGreaterThan(100); // haze
    expect(changedIn(bent, straight, 0.57, 0.82, 0.52, 0.85)).toBeGreaterThan(50); // shield edge
    // Outside them the frame is untouched.
    expect(changedIn(bent, straight, 0, 0.17, 0, 1)).toBe(0);
    expect(changedIn(bent, straight, 0.88, 1, 0, 1)).toBe(0);
    expect(changedIn(bent, straight, 0, 1, 0.9, 1)).toBe(0);
  });

  it("never pulls a nearer object into what it bends", () => {
    // The red block sits nearer than the glass, right beside it; the glass's
    // left edge bends toward it, but takes only what lies behind the glass.
    let pulledIn = 0;
    for (let p = 0; p < W * H; p += 1) {
      const red = (f: Uint8ClampedArray) => f[p * 4]! > 200 && f[p * 4 + 1]! < 60 && f[p * 4 + 2]! < 60;
      if (red(bent) && !red(straight)) pulledIn += 1;
    }
    expect(pulledIn).toBe(0);
  });

  it("draws a refracting surface as before when nothing is behind it", () => {
    const glass = quad({ baseColorFactor: [0.6, 0.8, 1, 0.5], metallicFactor: 0, roughnessFactor: 0.2, alphaMode: "blend", refraction: 1, distortion: 1 });
    const plain = quad({ baseColorFactor: [0.6, 0.8, 1, 0.5], metallicFactor: 0, roughnessFactor: 0.2, alphaMode: "blend" });
    const model = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(Array.from(render([{ mesh: glass, model }]))).toEqual(Array.from(render([{ mesh: plain, model }])));
  });

  it("bends what it is drawn over, as a held weapon over the finished scene", () => {
    // The front layer: a fresh depth buffer, drawn over the frame already there.
    const scene = render(refractionInstances(quad).slice(0, 1));
    const blade = (material: Material) => [{ mesh: quad({ baseColorFactor: [0.2, 0.5, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.4, alphaMode: "additive", ...material }), model: [0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1] }];
    const over = (instances: MeshSceneInstance[]) => {
      const out = scene.slice();
      renderMeshScene(instances, { width: W, height: H, out, depth: new Float32Array(W * H), view: viewMatrix([0, 0, 4], [0, 0, 0]), projection: projectionMatrix((60 * Math.PI) / 180, W / H, 0.1, 100), background: null, time: REFRACTION_TIME });
      return out;
    };
    expect(changedIn(over(blade({ distortion: 0.8 })), over(blade({})), 0.3, 0.7, 0.3, 0.7)).toBeGreaterThan(50);
  });

  it("does not refract on a console with no depth buffer (nothing is drawn first)", () => {
    const style = { zBuffer: false, perspectiveCorrect: true, vertexPrecision: "float", textureFiltering: "none" } as const;
    const glassOnly = (instances: MeshSceneInstance[]) => instances.slice(0, 3);
    expect(changedIn(render(glassOnly(refractionInstances(quad)), { style }), render(glassOnly(straightInstances(quad)), { style }), 0, 1, 0, 1)).toBe(0);
  });
});
