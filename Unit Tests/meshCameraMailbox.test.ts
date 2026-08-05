/**
 * Unit tests for the mesh-camera mailbox sub-protocol (`decodeMeshCamera`): the
 * words a cart writes via `cartbox.meshcam(...)` to drive its 3D meshes. Guards
 * the fixed-point round-trip, the active flag (an unset block must leave the
 * player auto-orbiting), and that the block fits inside the reserved mailbox.
 */

import { describe, expect, it } from "vitest";

import {
  MAILBOX_WORDS,
  MESH_CAM_BASE,
  MESH_CAM_STRIDE,
  MESH_CAM_ANGLE_SCALE,
  MESH_CAM_DIST_SCALE,
  decodeMeshCamera,
} from "@cartbox/player";

/** Write a mesh-camera pose into a fresh mailbox exactly as the SDK Lua does. */
function writeMeshCam(
  words: Uint32Array,
  pose: { yaw: number; pitch: number; distance: number; fov: number },
): void {
  words[MESH_CAM_BASE] = 1; // active flag
  words[MESH_CAM_BASE + 1] = Math.round(pose.yaw * MESH_CAM_ANGLE_SCALE) >>> 0;
  words[MESH_CAM_BASE + 2] = Math.round(pose.pitch * MESH_CAM_ANGLE_SCALE) >>> 0;
  words[MESH_CAM_BASE + 3] = Math.round(pose.distance * MESH_CAM_DIST_SCALE) >>> 0;
  words[MESH_CAM_BASE + 7] = Math.round(pose.fov * MESH_CAM_ANGLE_SCALE) >>> 0;
}

describe("decodeMeshCamera", () => {
  it("fits inside the reserved mailbox", () => {
    expect(MESH_CAM_BASE + MESH_CAM_STRIDE).toBeLessThanOrEqual(MAILBOX_WORDS);
  });

  it("returns null when the active flag is clear (auto-orbit stays in charge)", () => {
    expect(decodeMeshCamera(new Uint32Array(MAILBOX_WORDS))).toBeNull();
  });

  it("round-trips a signed pose the cart published", () => {
    const words = new Uint32Array(MAILBOX_WORDS);
    writeMeshCam(words, { yaw: -1.25, pitch: 0.4, distance: 6.5, fov: 0.8 });
    const cam = decodeMeshCamera(words);
    expect(cam).not.toBeNull();
    expect(cam!.yaw).toBeCloseTo(-1.25, 3);
    expect(cam!.pitch).toBeCloseTo(0.4, 3);
    expect(cam!.distance).toBeCloseTo(6.5, 2);
    expect(cam!.fov).toBeCloseTo(0.8, 3);
    expect(cam!.target).toEqual([0, 0, 0]);
  });

  it("treats a zero distance and fov as auto-fit / default (null)", () => {
    const words = new Uint32Array(MAILBOX_WORDS);
    writeMeshCam(words, { yaw: 0.5, pitch: 0.2, distance: 0, fov: 0 });
    const cam = decodeMeshCamera(words);
    expect(cam!.distance).toBeNull();
    expect(cam!.fov).toBeNull();
  });

  it("decodes a signed target offset from the scene centre", () => {
    const words = new Uint32Array(MAILBOX_WORDS);
    words[MESH_CAM_BASE] = 1;
    words[MESH_CAM_BASE + 4] = Math.round(-2.5 * MESH_CAM_DIST_SCALE) >>> 0;
    words[MESH_CAM_BASE + 5] = Math.round(1.5 * MESH_CAM_DIST_SCALE) >>> 0;
    const cam = decodeMeshCamera(words);
    expect(cam!.target[0]).toBeCloseTo(-2.5, 2);
    expect(cam!.target[1]).toBeCloseTo(1.5, 2);
  });
});
