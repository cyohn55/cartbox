/**
 * Rigging and keyframes (LOCKOUT_MULTIPLAYER_ROADMAP.md L16): the skeleton
 * drawn over the mesh and picked by its bones; pose mode turning bones about
 * the world's axes or their own; weight painting (add, subtract, smooth,
 * normalise) that leaves every vertex's weights summing to 1, with a heat
 * map to see them; and a dope sheet keying bones on a clip with the
 * timeline's eases. On Lockout's Spartan: its run tuned and a new taunt
 * keyed, each playing through the animator the cart runs — the taunt exactly
 * as the same clip does when it comes back from a GLB as an imported one.
 */

import { describe, expect, it } from "vitest";
import {
  bakeJoint,
  deleteBoneKey,
  deserializeMeshAsset,
  dopeSheetRows,
  easeCurve,
  encodeGlb,
  jointKeys,
  jointOrigins,
  jointPose,
  jointWeights,
  jointWorldMatrices,
  keyBone,
  keyPose,
  lockoutMeshSidecar,
  meshClosure,
  moveBoneKey,
  newClip,
  normaliseWeights,
  orbitView,
  paintWeights,
  parseGlb,
  pickJoint,
  posedJoints,
  primitiveTopology,
  projectPoint,
  quatAngle,
  quatAxisAngle,
  quatFromEuler,
  quatFromMatrix,
  quatMultiply,
  quatToEuler,
  restPose,
  rotateJoint,
  sampleClip,
  sampleJoint,
  serializeMeshAsset,
  setBoneKeyEase,
  skeletonSegments,
  skinMatrices,
  skinVertices,
  weightError,
  weightHeat,
  type MeshAsset,
  type PoseKey,
} from "@cartbox/editor";
import { AnimationSession, parseMeshScene } from "@cartbox/player";

