/**
 * The look-dev stage (AAA_FIDELITY_ROADMAP.md F10c): the props and rigs it
 * builds, the turntable, and, on a real device (Dawn), the check that draws it
 * with the linear-light renderer and the path-traced reference (F10b).
 */

import { describe, expect, it } from "vitest";

import { multiplyMat4, type EnvironmentLight, type MeshAsset } from "@cartbox/editor";

import { COLOR_CHECKER, GREY_CARD, LOOK_DEV_RIGS, authoredFromLinear, lookDevChart, lookDevStage, meshBounds, turnEnvironment } from "../packages/player/src/render/lookDev";
import { checkLookDev, lookDevDraw } from "../packages/player/src/render/lookDevCheck";

const srgb = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function box(name: string, h = 2): MeshAsset {
  // Two triangles standing 1 m wide and h tall, with their feet at y = −1 (so the stage must lift them).
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from([-0.5, -1, 0, 0.5, -1, 0, 0.5, h - 1, 0, -0.5, h - 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name, baseColorFactor: [0.7, 0.7, 0.7, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.7 },
      },
    ],
  } as unknown as MeshAsset;
}

/** A point through a column-major 4×4. */
const apply = (m: ArrayLike<number>, [x, y, z]: readonly number[]) => [0, 1, 2].map((r) => m[r]! * x! + m[4 + r]! * y! + m[8 + r]! * z! + m[12 + r]!);

