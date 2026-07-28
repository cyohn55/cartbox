/**
 * Segmented-character rig tests. They drive the real rig builder and the demo
 * rig through the real compositor's projection, asserting the multi-plane
 * layering property that defines the feature: parts at different depths shift by
 * different amounts (and directions) under a camera yaw. Expectations are framed
 * as relationships between parts, derived from their depths, not fixed numbers.
 */

import { describe, expect, it } from "vitest";
import {
  buildRigPlanes,
  findRigPart,
  demoCharacterRig,
  projectPlane,
  type Camera,
  type ScenePlane,
} from "@cartbox/editor";

const CAMERA: Camera = {
  panX: 0,
  panY: 0,
  yaw: 0,
  pivotX: 0,
  pivotDepth: 10,
  focalLength: 200,
  viewportWidth: 128,
  viewportHeight: 128,
};

/** Project the plane built from a named part, at the given camera. */
function projectPart(name: string, camera: Camera): { screenX: number; pixelScale: number } {
  const rig = demoCharacterRig(camera.pivotDepth);
  const planes = buildRigPlanes(rig);
  const index = rig.parts.findIndex((part) => part.name === name);
  const projected = projectPlane(planes[index] as ScenePlane, camera);
  return { screenX: projected.screenX, pixelScale: projected.pixelScale };
}

describe("buildRigPlanes", () => {
  it("places each part at pivotDepth + its depth offset", () => {
    const rig = demoCharacterRig(12);
    const planes = buildRigPlanes(rig);
    expect(planes).toHaveLength(rig.parts.length);
    rig.parts.forEach((part, index) => {
      expect((planes[index] as ScenePlane).depth).toBe(12 + part.depthOffset);
    });
  });

  it("applies the scene origin to every part's anchor", () => {
    const rig = demoCharacterRig();
    const planes = buildRigPlanes(rig, 3, -2);
    rig.parts.forEach((part, index) => {
      expect((planes[index] as ScenePlane).x).toBe(3 + part.offsetX);
      expect((planes[index] as ScenePlane).y).toBe(-2 + part.offsetY);
    });
  });
});

describe("demoCharacterRig", () => {
  it("exposes the five named parts ordered back-to-front by depth", () => {
    const rig = demoCharacterRig();
    const names = rig.parts.map((part) => part.name);
    expect(names).toEqual(["cape", "backArm", "torso", "head", "foreArm"]);

    // The cape is farthest behind the pivot; the fore arm nearest the camera.
    expect(findRigPart(rig, "cape")!.depthOffset).toBeGreaterThan(
      findRigPart(rig, "foreArm")!.depthOffset,
    );
  });

  it("paints every part with some opaque pixels", () => {
    const rig = demoCharacterRig();
    for (const part of rig.parts) {
      let opaque = 0;
      for (let i = 3; i < part.image.length; i += 4) {
        if (part.image[i] === 255) opaque += 1;
      }
      expect(opaque).toBeGreaterThan(0);
    }
  });
});

describe("segmented parallax under yaw", () => {
  it("swings the fore arm and the cape to opposite sides of the torso", () => {
    const yawed: Camera = { ...CAMERA, yaw: 0.25 };
    const center = CAMERA.viewportWidth / 2;

    const foreArm = projectPart("foreArm", yawed).screenX;
    const cape = projectPart("cape", yawed).screenX;
    const torso = projectPart("torso", yawed).screenX;

    // Torso sits at the pivot depth on the centre line, so it barely moves.
    expect(torso).toBeCloseTo(center, 6);
    // Fore arm (nearest) and cape (farthest) fall on opposite sides.
    expect(Math.sign(foreArm - center)).toBe(-Math.sign(cape - center));
  });

  it("gives the nearer fore arm a bigger swing than the farther back arm", () => {
    const yawed: Camera = { ...CAMERA, yaw: 0.25 };
    const center = CAMERA.viewportWidth / 2;
    const foreArm = Math.abs(projectPart("foreArm", yawed).screenX - center);
    const backArm = Math.abs(projectPart("backArm", yawed).screenX - center);
    expect(foreArm).toBeGreaterThan(backArm);
  });

  it("renders the nearer fore arm larger than the farther cape", () => {
    expect(projectPart("foreArm", CAMERA).pixelScale).toBeGreaterThan(
      projectPart("cape", CAMERA).pixelScale,
    );
  });
});
