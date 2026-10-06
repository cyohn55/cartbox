/**
 * Blend spaces and retargeting (ENGINE_PARITY_ROADMAP.md EP17b): 1D and 2D
 * blend weights, the state machine's second blend parameter, the runtime
 * playing a 2D blend (each clip exactly at its point), copying clips between
 * skeletons by joint name, and Lockout's soldiers moving on a 2D blend.
 */

import { describe, expect, it } from "vitest";

import {
  LOCKOUT_CODE,
  LOCKOUT_SOLDIER_ANIMATOR,
  blendWeights,
  jointKey,
  lockoutMeshSidecar,
  matchJoints,
  readAnimatorSpec,
  retargetClip,
  sampleClip,
  type AnimationClip,
  type MeshSkin,
  type SkinJoint,
} from "@cartbox/editor";
import { AnimationSession, parseMeshScene } from "@cartbox/player";

const CROSS = [
  { at: 0, at2: 0 },
  { at: 1, at2: 0 },
  { at: -1, at2: 0 },
  { at: 0, at2: 1 },
  { at: 0, at2: -1 },
];

describe("blend weights", () => {
  it("1D: linear between neighbours (in any order), the end clip alone past an end", () => {
    const pts = [{ at: 2 }, { at: 0 }, { at: 1 }];
    expect(blendWeights(pts, 0.25)).toEqual([0, 0.75, 0.25]);
    expect(blendWeights(pts, 1.5)).toEqual([0.5, 0, 0.5]);
    expect(blendWeights(pts, -3)).toEqual([0, 1, 0]);
    expect(blendWeights(pts, 9)).toEqual([1, 0, 0]);
    expect(blendWeights([{ at: 5 }], 0)).toEqual([1]);
  });

  it("2D: each clip alone at its own point, an even mix between two, always summing to 1, the nearest far outside", () => {
    CROSS.forEach((p, i) => {
      const w = blendWeights(CROSS, p.at, p.at2);
      expect(w[i]).toBeCloseTo(1, 6);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    });
    const mid = blendWeights(CROSS, 0.5, 0);
    expect(mid[0]).toBeCloseTo(0.5, 6);
    expect(mid[1]).toBeCloseTo(0.5, 6);
    const diag = blendWeights(CROSS, 0.4, 0.4);
    expect(diag[1]).toBeCloseTo(diag[3]!, 6); // symmetric
    for (const [x, y] of [[0.3, -0.7], [0.9, 0.9], [-0.2, 0.1]]) expect(blendWeights(CROSS, x!, y!).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    const far = blendWeights(CROSS, 9, 0);
    expect(far[1]).toBeCloseTo(1, 3);
  });
});

describe("state machine", () => {
  it("reads a second blend parameter (a blend space) only when it's another number parameter", () => {
    const spec = (param2: string) =>
      readAnimatorSpec({
        params: [{ name: "x", kind: "number" }, { name: "y", kind: "number" }, { name: "b", kind: "bool" }],
        states: [{ name: "move", blend: { param: "x", param2, points: [{ clip: "a", at: 0, at2: 1 }, { clip: "c", at: 1 }] } }],
      })!.states[0]!.blend!;
    expect(spec("y")).toEqual({ param: "x", param2: "y", points: [{ clip: "a", at: 0, at2: 1 }, { clip: "c", at: 1, at2: 0 }] });
    expect(spec("b")).toEqual({ param: "x", points: [{ clip: "a", at: 0 }, { clip: "c", at: 1 }] });
    expect(spec("x").param2).toBeUndefined();
  });
});

describe("a 2D blend at run time (Lockout's soldier)", () => {
  it("plays each clip exactly at its point and mixes between", () => {
    const scene = parseMeshScene(lockoutMeshSidecar())!;
    const bot = scene.instances[1]!;
    const skin = bot.mesh.skin!;
    const clip = (name: string) => bot.mesh.clips!.find((c) => c.name === name)!;
    const session = new AnimationSession(scene);
    const params = LOCKOUT_SOLDIER_ANIMATOR.params.map((p) => p.name as string);
    const pose = (speed: number, side: number) => {
      session.setParam(1, params.indexOf("speed"), speed);
      session.setParam(1, params.indexOf("side"), side);
      session.step(0);
      session.invalidate();
      session.matrices();
      return session.finalPose(1)!;
    };
    // Fresh playback is at phase 0: every clip at its first frame.
    const close = (a: Float32Array, b: Float32Array) => a.every((v, k) => Math.abs(v - b[k]!) < 1e-4);
    expect(close(pose(0, 1), sampleClip(skin, clip("strafeR"), 0))).toBe(true);
    expect(close(pose(-1, 0), sampleClip(skin, clip("back"), 0))).toBe(true);
    const between = pose(0, 0.5);
    expect(close(between, sampleClip(skin, clip("strafeR"), 0))).toBe(false);
    expect(close(between, sampleClip(skin, clip("idle"), 0))).toBe(false);
  });
});

const joint = (name: string, parent: number, t: [number, number, number], r: [number, number, number, number] = [0, 0, 0, 1]): SkinJoint => ({ name, parent, translation: t, rotation: r, scale: [1, 1, 1] });
const skinOf = (joints: SkinJoint[]): MeshSkin => ({ joints, inverseBind: new Float32Array(joints.length * 16) });
const S = Math.SQRT1_2;

describe("retargeting", () => {
  it("matches joints by name, ignoring case, rig prefixes and separators", () => {
    expect(jointKey("mixamorig:LeftUpLeg")).toBe("leftupleg");
    expect(jointKey("Armature|Left_Up.Leg")).toBe("leftupleg");
    expect(jointKey("Bip01 Spine")).toBe("spine");
    const a = [joint("mixamorig:Hips", -1, [0, 1, 0]), joint("mixamorig:Spine", 0, [0, 0.2, 0]), joint("Tail", 0, [0, 0, -0.3])];
    const b = [joint("hips", -1, [0, 2, 0]), joint("SPINE", 0, [0, 0.4, 0])];
    expect(matchJoints(a, b)).toEqual([0, 1, -1]);
  });

  it("carries rotations relative to each rest pose, scales the root's travel by height, and drops the rest", () => {
    // Source: hips at 1 m, spine resting unrotated. Target: twice as tall, its spine resting turned 90° about Y.
    const source = skinOf([joint("Hips", -1, [0, 1, 0]), joint("Spine", 0, [0, 0.5, 0]), joint("Tail", 0, [0, 0, -0.3])]);
    const target = skinOf([joint("hips", -1, [0, 2, 0]), joint("spine", 0, [0, 1, 0], [0, S, 0, S])]);
    const clip: AnimationClip = {
      name: "hop",
      duration: 1,
      channels: [
        { joint: 0, path: "translation", interpolation: "linear", times: Float32Array.from([0, 1]), values: Float32Array.from([0, 1, 0, 0.5, 1.2, 0]) },
        { joint: 1, path: "rotation", interpolation: "linear", times: Float32Array.from([0, 1]), values: Float32Array.from([0, 0, 0, 1, S, 0, 0, S]) },
        { joint: 1, path: "translation", interpolation: "linear", times: Float32Array.from([0, 1]), values: Float32Array.from([0, 0.5, 0, 0, 0.6, 0]) },
        { joint: 2, path: "rotation", interpolation: "linear", times: Float32Array.from([0]), values: Float32Array.from([0, 0, 0, 1]) },
      ],
    };
    const out = retargetClip(clip, source, target, "hop2")!;
    expect(out.name).toBe("hop2");
    expect(out.channels.map((c) => `${c.joint}:${c.path}`)).toEqual(["0:translation", "1:rotation"]);
    // Root travel doubled (target is twice as tall), from the target's own rest.
    expect(Array.from(out.channels[0]!.values).map((v) => Math.round(v * 100) / 100)).toEqual([0, 2, 0, 1, 2.4, 0]);
    // At rest in the source → at rest in the target; the source's 90° pitch lands on top of the target's rest turn.
    const rot = Array.from(out.channels[1]!.values).map((v) => Math.round(v * 1000) / 1000);
    expect(rot.slice(0, 4)).toEqual([0, 0.707, 0, 0.707]);
    expect(Math.hypot(...rot.slice(4, 8))).toBeCloseTo(1, 3);
    expect(rot.slice(4, 8)).not.toEqual(rot.slice(0, 4));
    expect(retargetClip(clip, source, skinOf([joint("wing", -1, [0, 0, 0])]))).toBeNull();
  });
});

describe("Lockout", () => {
  it("moves its soldiers on a 2D blend space: run, back-pedal and a strafe to each side, fed forward and sideways speed", () => {
    const blend = LOCKOUT_SOLDIER_ANIMATOR.states[0].blend;
    expect(blend.param2).toBe("side");
    expect(blend.points.map((p) => p.clip)).toEqual(["idle", "run", "back", "strafeR", "strafeL"]);
    expect(LOCKOUT_CODE).toContain('cartbox.set(i, "side", side)');
  });
});
