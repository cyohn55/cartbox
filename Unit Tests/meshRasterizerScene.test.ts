/**
 * Unit tests for the scene path of the software mesh rasteriser — the runtime
 * entry point (`renderMeshScene`) that draws many placed meshes through one
 * shared camera and depth buffer, plus the matrix helpers that pose them. These
 * cover what the single-mesh preview tests can't: per-instance model matrices,
 * cross-instance depth resolution, non-square framebuffers, and compositing over
 * an existing frame (the way the player overlays meshes on the cart's own image).
 *
 * A camera-facing quad framed from +Z gives a deterministic centre pixel to
 * assert on, exactly as the sibling preview tests do.
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type Mat4,
  type MeshAsset,
} from "@cartbox/editor";

/** A camera-facing unit quad (spans [-1,1] in x,y) at object z=0, solid `color`. */
function quad(color: [number, number, number]): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [color[0], color[1], color[2], 1], baseColorImage: null },
      },
    ],
  };
}

/** A camera looking at the origin from +Z, so a larger object-z is nearer. */
function frontCamera(aspect: number): { view: Mat4; projection: Mat4 } {
  return {
    view: viewMatrix([0, 0, 5], [0, 0, 0]),
    projection: projectionMatrix((50 * Math.PI) / 180, aspect, 0.1, 100),
  };
}

const identity = (): Mat4 => composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);

function buffers(width: number, height: number) {
  return { out: new Uint8ClampedArray(width * height * 4), depth: new Float32Array(width * height) };
}

/** The RGBA at a pixel, defaulting to the viewport centre. */
function pixelAt(out: Uint8ClampedArray, width: number, height: number, x = width >> 1, y = height >> 1): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [out[i]!, out[i + 1]!, out[i + 2]!, out[i + 3]!];
}

describe("renderMeshScene", () => {
  const SIZE = 64;

  it("renders an identity-placed quad's base colour at the centre", () => {
    const { out, depth } = buffers(SIZE, SIZE);
    const { view, projection } = frontCamera(1);
    renderMeshScene([{ mesh: quad([1, 0, 0]), model: identity() }], {
      width: SIZE,
      height: SIZE,
      out,
      depth,
      view,
      projection,
      ambient: 1, // remove shading so the pixel is exactly the base colour
    });
    expect(pixelAt(out, SIZE, SIZE)).toEqual([255, 0, 0, 255]);
  });

  it("applies each instance's model translation", () => {
    const { out, depth } = buffers(SIZE, SIZE);
    const { view, projection } = frontCamera(1);
    // Translate the quad far to the right; it leaves the frame, so the centre is
    // uncovered (transparent background) — proving the model matrix moved it.
    renderMeshScene([{ mesh: quad([1, 0, 0]), model: composeModelMatrix([8, 0, 0], [0, 0, 0], [1, 1, 1]) }], {
      width: SIZE,
      height: SIZE,
      out,
      depth,
      view,
      projection,
      ambient: 1,
    });
    expect(pixelAt(out, SIZE, SIZE)).toEqual([0, 0, 0, 0]);
  });

  it("turns a quad edge-on with a 90° Y rotation, uncovering the centre", () => {
    const { out, depth } = buffers(SIZE, SIZE);
    const { view, projection } = frontCamera(1);
    renderMeshScene([{ mesh: quad([1, 0, 0]), model: composeModelMatrix([0, 0, 0], [0, 90, 0], [1, 1, 1]) }], {
      width: SIZE,
      height: SIZE,
      out,
      depth,
      view,
      projection,
      ambient: 1,
    });
    expect(pixelAt(out, SIZE, SIZE)[3]).toBe(0); // no coverage for a zero-area projection
  });

  it("resolves depth across instances, so the nearer one wins regardless of order", () => {
    const { out, depth } = buffers(SIZE, SIZE);
    const { view, projection } = frontCamera(1);
    // Blue pushed toward the camera (object z=+1), red left at z=0. Draw the nearer
    // blue FIRST and the farther red LAST: only a shared depth buffer keeps blue.
    renderMeshScene(
      [
        { mesh: quad([0, 0, 1]), model: composeModelMatrix([0, 0, 1], [0, 0, 0], [1, 1, 1]) },
        { mesh: quad([1, 0, 0]), model: identity() },
      ],
      { width: SIZE, height: SIZE, out, depth, view, projection, ambient: 1 },
    );
    expect(pixelAt(out, SIZE, SIZE)).toEqual([0, 0, 255, 255]);
  });

  it("renders undistorted into a non-square framebuffer when aspect matches", () => {
    const width = 96;
    const height = 48;
    const { out, depth } = buffers(width, height);
    const { view, projection } = frontCamera(width / height);
    renderMeshScene([{ mesh: quad([0, 1, 0]), model: identity() }], {
      width,
      height,
      out,
      depth,
      view,
      projection,
      ambient: 1,
    });
    // Centre covered, and symmetric horizontal coverage proves x isn't stretched.
    expect(pixelAt(out, width, height)).toEqual([0, 255, 0, 255]);
    const left = pixelAt(out, width, height, width >> 2, height >> 1);
    const right = pixelAt(out, width, height, (width * 3) >> 2, height >> 1);
    expect(left).toEqual(right);
  });

  it("composites over an existing frame when background is null", () => {
    const width = 32;
    const height = 32;
    const { out, depth } = buffers(width, height);
    out.fill(0);
    for (let i = 0; i < width * height; i += 1) {
      out[i * 4] = 10;
      out[i * 4 + 1] = 20;
      out[i * 4 + 2] = 30;
      out[i * 4 + 3] = 255;
    }
    const { view, projection } = frontCamera(1);
    renderMeshScene([{ mesh: quad([1, 1, 1]), model: identity() }], {
      width,
      height,
      out,
      depth,
      view,
      projection,
      ambient: 1,
      background: null, // keep the underlying frame where no triangle covers
    });
    expect(pixelAt(out, width, height)).toEqual([255, 255, 255, 255]); // covered → mesh
    expect(pixelAt(out, width, height, 0, 0)).toEqual([10, 20, 30, 255]); // uncovered → frame kept
  });

  it("clears to the background colour when one is given", () => {
    const width = 16;
    const height = 16;
    const { out, depth } = buffers(width, height);
    out.fill(200); // stale contents that a solid background must overwrite
    const { view, projection } = frontCamera(1);
    renderMeshScene([{ mesh: quad([1, 0, 0]), model: composeModelMatrix([8, 0, 0], [0, 0, 0], [1, 1, 1]) }], {
      width,
      height,
      out,
      depth,
      view,
      projection,
      ambient: 1,
      background: [0, 0, 0, 255],
    });
    expect(pixelAt(out, width, height, 0, 0)).toEqual([0, 0, 0, 255]);
  });
});
