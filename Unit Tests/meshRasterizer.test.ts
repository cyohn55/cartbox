/**
 * Unit tests for the software mesh rasteriser. These exercise the parts that are
 * easy to get wrong and impossible to eyeball in a headless run: coverage,
 * depth ordering, the texture path, and near-plane culling. A camera-facing quad
 * spanning the origin gives a deterministic centre pixel to assert on.
 */

import { describe, expect, it } from "vitest";

import { type MeshAsset, type DecodedTexture, renderMesh } from "@cartbox/editor";

const SIZE = 64;
const CENTER = (SIZE / 2) * SIZE + SIZE / 2; // pixel index at the viewport centre

/** A camera-facing quad at depth `z`, a solid `[r,g,b]` (0..1), optionally UV-mapped. */
function quad(z: number, color: [number, number, number], withUv = false): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: withUv ? Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]) : null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [color[0], color[1], color[2], 1], baseColorImage: null },
      },
    ],
  };
}

function buffers() {
  return { out: new Uint8ClampedArray(SIZE * SIZE * 4), depth: new Float32Array(SIZE * SIZE) };
}

/** The RGBA at the viewport centre after a render. */
function centerPixel(out: Uint8ClampedArray): [number, number, number, number] {
  return [out[CENTER * 4]!, out[CENTER * 4 + 1]!, out[CENTER * 4 + 2]!, out[CENTER * 4 + 3]!];
}

describe("mesh rasterizer", () => {
  it("fills the centre with a front-facing quad's base colour", () => {
    const { out, depth } = buffers();
    // ambient 1 removes shading so the colour is exactly the base colour.
    renderMesh(quad(0, [1, 0, 0]), { camera: { yaw: 0, pitch: 0 }, size: SIZE, out, depth, ambient: 1 });
    expect(centerPixel(out)).toEqual([255, 0, 0, 255]);
  });

  it("resolves depth so the nearer surface wins regardless of draw order", () => {
    const { out, depth } = buffers();
    // Camera sits on +Z, so the larger-z quad is nearer. Draw the far one last to
    // prove it is the depth buffer, not draw order, that decides.
    const scene: MeshAsset = {
      name: "two",
      primitives: [quad(0.5, [0, 0, 1]).primitives[0]!, quad(0, [1, 0, 0]).primitives[0]!],
    };
    renderMesh(scene, { camera: { yaw: 0, pitch: 0 }, size: SIZE, out, depth, ambient: 1 });
    expect(centerPixel(out)).toEqual([0, 0, 255, 255]); // the nearer blue quad
  });

  it("multiplies the base colour by the sampled texture", () => {
    const { out, depth } = buffers();
    const texture: DecodedTexture = { width: 1, height: 1, data: Uint8ClampedArray.from([0, 255, 0, 255]) };
    renderMesh(quad(0, [1, 1, 1], true), {
      camera: { yaw: 0, pitch: 0 },
      size: SIZE,
      out,
      depth,
      ambient: 1,
      textures: [texture],
    });
    expect(centerPixel(out)).toEqual([0, 255, 0, 255]); // white base × green texel
  });

  it("clips triangles that straddle the near plane without corrupting the frame", () => {
    const { out, depth } = buffers();
    // A large floor spanning the origin, viewed up close (explicit small distance)
    // and tilted, so its far half sits behind the camera and each triangle
    // straddles the near plane. The origin is on the floor and in front, so the
    // centre must render the floor colour — broken clipping (negative-w wrap)
    // would smear garbage over it instead.
    const floor: MeshAsset = {
      name: "floor",
      primitives: [
        {
          positions: Float32Array.from([-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5]),
          normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
          uvs: null,
          indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
          material: { name: "m", baseColorFactor: [0, 1, 0, 1], baseColorImage: null },
        },
      ],
    };
    renderMesh(floor, { camera: { yaw: 0, pitch: 0.4, distance: 3 }, size: SIZE, out, depth, ambient: 1 });
    expect(centerPixel(out)).toEqual([0, 255, 0, 255]);
  });

  it("applies two-sided shading between ambient and full brightness", () => {
    const { out, depth } = buffers();
    // Light straight down +Z toward the camera; the +Z-facing quad is lit fully.
    renderMesh(quad(0, [1, 1, 1]), {
      camera: { yaw: 0, pitch: 0 },
      size: SIZE,
      out,
      depth,
      ambient: 0.25,
      lightDirection: [0, 0, 1],
    });
    const [r] = centerPixel(out);
    expect(r).toBeGreaterThan(240); // ambient 0.25 + full N·L ≈ 1.0
  });
});
