/**
 * Animation quality (AAA_FIDELITY_ROADMAP.md F7e): root motion, motion
 * matching over a pose database, foot placement and FABRIK, powered ragdolls,
 * and clip compression, on a small procedural biped.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOLERANCE,
  MotionMatcher,
  PoweredRagdoll,
  buildMatchDatabase,
  clipBytes,
  desiredTrajectory,
  inPlace,
  jointPosition,
  jointWorldMatrices,
  matchSetupFor,
  packClip,
  packQuat,
  placeFeet,
  reduceChannel,
  reduceClip,
  restPose,
  rootMotion,
  sampleClip,
  solveFabrik,
  unpackClip,
  unpackQuat,
  type AnimationClip,
  type ClipChannel,
  type MeshAsset,
  type MeshScene,
  type MeshSkin,
} from "@cartbox/editor";
import { AnimationSession } from "@cartbox/player";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A biped: root on the ground, hips at 0.9 m, each leg thigh → knee → ankle (0.45 + 0.4 m), the ankle 5 cm up. */
function biped(): MeshSkin {
  const joint = (name: string, parent: number, translation: [number, number, number]) => ({ name, parent, translation, rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] });
  const joints = [
    joint("root", -1, [0, 0, 0]),
    joint("hips", 0, [0, 0.9, 0]),
    joint("thigh_l", 1, [0.1, 0, 0]),
    joint("knee_l", 2, [0, -0.45, 0]),
    joint("foot_l", 3, [0, -0.4, 0]),
    joint("thigh_r", 1, [-0.1, 0, 0]),
    joint("knee_r", 5, [0, -0.45, 0]),
    joint("foot_r", 6, [0, -0.4, 0]),
  ];
  return { joints, inverseBind: Float32Array.from(joints.flatMap(() => IDENTITY)) };
}

const keys = (n: number, duration: number) => Float32Array.from({ length: n + 1 }, (_, i) => (i / n) * duration);
const aboutX = (a: number) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
const aboutY = (a: number) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];

/** Walk forward at 1.4 m/s swinging the legs, idle in place, or turn left a quarter turn a second (for two). */
function clips(): AnimationClip[] {
  const t = keys(30, 1);
  const swing = (side: number): ClipChannel => ({ joint: side, path: "rotation", interpolation: "linear", times: t, values: Float32Array.from([...t].flatMap((s) => aboutX((side === 2 ? 1 : -1) * 0.4 * Math.sin(2 * Math.PI * s)))) });
  const walk: AnimationClip = {
    name: "walk",
    duration: 1,
    channels: [{ joint: 0, path: "translation", interpolation: "linear", times: t, values: Float32Array.from([...t].flatMap((s) => [0, 0, 1.4 * s])) }, swing(2), swing(5)],
  };
  const idle: AnimationClip = { name: "idle", duration: 1, channels: [{ joint: 0, path: "translation", interpolation: "linear", times: t, values: new Float32Array(t.length * 3) }] };
  const t2 = keys(60, 2);
  const turn: AnimationClip = { name: "turn", duration: 2, channels: [{ joint: 0, path: "rotation", interpolation: "linear", times: t2, values: Float32Array.from([...t2].flatMap((s) => aboutY((Math.PI / 2) * s))) }] };
  return [walk, idle, turn];
}

describe("root motion", () => {
  it("reads how far and how far round the root went", () => {
    const skin = biped();
    const [walk, , turn] = clips();
    const half = rootMotion(skin, walk!, 0, 0.5);
    expect(half.dz).toBeCloseTo(0.7, 4);
    expect(half.dx).toBeCloseTo(0, 6);
    expect(rootMotion(skin, turn!, 0, 1).turn).toBeCloseTo(Math.PI / 2, 4);
    const pose = sampleClip(skin, walk!, 0.5, false);
    inPlace(pose);
    expect(jointPosition(skin, pose, 1)).toEqual([0, 0.9, 0].map((v) => expect.closeTo(v, 6)));
  });
});

