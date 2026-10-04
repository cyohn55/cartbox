/**
 * The scene viewport's free camera (ENGINE_PARITY_ROADMAP.md EP1): orbit, pan,
 * dolly, look and fly; framing; the orthographic views; picking rays that agree
 * with the projection; clip planes; and the ground grid.
 */

import { describe, expect, it } from "vitest";

import { pickBoxes, type Vec3 } from "@/lib/scenePick";
import {
  PITCH_LIMIT,
  VIEWPORT_FOV,
  cameraAxes,
  cameraLookingAt,
  cameraMatrices,
  cameraPivot,
  clipPlanes,
  dolly,
  fly,
  frame,
  gridLines,
  look,
  orbit,
  pan,
  setView,
  unitsPerPixel,
  viewportRay,
  type ViewportCamera,
} from "@/lib/viewportCamera";

const close = (a: Vec3, b: Vec3, digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Project a world point with a view-projection to NDC. */
function ndc(m: Float64Array | readonly number[], p: Vec3): [number, number, number] {
  const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
  return [(m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!) / w, (m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!) / w, (m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!) / w];
}

describe("free camera", () => {
  const start = cameraLookingAt([1, 2, 3], 0.6, 0.4, 10);

  it("has an orthonormal basis, looking down −Z at heading 0 and down at positive pitch", () => {
    const { forward, right, up } = cameraAxes({ yaw: 0, pitch: 0 });
    close(forward, [0, 0, -1]);
    close(right, [1, 0, 0]);
    close(up, [0, 1, 0]);
    expect(cameraAxes({ yaw: 0, pitch: 0.5 }).forward[1]).toBeLessThan(0);
    const a = cameraAxes({ yaw: 1.1, pitch: -0.3 });
    expect(Math.hypot(...a.up)).toBeCloseTo(1, 9);
    expect(a.forward[0] * a.right[0] + a.forward[1] * a.right[1] + a.forward[2] * a.right[2]).toBeCloseTo(0, 9);
  });

  it("orbits around its pivot, keeping the distance, and won't flip over the top", () => {
    close(cameraPivot(start), [1, 2, 3]);
    const turned = orbit(start, 1.2, 0.3);
    close(cameraPivot(turned), [1, 2, 3]);
    expect(dist(turned.position, [1, 2, 3])).toBeCloseTo(10, 6);
    expect(orbit(start, 0, 10).pitch).toBeCloseTo(PITCH_LIMIT, 9);
  });

  it("dollies toward the pivot (or zooms an orthographic view), and pans camera and pivot together", () => {
    const nearer = dolly(start, 0.5);
    expect(nearer.distance).toBeCloseTo(5, 9);
    close(cameraPivot(nearer), [1, 2, 3]);
    const top = setView(start, "top", [0, 0, 0]);
    const zoomed = dolly(top, 0.5);
    expect(zoomed.orthoSize).toBeCloseTo(top.orthoSize * 0.5, 9);
    close(zoomed.position, top.position);
    const slid = pan(start, 2, -1);
    const { right, up } = cameraAxes(start);
    close(cameraPivot(slid), [1 + right[0] * 2 - up[0], 2 + right[1] * 2 - up[1], 3 + right[2] * 2 - up[2]]);
  });

  it("looks around in place and flies along the view (up along the world's vertical)", () => {
    const turned = look(start, 0.5, -0.2);
    close(turned.position, start.position);
    expect(turned.yaw).toBeCloseTo(start.yaw + 0.5, 9);
    const flown = fly(start, { forward: 2, right: 0, up: 1 });
    const { forward } = cameraAxes(start);
    close(flown.position, [start.position[0] + forward[0] * 2, start.position[1] + forward[1] * 2 + 1, start.position[2] + forward[2] * 2]);
  });

  it("frames a sphere so it fits the view in both directions, keeping its heading", () => {
    for (const aspect of [0.5, 1, 2]) {
      const framed = frame(start, [5, 0, -5], 2, aspect);
      expect(framed.yaw).toBe(start.yaw);
      close(cameraPivot(framed), [5, 0, -5]);
      // Every point on the sphere's silhouette is inside the frustum.
      const { viewProj } = cameraMatrices(framed, aspect, 0.01, 100);
      const { right, up } = cameraAxes(framed);
      for (const [r, u] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const p: Vec3 = [5 + (right[0] * r + up[0] * u) * 2, (right[1] * r + up[1] * u) * 2, -5 + (right[2] * r + up[2] * u) * 2];
        const [x, y] = ndc(viewProj, p);
        expect(Math.abs(x)).toBeLessThanOrEqual(1);
        expect(Math.abs(y)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("switches to orthographic top, front and side views looking down the axes", () => {
    close(cameraAxes(setView(start, "top", [0, 0, 0])).forward, [0, -1, 0], 2);
    close(cameraAxes(setView(start, "front", [0, 0, 0])).forward, [0, 0, -1]);
    close(cameraAxes(setView(start, "side", [0, 0, 0])).forward, [-1, 0, 0]);
    const back = setView(setView(start, "top", [0, 0, 0]), "perspective", [0, 0, 0]);
    expect(back.view).toBe("perspective");
  });
});

describe("picking and projection", () => {
  it("casts rays that land where the projection puts them, in perspective and orthographic views", () => {
    const aspect = 1.6;
    for (const camera of [cameraLookingAt([0, 0, 0], 0.4, 0.3, 8), setView(cameraLookingAt([0, 0, 0], 0, 0, 8), "front", [0, 0, 0])]) {
      const { near, far } = clipPlanes(camera, [0, 0, 0], 3);
      const { viewProj } = cameraMatrices(camera, aspect, near, far);
      for (const p of [[0.5, 0.2, -0.3], [-1, 1, 1], [2, -0.5, 0]] as Vec3[]) {
        const [x, y] = ndc(viewProj, p);
        const ray = viewportRay(camera, aspect, x, y);
        // The point lies on the ray.
        const t = (p[0] - ray.origin[0]) * ray.dir[0] + (p[1] - ray.origin[1]) * ray.dir[1] + (p[2] - ray.origin[2]) * ray.dir[2];
        close([ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t], p, 5);
      }
    }
  });

  it("picks the nearest box under the cursor, also from an orthographic view behind the camera", () => {
    const boxes = [
      { key: "near", min: [-0.5, -0.5, 1.5] as Vec3, max: [0.5, 0.5, 2.5] as Vec3 },
      { key: "far", min: [-0.5, -0.5, -2.5] as Vec3, max: [0.5, 0.5, -1.5] as Vec3 },
    ];
    const persp = cameraLookingAt([0, 0, 0], 0, 0, 6); // at z = 6 looking down −Z
    expect(pickBoxes(boxes, viewportRay(persp, 1, 0, 0))).toBe("near");
    expect(pickBoxes(boxes, viewportRay(persp, 1, 0.9, 0.9))).toBeNull();
    const front = setView(cameraLookingAt([0, 0, -2], 0, 0, 0.1), "front", [0, 0, -2]); // its position is past "near"
    expect(pickBoxes(boxes, viewportRay(front, 1, 0, 0))).toBe("near");
  });

  it("keeps the scene inside the clip planes however far the camera flies", () => {
    const camera = fly(cameraLookingAt([0, 0, 0], 0.3, 0.2, 5), { forward: -400, right: 0, up: 0 });
    const { near, far } = clipPlanes(camera, [0, 0, 0], 20);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(dist(camera.position, [0, 0, 0]) + 20);
  });

  it("knows how big a pixel is at a depth", () => {
    const camera = cameraLookingAt([0, 0, 0], 0, 0, 10);
    expect(unitsPerPixel(camera, 10, 500)).toBeCloseTo((10 * Math.tan(VIEWPORT_FOV / 2) * 2) / 500, 9);
    const top: ViewportCamera = { ...setView(camera, "top", [0, 0, 0]), orthoSize: 5 };
    expect(unitsPerPixel(top, 123, 500)).toBeCloseTo(10 / 500, 9);
  });
});

describe("grid", () => {
  it("spaces its lines by a power of ten from the distance, on the ground, with every tenth major", () => {
    const near = gridLines(cameraLookingAt([0, 0, 0], 0.5, 0.6, 4));
    const far = gridLines(cameraLookingAt([0, 0, 0], 0.5, 0.6, 400));
    expect(near.step).toBe(1);
    expect(far.step).toBe(100);
    expect(near.lines.every((l) => l.a[1] === 0 && l.b[1] === 0)).toBe(true);
    expect(near.lines.some((l) => l.major)).toBe(true);
    expect(near.lines.filter((l) => l.major).length).toBeLessThan(near.lines.length / 5);
  });

  it("stands up facing a front or side view", () => {
    const front = gridLines(setView(cameraLookingAt([0, 0, 0], 0, 0, 10), "front", [0, 0, 0]));
    expect(front.lines.every((l) => l.a[2] === 0 && l.b[2] === 0)).toBe(true);
    const side = gridLines(setView(cameraLookingAt([0, 0, 0], 0, 0, 10), "side", [0, 0, 0]));
    expect(side.lines.every((l) => l.a[0] === 0 && l.b[0] === 0)).toBe(true);
  });
});
