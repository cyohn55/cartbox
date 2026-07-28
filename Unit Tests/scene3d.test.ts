/**
 * Shared scene camera tests — the pure 3D coordinate system that positions the
 * onboarding world, handhelds, and tagline under one camera. Drives the real
 * projection with concrete anchors and layouts and asserts the coordinate
 * conventions the whole scene relies on (origin centres life-size; +x right, +y
 * up, +z nearer/larger), plus the perspective and depth helpers that govern how
 * billboards scale and how the terrain occludes them.
 */

import { describe, expect, it } from "vitest";

import {
  CAMERA_FOCAL_UNITS,
  HANDHELD_ANCHOR,
  TAGLINE_ANCHOR,
  WORLD_ANCHOR,
  perspectiveScale,
  projectAnchor,
  viewDepth,
  type SceneLayout,
  type Vec3,
} from "../apps/web/src/lib/scene3d";

/** A concrete camera layout: 5 CSS px per world unit over a 1000×800 viewport. */
const LAYOUT: SceneLayout = {
  pixelsPerUnit: 5,
  viewportWidth: 1000,
  viewportHeight: 800,
};

describe("projectAnchor", () => {
  it("places the origin at the viewport centre, life-size", () => {
    const projected = projectAnchor(WORLD_ANCHOR, LAYOUT);
    expect(projected.offsetX).toBeCloseTo(0);
    expect(projected.offsetY).toBeCloseTo(0);
    expect(projected.scale).toBe(1);
    expect(projected.depth).toBe(0);
  });

  it("maps +x to the right and -x to the left, symmetrically", () => {
    const right = projectAnchor([8, 0, 0], LAYOUT);
    const left = projectAnchor([-8, 0, 0], LAYOUT);
    // At depth 0 the scale is 1, so the offset is a straight unit→pixel scaling.
    expect(right.offsetX).toBe(8 * LAYOUT.pixelsPerUnit);
    expect(left.offsetX).toBe(-right.offsetX);
    expect(right.offsetY).toBeCloseTo(0);
  });

  it("maps +y upward (screen y decreases as world y rises)", () => {
    const up = projectAnchor([0, 6, 0], LAYOUT);
    expect(up.offsetY).toBe(-6 * LAYOUT.pixelsPerUnit);
    expect(up.offsetX).toBe(0);
  });

  it("makes nearer (+z) anchors larger and farther (-z) anchors smaller", () => {
    const near = projectAnchor([0, 0, 40], LAYOUT);
    const far = projectAnchor([0, 0, -40], LAYOUT);
    expect(near.scale).toBeGreaterThan(1);
    expect(far.scale).toBeLessThan(1);
    expect(near.depth).toBeGreaterThan(0);
    expect(far.depth).toBeLessThan(0);
  });

  it("scales screen offsets linearly with the camera zoom", () => {
    const anchor: Vec3 = [10, -4, 0]; // depth 0 → scale fixed at 1
    const base = projectAnchor(anchor, LAYOUT);
    const zoomed = projectAnchor(anchor, { ...LAYOUT, pixelsPerUnit: LAYOUT.pixelsPerUnit * 2 });
    expect(zoomed.offsetX).toBeCloseTo(base.offsetX * 2);
    expect(zoomed.offsetY).toBeCloseTo(base.offsetY * 2);
  });
});

describe("perspectiveScale", () => {
  it("renders depth 0 exactly life-size", () => {
    expect(perspectiveScale(0)).toBe(1);
  });

  it("increases monotonically with depth (nearer is bigger)", () => {
    expect(perspectiveScale(20)).toBeGreaterThan(perspectiveScale(0));
    expect(perspectiveScale(0)).toBeGreaterThan(perspectiveScale(-20));
  });

  it("stays finite and positive at and beyond the focal plane", () => {
    const atPlane = perspectiveScale(CAMERA_FOCAL_UNITS);
    const beyond = perspectiveScale(CAMERA_FOCAL_UNITS + 100);
    expect(Number.isFinite(atPlane)).toBe(true);
    expect(atPlane).toBeGreaterThan(0);
    expect(Number.isFinite(beyond)).toBe(true);
    expect(beyond).toBeGreaterThan(0);
  });
});

describe("viewDepth", () => {
  it("reports the handheld plane's depth (the terrain occlusion threshold)", () => {
    // The occlusion plane must equal the depth the handheld anchor projects to, so
    // trees nearer than the handhelds are drawn in front of them.
    expect(viewDepth(HANDHELD_ANCHOR)).toBe(projectAnchor(HANDHELD_ANCHOR, LAYOUT).depth);
  });

  it("seats the default tagline above and behind the handhelds", () => {
    const tagline = projectAnchor(TAGLINE_ANCHOR, LAYOUT);
    const handheld = projectAnchor(HANDHELD_ANCHOR, LAYOUT);
    expect(tagline.offsetY).toBeLessThan(0); // above centre
    expect(tagline.depth).toBeLessThan(handheld.depth); // farther from the viewer
    expect(tagline.scale).toBeLessThan(handheld.scale); // …so it renders smaller
  });
});