describe("motion matching", () => {
  const skin = biped();
  const all = clips();
  const setup = matchSetupFor(skin)!;

  it("finds the feet and the hips by name", () => {
    expect(setup).toEqual({ root: 0, hips: 1, feet: [4, 7] });
  });

  it("asks for a trajectory that eases toward the velocity and facing wanted", () => {
    // From rest the spring hasn't reached the speed asked in a second; already at it, the root goes 1.4 m.
    const traj = desiredTrajectory([0, 1.4], 0);
    expect(traj[0]!.z).toBeGreaterThan(0);
    expect(traj[2]!.z).toBeGreaterThan(traj[1]!.z);
    expect(traj[2]!.z).toBeLessThan(1.4);
    expect(traj[2]!.z).toBeGreaterThan(0.5);
    expect(desiredTrajectory([0, 1.4], 0, undefined, [0, 1.4])[2]!.z).toBeCloseTo(1.4, 6);
    const turning = desiredTrajectory([0, 0], Math.PI / 2);
    expect(Math.atan2(turning[2]!.dx, turning[2]!.dz)).toBeGreaterThan(1.2);
  });

  it("picks the clip whose motion matches what the player asks, and stays on it", () => {
    const db = buildMatchDatabase(skin, all, setup, [true, true, false]);
    expect(db.size).toBe(2 * 6 + 3 + 3 * 4);
    const matcher = new MotionMatcher(skin, all, db, [true, true, false]);
    const run = (velocity: [number, number], facing: number) => {
      // A character already moving as asked.
      for (let i = 0; i < 30; i += 1) matcher.update(1 / 30, desiredTrajectory(velocity, facing, undefined, velocity));
      return all[matcher.clip]!.name;
    };
    expect(run([0, 1.4], 0)).toBe("walk");
    const jumps = matcher.jumps;
    // Asked the same, it keeps walking: no more jumps.
    run([0, 1.4], 0);
    expect(matcher.jumps).toBe(jumps);
    expect(run([0, 0], 0)).toBe("idle");
    expect(run([0, 0], Math.PI / 2)).toBe("turn");
  });

  it("drives an object's playback in the animation session", () => {
    // One triangle bound to the root, so the session animates it.
    const primitive = { positions: new Float32Array(9), normals: null, uvs: new Float32Array(6), indices: Uint32Array.from([0, 1, 2]), joints: new Uint16Array(12), weights: Float32Array.from({ length: 12 }, (_, i) => (i % 4 === 0 ? 1 : 0)), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } };
    const mesh = { name: "biped", primitives: [primitive], skin, clips: all } as unknown as MeshAsset;
    const session = new AnimationSession({ instances: [{ mesh, model: new Float32Array(16) }] } as unknown as MeshScene);
    for (let i = 0; i < 20; i += 1) {
      session.matchMotion(0, [0, 1.4], 0);
      session.step(1 / 30);
    }
    expect(session.currentClip(0)).toBe(0);
    // Root motion over the last step: the walk's 1.4 m/s.
    expect(session.rootMotion(0)!.dz).toBeCloseTo(1.4 / 30, 3);
  });
});

describe("foot placement and FABRIK", () => {
  it("drops the pelvis to the lower foot's ground and puts each foot on its own", () => {
    const skin = biped();
    const pose = restPose(skin);
    // Ground 10 cm lower under the left foot.
    const ground = (x: number) => ({ height: x > 0 ? -0.1 : 0, normal: [0, 1, 0] as [number, number, number] });
    const legs = [
      { foot: 4, ankleHeight: 0.05 },
      { foot: 7, ankleHeight: 0.05 },
    ];
    const result = placeFeet(skin, pose, 1, legs, ground);
    expect(result.pelvisDrop).toBeCloseTo(0.1, 6);
    expect(jointPosition(skin, pose, 1)[1]).toBeCloseTo(0.8, 6);
    expect(jointPosition(skin, pose, 4)[1]).toBeCloseTo(-0.05, 4);
    expect(jointPosition(skin, pose, 7)[1]).toBeCloseTo(0.05, 4);
  });

  it("lays a foot along a slope", () => {
    const skin = biped();
    const pose = restPose(skin);
    const n: [number, number, number] = [0, Math.cos(0.3), -Math.sin(0.3)];
    placeFeet(skin, pose, 1, [{ foot: 4, ankleHeight: 0.05 }], () => ({ height: 0, normal: n }));
    const world = jointWorldMatrices(skin, pose);
    const up = [world[4 * 16 + 4]!, world[4 * 16 + 5]!, world[4 * 16 + 6]!];
    expect(up[0]! * n[0] + up[1]! * n[1] + up[2]! * n[2]).toBeCloseTo(1, 4);
  });

  it("reaches with a long chain, and points straight at what it can't reach", () => {
    const skin = biped();
    const pose = restPose(skin);
    const chain = [1, 2, 3, 4];
    expect(solveFabrik(skin, pose, chain, [0.5, 0.6, 0.3])).toBeLessThan(1e-3);
    const far = restPose(skin);
    const left = solveFabrik(skin, far, chain, [5, 0.9, 0]);
    expect(left).toBeGreaterThan(3);
    // Straight: the ankle on the line from the hips toward the target.
    expect(jointPosition(skin, far, 4)[1]).toBeCloseTo(0.9, 3);
  });
});