import { decodeMeshSidecar, encodeMeshSidecar, type MeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { replaceModel } from "../apps/web/src/lib/meshReplace";

const base: MeshSidecar = decodeMeshSidecar(lockoutMeshSidecar());
const soldier: MeshAsset = deserializeMeshAsset(base.meshes.find((m) => m.id === "bot-1")!.mesh);
const skin = soldier.skin!;
const J = (name: string) => skin.joints.findIndex((j) => j.name === name);
const clipIndex = (mesh: MeshAsset, name: string) => (mesh.clips ?? []).findIndex((c) => c.name === name);

/** Every primitive's every vertex: weights summing to 1, and each weld's copies agreeing. */
function expectWeightsSound(mesh: MeshAsset) {
  for (const p of mesh.primitives) {
    expect(weightError(p)).toBeLessThan(1e-6);
    const topo = primitiveTopology(p);
    for (const vs of topo.weldVertices) {
      const first = Array.from(p.weights!.subarray(vs[0]! * 4, vs[0]! * 4 + 4));
      for (const v of vs) expect(Array.from(p.weights!.subarray(v * 4, v * 4 + 4))).toEqual(first);
    }
  }
}

describe("the skeleton over the mesh, and pose mode", () => {
  it("draws a bone from each joint to its children, and picks a bone by its joint or its line", () => {
    const pose = restPose(skin);
    const bones = skeletonSegments(skin, pose);
    expect(bones).toHaveLength(skin.joints.filter((j) => j.parent >= 0).length);
    const at = jointOrigins(skin, pose);
    expect(at[J("head")]![1]).toBeGreaterThan(1.5);
    expect(at[J("foot_l")]![1]).toBeLessThan(0.2);
    const viewProj = orbitView({ min: [-0.5, 0, -0.5], max: [0.5, 1.9, 0.5] }, { yaw: 0.3, pitch: 0.1 }).viewProj;
    const head = projectPoint(viewProj, at[J("head")]!)!;
    expect(pickJoint(skin, pose, viewProj, [head[0], head[1]])).toBe(J("head"));
    // Halfway along the shin's line (knee to ankle): the shin, which swings it.
    const knee = projectPoint(viewProj, at[J("shin_l")]!)!, ankle = projectPoint(viewProj, at[J("foot_l")]!)!;
    expect(pickJoint(skin, pose, viewProj, [(knee[0] + ankle[0]) / 2, (knee[1] + ankle[1]) / 2], 0.02)).toBe(J("shin_l"));
    expect(pickJoint(skin, pose, viewProj, [0.99, 0.99])).toBeNull();
  });

  it("turns a bone about a world axis, swinging what hangs from it and nothing else", () => {
    const pose = restPose(skin);
    const fore = J("forearm_r"), arm = J("upperarm_r");
    // Raise the whole arm a quarter turn about the world's forward axis, then turn the forearm about up.
    const raised = rotateJoint(skin, pose, arm, [0, 0, 1], Math.PI / 2);
    const at0 = jointOrigins(skin, pose), at1 = jointOrigins(skin, raised);
    const d0 = at0[fore]!.map((v, k) => v - at0[arm]![k]!), d1 = at1[fore]!.map((v, k) => v - at1[arm]![k]!);
    // (x, y) → (−y, x): a quarter turn about +z.
    expect(d1[0]).toBeCloseTo(-d0[1]!, 5);
    expect(d1[1]).toBeCloseTo(d0[0]!, 5);
    expect(at1[J("head")]).toEqual(at0[J("head")]);
    const twisted = rotateJoint(skin, raised, fore, [0, 1, 0], 0.4);
    const world = jointWorldMatrices(skin, twisted), before = jointWorldMatrices(skin, raised);
    const turn = quatMultiply(quatFromMatrix(world, fore * 16), [...quatFromMatrix(before, fore * 16).slice(0, 3).map((v) => -v), quatFromMatrix(before, fore * 16)[3]]);
    expect(quatAngle(turn, quatAxisAngle([0, 1, 0], 0.4))).toBeLessThan(1e-5);
    // About its own axis: the local rotation is turned on the right.
    const local = rotateJoint(skin, pose, fore, [1, 0, 0], 0.3, "local");
    expect(quatAngle(jointPose(local, fore).rotation, quatAxisAngle([1, 0, 0], 0.3))).toBeLessThan(1e-6);
    // The panel's angles round-trip.
    const q = quatFromEuler([0.3, -0.5, 1.1]);
    expect(quatToEuler(q).map((v) => +v.toFixed(6))).toEqual([0.3, -0.5, 1.1]);
  });
});

describe("weight painting", () => {
  const head = J("head"), chest = J("chest");
  const neck = jointOrigins(skin, restPose(skin))[head]!;

  it("adds a bone's weight under the brush, fading to its edge, and every vertex still sums to 1", () => {
    const painted = paintWeights(soldier, head, { center: neck, radius: 0.15, strength: 0.6, mode: "add" });
    expectWeightsSound(painted);
    // The neck (an undersuit block on the chest) now leans on the head; far away, nothing changed.
    const suit = soldier.primitives.findIndex((p) => p.material.name === "undersuit");
    const before = jointWeights(soldier.primitives[suit]!, head), after = jointWeights(painted.primitives[suit]!, head);
    let gained = 0;
    const p = painted.primitives[suit]!;
    for (let v = 0; v < before.length; v += 1) {
      const d = Math.hypot(p.positions[v * 3]! - neck[0], p.positions[v * 3 + 1]! - neck[1], p.positions[v * 3 + 2]! - neck[2]);
      if (d >= 0.15) expect(after[v]).toBe(before[v]);
      else if (after[v]! > before[v]! + 1e-6) gained += 1;
    }
    expect(gained).toBeGreaterThan(0);
    // Painting a bone onto a vertex never takes it past four bones.
    let more = painted;
    for (const j of [J("spine"), J("upperarm_l"), J("upperarm_r"), J("hips")]) more = paintWeights(more, j, { center: neck, radius: 0.2, strength: 0.3, mode: "add" });
    expectWeightsSound(more);
  });

  it("subtracts, smooths and normalises, still summing to 1; a bone taken off a vertex it carried alone hands it to its parent", () => {
    // On the crown of the helmet, which the head carries alone: what it gives up goes to its parent, the chest.
    expect(skin.joints[head]!.parent).toBe(chest);
    const crown: [number, number, number] = [0, 1.805, 0];
    const off = paintWeights(soldier, head, { center: crown, radius: 0.3, strength: 1, mode: "subtract" });
    expectWeightsSound(off);
    const armor = soldier.primitives.findIndex((p) => p.material.name === "armor");
    const a = off.primitives[armor]!, was = soldier.primitives[armor]!;
    let handed = 0;
    for (let v = 0; v < a.positions.length / 3; v += 1) {
      if (was.joints![v * 4] !== head) continue;
      const d = Math.hypot(a.positions[v * 3]! - crown[0], a.positions[v * 3 + 1]! - crown[1], a.positions[v * 3 + 2]! - crown[2]);
      if (d >= 0.3) continue;
      const x = 1 - d / 0.3, touched = x * x * (3 - 2 * x);
      expect(jointWeights(a, head)[v]).toBeCloseTo(1 - touched, 5);
      expect(jointWeights(a, chest)[v]).toBeCloseTo(touched, 5);
      handed += 1;
    }
    expect(handed).toBeGreaterThan(20);
    // Smoothing a shoulder blends the arm and chest across the seam.
    const shoulder = jointOrigins(skin, restPose(skin))[J("upperarm_l")]!;
    const blended = paintWeights(paintWeights(soldier, chest, { center: shoulder, radius: 0.12, strength: 0.5, mode: "add" }), chest, { center: shoulder, radius: 0.12, strength: 1, mode: "smooth" });
    expectWeightsSound(blended);
    // Loose imported weights (summing to 1.6, and a sliver) normalise.
    const loose: MeshAsset = { ...soldier, primitives: soldier.primitives.map((p) => ({ ...p, weights: p.weights!.map((w, k) => (k % 4 === 0 ? w * 1.6 : k % 4 === 1 ? 0.001 : 0)) })) };
    expect(weightError(loose.primitives[0]!)).toBeGreaterThan(0.5);
    const fixed = normaliseWeights(loose);
    expectWeightsSound(fixed);
    expect(jointWeights(fixed.primitives[0]!, soldier.primitives[0]!.joints![0]!)[0]).toBeCloseTo(1, 6);
    const brushed = paintWeights(loose, head, { center: neck, radius: 0.3, strength: 1, mode: "normalise" });
    // Only what the brush touched is normalised: the feet are still loose.
    expect(brushed.primitives.some((p) => weightError(p) > 0.5)).toBe(true);
    expect(weightError(brushed.primitives[soldier.primitives.findIndex((p) => p.material.name === "visor")]!)).toBeLessThan(1e-6);
  });

  it("shows weights as a heat map, blue for none through green to red for all", () => {
    expect(weightHeat(0)).toEqual([24, 40, 220]);
    expect(weightHeat(0.5)).toEqual([40, 210, 60]);
    expect(weightHeat(1)).toEqual([230, 40, 30]);
    expect(weightHeat(2)).toEqual(weightHeat(1));
  });

  it("leaves a painted Spartan closed and every clip playing", () => {
    const painted = paintWeights(soldier, head, { center: neck, radius: 0.15, strength: 0.6, mode: "add" });
    for (const p of painted.primitives) expect(meshClosure(p).closed).toBe(true);
    for (const clip of painted.clips!) {
      const m = skinMatrices(skin, sampleClip(skin, clip, clip.duration * 0.37));
      for (const p of painted.primitives) {
        const out = new Float32Array(p.positions.length);
        skinVertices(p.joints!, p.weights!, m, p.positions, null, out, null);
        expect(out.every(Number.isFinite)).toBe(true);
      }
    }
  });
});

describe("the dope sheet", () => {
  const key = (time: number, ease: PoseKey["ease"], angle: number, curve?: PoseKey["curve"]): PoseKey => ({
    time,
    ease,
    ...(curve ? { curve } : {}),
    translation: [...skin.joints[J("chest")]!.translation],
    rotation: quatAxisAngle([0, 1, 0], angle),
    scale: [1, 1, 1],
  });
  const angleAt = (channels: ReturnType<typeof bakeJoint>, t: number) => {
    const clip = { name: "x", duration: 4, channels };
    return 2 * Math.asin(Math.min(1, Math.abs(sampleJoint(skin, clip, J("chest"), t).rotation[1])));
  };

  it("bakes each span by its ease: linear, smooth, stepped, or its own curve", () => {
    const chest = J("chest");
    const channels = bakeJoint(skin, chest, [key(0, "linear", 0), key(1, "smooth", 1), key(2, "step", 0), key(3, "curve", 1, [0.7, 0, 1, 0.3]), key(4, "linear", 0)]);
    expect(channels.map((c) => c.path)).toEqual(["rotation"]); // translation and scale stay at rest
    expect(angleAt(channels, 0.5)).toBeCloseTo(0.5, 2);
    // Smooth: a quarter of the way in time, smoothstep(¼) = 0.156 of the way in angle.
    expect(angleAt(channels, 1.25)).toBeCloseTo(1 - 0.15625, 2);
    expect(angleAt(channels, 1.5)).toBeCloseTo(0.5, 2);
    // Stepped: held, then a jump at the next key.
    expect(angleAt(channels, 2.9)).toBeCloseTo(0, 6);
    expect(angleAt(channels, 3)).toBeCloseTo(1, 5);
    // A curve: its Bézier at half time.
    expect(angleAt(channels, 3.5)).toBeCloseTo(1 - easeCurve([0.7, 0, 1, 0.3], 0.5), 2);
    // All stepped: a stepped channel of just the keys.
    const stepped = bakeJoint(skin, chest, [key(0, "step", 0), key(1, "step", 1)]);
    expect(stepped[0]!.interpolation).toBe("step");
    expect(stepped[0]!.times.length).toBe(2);
  });

  it("keys, moves, re-eases and deletes a bone's keys, showing keys rather than samples", () => {
    const { mesh: blank, index } = newClip(soldier, "taunt", 1.6);
    expect(index).toBe(soldier.clips!.length);
    const chest = J("chest");
    let mesh = keyBone(blank, index, chest, 0, { rotation: [0, 0, 0, 1] }, { ease: "smooth" });
    mesh = keyBone(mesh, index, chest, 0.8, { rotation: quatAxisAngle([0, 1, 0], 0.6) });
    mesh = keyBone(mesh, index, chest, 1.6, { rotation: [0, 0, 0, 1] });
    const row = () => dopeSheetRows(mesh, index)[chest]!;
    expect(row().authored).toBe(true);
    expect(row().keys.map((k) => [k.time, k.ease])).toEqual([[0, "smooth"], [0.8, "smooth"], [1.6, "smooth"]]);
    // Baked at 30 a second, but three keys on the sheet.
    expect(mesh.clips![index]!.channels.find((c) => c.joint === chest)!.times.length).toBeGreaterThan(40);
    mesh = setBoneKeyEase(mesh, index, chest, 0.8, "curve", [0.34, 1.56, 0.64, 1]);
    expect(row().keys[1]).toEqual({ time: 0.8, ease: "curve", curve: [0.34, 1.56, 0.64, 1] });
    mesh = moveBoneKey(mesh, index, chest, 0.8, 0.6);
    expect(row().keys.map((k) => k.time)).toEqual([0, 0.6, 1.6]);
    expect(quatAngle(jointKeys(mesh, index, chest)[1]!.rotation, quatAxisAngle([0, 1, 0], 0.6))).toBeLessThan(1e-6);
    mesh = deleteBoneKey(mesh, index, chest, 0.6);
    expect(row().keys.map((k) => k.time)).toEqual([0, 1.6]);
    // An imported clip's bone shows its channels' own keys.
    const run = clipIndex(soldier, "run");
    const runRow = dopeSheetRows(soldier, run)[J("thigh_l")]!;
    expect(runRow.authored).toBe(false);
    expect(runRow.keys.length).toBeGreaterThan(2);
    // The cart stores the keys with the clip.
    const back = deserializeMeshAsset(serializeMeshAsset(mesh));
    expect(back.clips![index]!.keys).toEqual(mesh.clips![index]!.keys);
    expect(dopeSheetRows(back, index)[chest]!.keys).toEqual(row().keys);
  });
});

/** Play one clip on bot 1 of a cart wearing `mesh`, and every tick's skinning matrices. */
function playthrough(mesh: MeshAsset, clip: number, seconds: number): Float32Array[] {
  const { sidecar } = replaceModel(base, "bot-1", mesh);
  const scene = parseMeshScene(encodeMeshSidecar(sidecar))!;
  const object = sidecar.meshes.findIndex((m) => m.id === "bot-1");
  const session = new AnimationSession(scene);
  session.play(object, clip, 0, 1, true);
  const out: Float32Array[] = [];
  for (let tick = 0; tick < Math.round(seconds * 60); tick += 1) {
    session.step(1 / 60);
    out.push(session.matrices().get(object)!.slice());
  }
  return out;
}

describe("Lockout: a Spartan's taunt keyed in the editor, and its run tuned", () => {
  /** A taunt: arm raised and pumped, chest turned, head nodding, with every ease. */
  function taunt(): { mesh: MeshAsset; index: number } {
    const { mesh: blank, index } = newClip(soldier, "taunt", 1.6);
    let mesh = blank;
    let pose = restPose(skin);
    mesh = keyPose(mesh, index, 0, pose, skin.joints.map((_, j) => j), { ease: "smooth" });
    pose = rotateJoint(skin, pose, J("upperarm_r"), [0, 0, 1], 2.2);
    pose = rotateJoint(skin, pose, J("forearm_r"), [0, 0, 1], 0.6);
    pose = rotateJoint(skin, pose, J("chest"), [0, 1, 0], -0.35);
    expect(posedJoints(skin, mesh.clips![index], 0.5, pose).sort()).toEqual([J("upperarm_r"), J("forearm_r"), J("chest")].sort());
    mesh = keyPose(mesh, index, 0.5, pose, posedJoints(skin, mesh.clips![index], 0.5, pose), { ease: "curve", curve: [0.34, 1.56, 0.64, 1] });
    mesh = keyBone(mesh, index, J("forearm_r"), 0.8, { rotation: quatMultiply(quatAxisAngle([0, 0, 1], -0.9), jointPose(pose, J("forearm_r")).rotation) }, { ease: "step" });
    mesh = keyBone(mesh, index, J("head"), 0.9, { rotation: quatAxisAngle([1, 0, 0], 0.4) }, { ease: "linear" });
    mesh = keyPose(mesh, index, 1.6, restPose(skin), [J("upperarm_r"), J("forearm_r"), J("chest"), J("head")], { ease: "smooth" });
    return { mesh, index };
  }

  it("plays a keyed taunt through the animator exactly as the same clip imported from a GLB", () => {
    const { mesh, index } = taunt();
    const clip = mesh.clips![index]!;
    expect(clip.name).toBe("taunt");
    expect(clip.duration).toBeCloseTo(1.6, 6);
    // Each key is the pose it was keyed with.
    const at = sampleJoint(skin, clip, J("head"), 0.9);
    expect(quatAngle(at.rotation, quatAxisAngle([1, 0, 0], 0.4))).toBeLessThan(1e-5);
    // Out to Blender and back: the clip comes back as an imported one, without the dope sheet's keys.
    const imported = parseGlb(encodeGlb(mesh));
    const importedClip = imported.clips![index]!;
    expect(importedClip.name).toBe("taunt");
    expect(importedClip.keys).toBeUndefined();
    const keyed = playthrough(mesh, index, 1.6);
    const reimported = playthrough(imported, index, 1.6);
    expect(keyed).toHaveLength(96);
    let worst = 0;
    keyed.forEach((m, t) => m.forEach((v, k) => (worst = Math.max(worst, Math.abs(v - reimported[t]![k]!)))));
    expect(worst).toBeLessThan(1e-5);
    // And it moves: the raised hand is well above the shoulder at the peak.
    const peak = keyed[Math.round(0.5 * 60) - 1]!;
    const handRest = jointOrigins(skin, restPose(skin))[J("forearm_r")]!;
    const handY = (m: Float32Array) => m[J("forearm_r") * 16 + 1]! * handRest[0] + m[J("forearm_r") * 16 + 5]! * handRest[1] + m[J("forearm_r") * 16 + 9]! * handRest[2] + m[J("forearm_r") * 16 + 13]!;
    expect(handY(peak) - handRest[1]).toBeGreaterThan(0.2);
  });

  it("tunes the run: a deeper lean keyed on the chest, the rest of the run as it was", () => {
    const run = clipIndex(soldier, "run");
    const chest = J("chest");
    const t = 21 / 60; // between two of its keys, on a tick
    const was = sampleJoint(skin, soldier.clips![run]!, chest, t);
    const lean = quatMultiply(quatAxisAngle([1, 0, 0], 0.15), was.rotation);
    const tuned = keyBone(soldier, run, chest, t, { rotation: lean });
    const before = soldier.clips![run]!, after = tuned.clips![run]!;
    // Only the chest's channels changed.
    for (const c of after.channels.filter((c) => c.joint !== chest)) expect(before.channels).toContain(c);
    expect(quatAngle(sampleJoint(skin, after, chest, t).rotation, lean)).toBeLessThan(1e-5);
    // Its other keys hold their poses.
    for (const k of jointKeys(soldier, run, chest)) {
      if (Math.abs(k.time - t) < 1e-3) continue;
      expect(quatAngle(sampleJoint(skin, after, chest, k.time).rotation, k.rotation)).toBeLessThan(1e-5);
    }
    // Through the animator: the chest leans 0.15 rad further at that moment, and every other joint is as before.
    const tick = Math.round(t * 60) - 1;
    const a = playthrough(soldier, run, 0.5)[tick]!, b = playthrough(tuned, run, 0.5)[tick]!;
    const rot = (m: Float32Array, j: number) => quatFromMatrix(m, j * 16);
    expect(quatAngle(rot(a, chest), rot(b, chest))).toBeCloseTo(0.15, 2);
    for (const j of [J("thigh_l"), J("shin_r"), J("hips"), J("foot_l")]) expect(quatAngle(rot(a, j), rot(b, j))).toBeLessThan(1e-6);
  });
});
