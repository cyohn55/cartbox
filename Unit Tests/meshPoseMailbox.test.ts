/**
 * Unit tests for the per-instance mesh-pose mailbox sub-protocol
 * (`decodeMeshPoses`): the count-headed block a cart fills via
 * `cartbox.meshpose(...)` to move/rotate/scale individual meshes. Guards the
 * count header, the fixed-point round-trip, the hidden flag, the default scale,
 * the capacity clamp, and that the whole block fits inside the reserved mailbox.
 */

import { describe, expect, it } from "vitest";

import {
  MAILBOX_WORDS,
  MESH_POSE_BASE,
  MESH_POSE_CAPACITY,
  MESH_POSE_STRIDE,
  MESH_POSE_HIDDEN,
  MESH_CAM_ANGLE_SCALE,
  MESH_CAM_DIST_SCALE,
  decodeMeshPoses,
} from "@cartbox/player";

/** Write one pose record exactly as the SDK Lua does, and publish the count. */
function writePose(
  words: Uint32Array,
  slot: number,
  pose: { index: number; hidden?: boolean; pos: [number, number, number]; rot: [number, number, number]; scale: number },
): void {
  const base = MESH_POSE_BASE + 1 + slot * MESH_POSE_STRIDE;
  words[base] = (pose.index & 0xff) | (pose.hidden ? MESH_POSE_HIDDEN : 0);
  words[base + 1] = Math.round(pose.pos[0] * MESH_CAM_DIST_SCALE) >>> 0;
  words[base + 2] = Math.round(pose.pos[1] * MESH_CAM_DIST_SCALE) >>> 0;
  words[base + 3] = Math.round(pose.pos[2] * MESH_CAM_DIST_SCALE) >>> 0;
  words[base + 4] = Math.round(pose.rot[0] * MESH_CAM_ANGLE_SCALE) >>> 0;
  words[base + 5] = Math.round(pose.rot[1] * MESH_CAM_ANGLE_SCALE) >>> 0;
  words[base + 6] = Math.round(pose.rot[2] * MESH_CAM_ANGLE_SCALE) >>> 0;
  words[base + 7] = Math.round(pose.scale * MESH_CAM_DIST_SCALE) >>> 0;
  words[MESH_POSE_BASE] = slot + 1; // publish the count
}

describe("decodeMeshPoses", () => {
  it("fits inside the reserved mailbox", () => {
    const lastWord = MESH_POSE_BASE + MESH_POSE_CAPACITY * MESH_POSE_STRIDE;
    expect(lastWord).toBeLessThan(MAILBOX_WORDS);
  });

  it("returns nothing when the count is zero", () => {
    expect(decodeMeshPoses(new Uint32Array(MAILBOX_WORDS))).toEqual([]);
  });

  it("round-trips a signed pose targeting an instance index", () => {
    const words = new Uint32Array(MAILBOX_WORDS);
    writePose(words, 0, { index: 3, pos: [-1.5, 2, 0.25], rot: [0.5, -1.25, 0.1], scale: 2 });
    const poses = decodeMeshPoses(words);
    expect(poses).toHaveLength(1);
    const p = poses[0]!;
    expect(p.index).toBe(3);
    expect(p.hidden).toBe(false);
    expect(p.position[0]).toBeCloseTo(-1.5, 2);
    expect(p.position[1]).toBeCloseTo(2, 2);
    expect(p.rotation[1]).toBeCloseTo(-1.25, 3);
    expect(p.scale).toBeCloseTo(2, 2);
  });

  it("decodes the hidden flag without disturbing the index", () => {
    const words = new Uint32Array(MAILBOX_WORDS);
    writePose(words, 0, { index: 5, hidden: true, pos: [0, 0, 0], rot: [0, 0, 0], scale: 1 });
    const p = decodeMeshPoses(words)[0]!;
    expect(p.index).toBe(5);
    expect(p.hidden).toBe(true);
  });

  it("reads every published record in order", () => {
    const words = new Uint32Array(MAILBOX_WORDS);
    writePose(words, 0, { index: 0, pos: [1, 0, 0], rot: [0, 0, 0], scale: 1 });
    writePose(words, 1, { index: 2, pos: [0, 3, 0], rot: [0, 0, 0], scale: 1 }); // publishes count 2
    const poses = decodeMeshPoses(words);
    expect(poses.map((p) => p.index)).toEqual([0, 2]);
  });

  it("clamps a count that exceeds capacity", () => {
    const words = new Uint32Array(MAILBOX_WORDS);
    words[MESH_POSE_BASE] = MESH_POSE_CAPACITY + 4; // a buggy/oversized count
    expect(decodeMeshPoses(words).length).toBe(MESH_POSE_CAPACITY);
  });
});