describe("powered ragdolls", () => {
  it("follows the animation at full power, staggers when hit, and recovers", () => {
    const skin = biped();
    const world = Float32Array.from(IDENTITY) as unknown as number[];
    const floor = [{ center: [0, -0.5, 0] as [number, number, number], half: [10, 0.5, 10] as [number, number, number] }];
    const body = new PoweredRagdoll(skin, restPose(skin), world, { power: 1, stiffness: 1, recover: 0.5 });
    const shown = (pose: Float32Array) => jointPosition(skin, pose, 4);
    let pose = restPose(skin);
    for (let i = 0; i < 10; i += 1) {
      pose = restPose(skin);
      body.update(1 / 60, pose, world, floor);
    }
    expect(Math.hypot(...shown(pose).map((v, k) => v - jointPosition(skin, restPose(skin), 4)[k]!))).toBeLessThan(0.02);
    body.hit(0, [3, 0, 0]);
    expect(body.power).toBe(0);
    let worst = 0;
    for (let i = 0; i < 15; i += 1) {
      pose = restPose(skin);
      body.update(1 / 60, pose, world, floor);
      worst = Math.max(worst, Math.abs(jointPosition(skin, pose, 1)[0]));
    }
    // Shoved sideways while weak.
    expect(worst).toBeGreaterThan(0.02);
    for (let i = 0; i < 60; i += 1) {
      pose = restPose(skin);
      body.update(1 / 60, pose, world, floor);
    }
    expect(body.recovered).toBe(true);
    expect(Math.abs(jointPosition(skin, pose, 1)[0])).toBeLessThan(0.01);
  });
});

describe("clip compression", () => {
  it("drops the keys interpolation rebuilds", () => {
    // A straight line with one corner: the three keys that matter stay.
    const channel: ClipChannel = { joint: 0, path: "translation", interpolation: "linear", times: keys(10, 1), values: Float32Array.from([...keys(10, 1)].flatMap((s) => [s < 0.5 ? s : 1 - s, 0, 0])) };
    const reduced = reduceChannel(channel, 1e-4);
    expect([...reduced.times].map((t) => Math.round(t * 10) / 10)).toEqual([0, 0.5, 1]);
  });

  it("packs rotations in 48 bits within two ten-thousandths of a radian", () => {
    for (const q of [aboutX(0.3), aboutY(-2.9), [0.5, -0.5, 0.5, 0.5], [0, 0, -1, 0]]) {
      const back = unpackQuat(packQuat(q));
      const d = Math.abs(q[0]! * back[0] + q[1]! * back[1] + q[2]! * back[2] + q[3]! * back[3]);
      expect(2 * Math.acos(Math.min(1, d))).toBeLessThan(2e-4);
    }
  });

  it("makes a walk several times smaller, its poses within the budget", () => {
    const skin = biped();
    const walk = clips()[0]!;
    const reduced = reduceClip(walk);
    const packed = packClip(reduced);
    expect(clipBytes(walk) / packed.byteLength).toBeGreaterThan(3);
    const back = unpackClip(packed, "walk");
    for (let t = 0; t <= 1; t += 0.05) {
      const a = sampleClip(skin, walk, t, false);
      const b = sampleClip(skin, back, t, false);
      for (const j of [0, 1, 4, 7]) {
        const pa = jointPosition(skin, a, j);
        const pb = jointPosition(skin, b, j);
        // The rotation budget along a 0.85 m leg, plus the translation's.
        expect(Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2])).toBeLessThan(DEFAULT_TOLERANCE.rotation * 0.85 + DEFAULT_TOLERANCE.translation + 1e-4);
      }
    }
  });
});
