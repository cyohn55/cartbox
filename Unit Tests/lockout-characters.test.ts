/**
 * Lockout graphics pass 4 — characters & weapon. Covers the two runtime fixes it
 * needed (a pose's yaw really turns about Y; first-person views get a tight near
 * plane so the held weapon isn't clipped) and the cart content: team-painted
 * soldiers, and six 3D weapon viewmodels that share one pose slot by resting at
 * 1/1000 scale until the cart poses the one in hand.
 */

import { describe, expect, it } from "vitest";

import { LOCKOUT_CODE, LOCKOUT_VIEWMODELS, deserializeMeshAsset, lockoutMeshSidecar } from "@cartbox/editor";
import { buildOrbitCamera, parseMeshScene } from "@cartbox/player";
import { poseLocalMatrix } from "../packages/player/src/mesh/MeshOverlaySurface";

/** Apply a column-major 4x4 to a point. */
function apply(m: ArrayLike<number>, p: [number, number, number]): [number, number, number] {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

const pose = (yaw: number, pitch: number, roll = 0) => ({
  index: 1,
  hidden: false,
  position: [0, 0, 0] as [number, number, number],
  rotation: [yaw, pitch, roll] as [number, number, number],
  scale: 1,
});

describe("cartbox.meshpose rotation", () => {
  it("turns an object about Y for yaw, matching the cart's forward = (sin yaw, 0, cos yaw)", () => {
    const [x, y, z] = apply(poseLocalMatrix(pose(Math.PI / 2, 0)), [0, 0, 1]);
    expect(x).toBeCloseTo(1, 6);
    expect(y).toBeCloseTo(0, 6); // an upright figure stays upright (yaw used to tip it over)
    expect(z).toBeCloseTo(0, 6);
    // Its up axis is untouched by yaw.
    expect(apply(poseLocalMatrix(pose(1.2, 0)), [0, 1, 0])[1]).toBeCloseTo(1, 6);
  });

  it("pitches about X before yawing, so an aimed weapon follows the view", () => {
    // Pitch -0.5 then yaw 0: +Z tilts up by sin(0.5).
    const [, y] = apply(poseLocalMatrix(pose(0, -0.5)), [0, 0, 1]);
    expect(y).toBeCloseTo(Math.sin(0.5), 6);
  });
});

describe("first-person near plane", () => {
  const bounds = { center: [0, 0, 0] as [number, number, number], radius: 23, min: [-20, -12, -13], max: [20, 12, 13] };
  it("defaults to 5% of the scene radius, but honours an explicit near", () => {
    const orbit = buildOrbitCamera(bounds as never, 0, 0, 16 / 9, { distance: 0.5 });
    const fp = buildOrbitCamera(bounds as never, 0, 0, 16 / 9, { distance: 0.5, near: 0.05 });
    // projection[14] = 2*far*near/(near-far); |value| scales with near.
    const nearOf = (m: ArrayLike<number>) => m[14]! / (m[10]! - 1);
    expect(nearOf(orbit.projection)).toBeCloseTo(1.15, 2);
    expect(nearOf(fp.projection)).toBeCloseTo(0.05, 3);
  });
});

describe("the Lockout soldiers and weapons", () => {
  const sidecar = JSON.parse(lockoutMeshSidecar()) as {
    meshes: { id: string; mesh: string; transform: { scale: number[] } }[];
  };

  it("orders instances as map, 7 bots, then one viewmodel per weapon", () => {
    const ids = sidecar.meshes.map((m) => m.id);
    expect(ids[0]).toBe("lockout-map");
    expect(ids.slice(1, 8)).toEqual([1, 2, 3, 4, 5, 6, 7].map((i) => `bot-${i}`));
    expect(ids.slice(8)).toEqual(LOCKOUT_VIEWMODELS.map((w) => `viewmodel-${w}`));
    expect(parseMeshScene(lockoutMeshSidecar())!.instances).toHaveLength(14);
  });

  it("paints bots 1-3 blue and 4-7 red, matching the cart's team split", () => {
    const paint = (i: number) =>
      deserializeMeshAsset(sidecar.meshes[i]!.mesh).primitives.find((p) => p.material.name === "armor")!.material.baseColorFactor;
    for (const i of [1, 2, 3]) expect(paint(i)[2]).toBeGreaterThan(paint(i)[0]); // blue
    for (const i of [4, 5, 6, 7]) expect(paint(i)[0]).toBeGreaterThan(paint(i)[2]); // red
    expect(LOCKOUT_CODE).toContain('team=(i<=3) and "blue" or "red"');
  });

  it("builds soldiers facing +Z, with the visor at the eye height the camera uses", () => {
    const soldier = deserializeMeshAsset(sidecar.meshes[1]!.mesh);
    const visor = soldier.primitives.find((p) => p.material.name === "visor")!;
    let minZ = Infinity;
    let maxY = 0;
    for (let i = 0; i < visor.positions.length; i += 3) {
      minZ = Math.min(minZ, visor.positions[i + 2]!);
      maxY = Math.max(maxY, visor.positions[i + 1]!);
    }
    expect(minZ).toBeGreaterThan(0); // the face is on the +Z side
    expect(maxY).toBeGreaterThan(1.6);
    expect(maxY).toBeLessThan(1.9);
  });

  it("rests every viewmodel at 1/1000 scale and poses the one in hand at the matching index", () => {
    for (const m of sidecar.meshes.slice(8)) expect(m.transform.scale).toEqual([0.001, 0.001, 0.001]);
    // The cart's index table must agree with the sidecar order (8..13).
    LOCKOUT_VIEWMODELS.forEach((w, k) => expect(LOCKOUT_CODE).toMatch(new RegExp(`${w}=${8 + k}\\b`)));
    expect(LOCKOUT_CODE).toContain("local WS = 1000");
    expect(LOCKOUT_CODE).toContain("pose_viewmodel(cur_id)");
    // Every weapon has hands on it except where it's one-handed, and the sword glows.
    const sword = deserializeMeshAsset(sidecar.meshes[8 + LOCKOUT_VIEWMODELS.indexOf("sword")]!.mesh);
    expect(sword.primitives.find((p) => p.material.name === "glow")?.material.emissiveFactor?.[2]).toBeGreaterThan(1);
  });
});
