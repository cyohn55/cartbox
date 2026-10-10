/**
 * Dynamic bounce light (HALO_INFINITE_STYLE_ROADMAP.md I17): probes relight as
 * lights move. Under the light they were baked with they are exactly the bake;
 * under another sun they come out close to a fresh bake with that sun; a point
 * light bounces off the floor in its colour, and not through a wall.
 */

import { describe, expect, it } from "vitest";
import {
  BounceTransferBuilder,
  bakeLightProbes,
  buildBounceTransfer,
  composeModelMatrix,
  probeBounce,
  relightProbes,
  surfelLight,
  type BounceLights,
  type MeshAsset,
  type MeshPrimitive,
} from "@cartbox/editor";

const IDENTITY = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);

/** A box (w × h × d) at `at`, its base on `at`'s y, wound outward. */
function box(w: number, h: number, d: number, at: [number, number, number], color: [number, number, number, number]): MeshPrimitive {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const faces: [number[], number[], number[], number, number, number[]][] = [
    [[0, 1, 0], [1, 0, 0], [0, 0, -1], w / 2, d / 2, [0, h, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1], w / 2, d / 2, [0, 0, 0]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0], d / 2, h / 2, [w / 2, h / 2, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0], d / 2, h / 2, [-w / 2, h / 2, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0], w / 2, h / 2, [0, h / 2, d / 2]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0], w / 2, h / 2, [0, h / 2, -d / 2]],
  ];
  for (const [n, u, v, hu, hv, c] of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(at[0] + c[0]! + u[0]! * su! * hu + v[0]! * sv! * hv, at[1] + c[1]! + u[1]! * su! * hu + v[1]! * sv! * hv, at[2] + c[2]! + u[2]! * su! * hu + v[2]! * sv! * hv);
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: null, indices: Uint32Array.from(indices), material: { name: "m", baseColorFactor: color, baseColorImage: null } };
}

/** A courtyard: a wide white floor slab, a tall wall along its north edge. */
const yard: MeshAsset = {
  name: "yard",
  primitives: [box(12, 0.5, 12, [0, -0.5, 0], [0.8, 0.8, 0.8, 1]), box(12, 4, 0.5, [0, 0, -4], [0.7, 0.6, 0.5, 1])],
};
const occluders = [{ mesh: yard, model: IDENTITY }];
const SUN: [number, number, number] = [0.3, 0.8, 0.5];
const OPTIONS = { rays: 64, distance: 6, sun: SUN, bounce: 0.9, contrast: 1 } as const;
const grid = bakeLightProbes([-4, 0.5, -3], [4, 3, 4], [5, 3, 5], occluders, OPTIONS);
const transfer = buildBounceTransfer(grid, occluders, { rays: 64, distance: 6, bounce: 0.9, spacing: 0.5 });
const asBaked: BounceLights = { sun: { direction: SUN, color: [1, 1, 1] }, points: [] };
const baked = probeBounce(transfer, surfelLight(transfer, asBaked));
const face = (probe: number, f: number) => (probe * 6 + f) * 3;