describe("the look-dev stage", () => {
  it("carries the 24 ColorChecker patches, and a grey card at 18%", () => {
    expect(COLOR_CHECKER).toHaveLength(24);
    expect(new Set(COLOR_CHECKER.map((p) => p.name)).size).toBe(24);
    // The neutral row runs white to black.
    const neutrals = COLOR_CHECKER.slice(18).map((p) => p.srgb[1]);
    expect([...neutrals].sort((a, b) => b - a)).toEqual(neutrals);
    expect(srgb(authoredFromLinear(GREY_CARD))).toBeCloseTo(GREY_CARD, 6);
    const chart = lookDevChart(0.1);
    // A black card, then the patches in order.
    expect(chart.primitives).toHaveLength(25);
    expect(chart.primitives[19]!.material.baseColorFactor.slice(0, 3)).toEqual([243 / 255, 243 / 255, 242 / 255]);
  });

  it("stands the asset on the floor at the origin, with the props sized to it beside it", () => {
    const asset = box("a");
    const stage = lookDevStage(asset, { rig: "studio" });
    // The asset, two balls, the chart and the floor.
    expect(stage.instances).toHaveLength(5);
    const placed = apply(stage.instances[0]!.model, [0, -1, 0]);
    expect(placed[1]).toBeCloseTo(0, 6);
    const bounds = meshBounds(asset);
    expect(bounds.min[1]).toBe(-1);
    expect(stage.greyBall!.centre[1]).toBeCloseTo(stage.greyBall!.radius, 6);
    expect(stage.chromeBall!.centre[0]).toBeGreaterThan(stage.greyBall!.centre[0]);
    expect(stage.chart!.centre[0]).toBeLessThan(0);
    // Everything the camera should see is in front of it and inside the frame.
    const viewProj = multiplyMat4(stage.projection, stage.view);
    for (const p of [[0, 0, 0], [0, 2, 0], stage.greyBall!.centre, stage.chromeBall!.centre, stage.chart!.centre]) {
      const [x, y, , w] = [0, 1, 2, 3].map((r) => viewProj[r]! * p[0]! + viewProj[4 + r]! * p[1]! + viewProj[8 + r]! * p[2]! + viewProj[12 + r]!);
      expect(w).toBeGreaterThan(0);
      expect(Math.abs(x! / w!)).toBeLessThan(1);
      expect(Math.abs(y! / w!)).toBeLessThan(1);
    }
    // Props off, only the asset is left.
    expect(lookDevStage(asset, { rig: "studio", balls: false, chart: false, floor: false }).instances).toHaveLength(1);
  });

  it("lights each rig, and turns the asset on the turntable", () => {
    for (const rig of LOOK_DEV_RIGS) {
      const stage = lookDevStage(box("r"), { rig: rig.id });
      expect(stage.lights.length).toBeGreaterThan(0);
      expect(stage.environment).not.toBeNull();
      expect(stage.exposure).toBeGreaterThan(0);
    }
    // The night needs far more exposure than noon.
    expect(lookDevStage(null, { rig: "night" }).exposure).toBeGreaterThan(lookDevStage(null, { rig: "noon" }).exposure * 20);
    const turned = lookDevStage(box("t"), { rig: "noon", turntable: Math.PI / 2 });
    // A quarter turn takes the asset's +x corner toward −z.
    const corner = apply(turned.instances[0]!.model, [0.5, 0, 0]);
    expect(corner[0]).toBeCloseTo(0, 5);
    expect(corner[2]).toBeCloseTo(-0.5, 5);
  });

  it("turns the HDRI about a still asset", () => {
    const data = new Float32Array(4 * 1 * 3);
    data.set([1, 0, 0], 0);
    const env = { sky: [0, 0, 0], horizon: [0, 0, 0], ground: [0, 0, 0], intensity: 1, hdr: { width: 4, height: 1, data } } as unknown as EnvironmentLight;
    // A quarter turn the other way round moves the first column one along.
    const turned = turnEnvironment(env, -Math.PI / 2);
    expect(Array.from(turned.hdr!.data.slice(3, 6))).toEqual([1, 0, 0]);
    expect(Array.from(turnEnvironment(env, 0).hdr!.data)).toEqual(Array.from(data));
    const stage = lookDevStage(box("h"), { rig: "hdri", environment: env, turntable: -Math.PI / 2 });
    expect(Array.from(stage.environment!.hdr!.data.slice(3, 6))).toEqual([1, 0, 0]);
    // The asset stays where it stands.
    expect(apply(stage.instances[0]!.model, [0.5, 0, 0])[0]).toBeCloseTo(0.5, 5);
    // Without an HDRI the studio stands in.
    expect(lookDevStage(box("s"), { rig: "hdri" }).lights.some((l) => l.kind === "area")).toBe(true);
  });

  it("draws with the rig's lights, sky, shadows and camera", () => {
    const stage = lookDevStage(box("d"), { rig: "noon" });
    const draw = lookDevDraw(stage, 64, 36) as any;
    expect(draw.lights).toBe(stage.lights);
    expect(draw.environment).toBe(stage.environment);
    expect(draw.sunShadow.toLight).toEqual(stage.lights[0]!.direction);
    expect(draw.prepass).toBe(true);
    expect(lookDevDraw(lookDevStage(null, { rig: "overcast" }), 64, 36).sunShadow).toBeUndefined();
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
  } catch {
    return null;
  }
}
const device = await realDevice();

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 20000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    device.tick?.();
  }
  return promise;
}

describe.skipIf(!device)("the look-dev check on a real device", { timeout: 300_000 }, () => {
  it("reads the grey ball alike in the renderer and the reference under an overcast sky", async () => {
    const stage = lookDevStage(box("c"), { rig: "overcast", chart: false });
    device.pushErrorScope("validation");
    const check = await settled(checkLookDev(device, stage, 96, 54, 64, settled));
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    expect(check.raster.data.length).toBe(96 * 54 * 4);
    const grey = check.greyBall!;
    // Lit by a sky of about 0.85 over its upper half, an 18% ball reflects about 0.1.
    expect(grey.reference).toBeGreaterThan(0.05);
    expect(grey.reference).toBeLessThan(0.2);
    // The raster's sky lights the ball's underside where the reference sees the darker floor: about 15% apart (measured).
    expect(Math.abs(grey.raster - grey.reference) / grey.reference).toBeLessThan(0.25);
    expect(check.chromeBall).not.toBeNull();
    // About 8% apart over the frame (measured).
    expect(check.frameError).toBeLessThan(0.15);
    expect(check.outliers).toBeGreaterThanOrEqual(0);
    expect(check.outliers).toBeLessThanOrEqual(1);
  });
});