describe("dynamic bounce", () => {
  it("is exactly the bake under the light the probes were baked with", () => {
    expect(relightProbes(transfer, baked, baked).values).toEqual(grid.values);
  });

  it("comes out close to a fresh bake when the sun moves", () => {
    const evening: [number, number, number] = [-0.7, 0.3, 0.6];
    const fresh = bakeLightProbes([-4, 0.5, -3], [4, 3, 4], [5, 3, 5], occluders, { ...OPTIONS, sun: evening });
    const relit = relightProbes(transfer, probeBounce(transfer, surfelLight(transfer, { sun: { direction: evening, color: [1, 1, 1] }, points: [] })), baked);
    let error = 0, change = 0;
    for (let i = 0; i < grid.values.length; i += 1) {
      error += Math.abs(relit.values[i]! - fresh.values[i]!);
      change += Math.abs(grid.values[i]! - fresh.values[i]!);
    }
    // The move matters, and the relight follows most of it (ray noise and surfel blur aside).
    expect(change / grid.values.length).toBeGreaterThan(0.02);
    expect(error).toBeLessThan(change * 0.35);
  });

  it("bounces a point light off the floor in its colour, and not through a wall", () => {
    // The probe in the middle of the bottom layer (x = 2, y = 0, z = 2), its −Y face looking at the floor.
    const probe = (2 * 3 + 0) * 5 + 2; // probes run x fastest, then y (3 layers), then z
    const cyan: BounceLights = { sun: null, points: [{ position: [0, 0.4, 1.5], color: [0.2, 1.2, 1.6], range: 4 }] };
    const lit = probeBounce(transfer, surfelLight(transfer, cyan));
    const down = face(probe, 3);
    expect(lit[down + 2]!).toBeGreaterThan(0.05);
    expect(lit[down + 2]!).toBeGreaterThan(lit[down]! * 3); // cyan, not white
    // The same light behind the wall (north of it): the floor on this side stays dark.
    const behind = probeBounce(transfer, surfelLight(transfer, { sun: null, points: [{ position: [0, 1, -5.5], color: [0.2, 1.2, 1.6], range: 4 }] }));
    expect(behind[down + 2]!).toBeLessThan(lit[down + 2]! * 0.1);
  });

  it("is found a slice at a time, the same as all at once", () => {
    const builder = new BounceTransferBuilder(grid, occluders, { rays: 64, distance: 6, bounce: 0.9, spacing: 0.5 });
    let steps = 0;
    while (!builder.step(37)) steps += 1;
    expect(steps).toBeGreaterThan(5);
    expect(builder.progress()).toBe(1);
    const sliced = builder.result()!;
    expect(Array.from(sliced.weight)).toEqual(Array.from(transfer.weight));
    expect(Array.from(sliced.start)).toEqual(Array.from(transfer.start));
  });
});

describe("Lockout's bounce", () => {
  it("is baked with its light recorded, so the ball's glow and a grenade's light bounce off the deck onto the Spartans", async () => {
    const { decodeLightProbes, lockoutMeshSidecar, readProbeBake, LOCKOUT_CODE } = await import("@cartbox/editor");
    const { parseMeshScene } = await import("@cartbox/player");
    const scene = parseMeshScene(lockoutMeshSidecar())!;
    const stored = scene.lighting!.lightProbes!;
    const bake = readProbeBake(stored)!;
    expect(bake.distance).toBe(7);
    expect(bake.sun[1]).toBeGreaterThan(0.5);
    // The cart's moving lights, which the player now bounces.
    expect(LOCKOUT_CODE).toContain("cartbox.light3d(ball.x");
    expect(LOCKOUT_CODE).toContain("cartbox.light3d(g.x");
    const probes = decodeLightProbes(stored)!;
    const still = scene.instances.filter((i) => !i.pooled && !i.mesh.skin && !i.physics?.body).map((i) => ({ mesh: i.mesh, model: i.model }));
    const t = buildBounceTransfer(probes, still, { distance: bake.distance, bounce: bake.bounce });
    const asBaked = probeBounce(t, surfelLight(t, { sun: { direction: bake.sun, color: [1, 1, 1] }, points: [] }));
    expect(relightProbes(t, asBaked, asBaked).values).toEqual(probes.values);
    // The ball's cyan glow in the Sword pit (as the cart lights it, in the rig's key units): the probes round it turn cyan.
    const ball = relightProbes(t, probeBounce(t, surfelLight(t, { sun: { direction: bake.sun, color: [1, 1, 1] }, points: [{ position: [0, 1.3, 0], color: [0.35 * 1.1, 0.86 * 1.1, 1.1], range: 5 }] })), asBaked);
    // (A glow is far dimmer than the sun, and the probes stand 2.5 m apart: a handful near it take it up.)
    let bluer = 0, most = 0, redder = 0;
    for (let i = 2; i < probes.values.length; i += 3) {
      const gain = ball.values[i]! - probes.values[i]!;
      if (gain > 0.02) bluer += 1;
      most = Math.max(most, gain);
      redder = Math.max(redder, ball.values[i - 2]! - probes.values[i - 2]!);
    }
    expect(bluer).toBeGreaterThanOrEqual(4);
    expect(most).toBeGreaterThan(0.03);
    expect(redder).toBeLessThan(most);
  }, 60_000);
});
