/**
 * Normal mapping in the software rasteriser (option 2, slice 3).
 *
 * A camera-facing quad is lit from the side (+X). Its geometric normal (+Z) is
 * perpendicular to the light, so unlit it sits at ambient. A tangent-space normal
 * map then perturbs the per-pixel normal:
 *   - flat (0,0,1)      -> unchanged -> stays dark (perpendicular to the light);
 *   - tilted toward +X  -> now faces the light -> bright;
 *   - tilted toward +Y  -> still perpendicular to an +X light -> stays dark,
 *     which proves the tangent (U) / bitangent (V) axes are oriented correctly.
 */

import { describe, expect, it } from "vitest";

import {
  composeModelMatrix,
  projectionMatrix,
  renderMeshScene,
  viewMatrix,
  type DecodedTexture,
  type Mat4,
  type MeshAsset,
} from "@cartbox/editor";

/** A white, UV-mapped quad facing the camera; U runs +X, V runs +Y in world. */
function uvQuad(): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
      },
    ],
  };
}

/** A 1×1 tangent-space normal map of a single RGB value. */
function normalTex(r: number, g: number, b: number): DecodedTexture {
  return { width: 1, height: 1, data: Uint8ClampedArray.from([r, g, b, 255]) };
}

function frontCamera(aspect: number): { view: Mat4; projection: Mat4 } {
  return {
    view: viewMatrix([0, 0, 5], [0, 0, 0]),
    projection: projectionMatrix((50 * Math.PI) / 180, aspect, 0.1, 100),
  };
}

const SIZE = 64;
const identity = (): Mat4 => composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);

/** Render the quad with an optional normal map; return the centre pixel's red. */
function centreRed(normal: DecodedTexture | null): number {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const depth = new Float32Array(SIZE * SIZE);
  const { view, projection } = frontCamera(1);
  renderMeshScene(
    [{ mesh: uvQuad(), model: identity(), normalTextures: normal ? [normal] : undefined }],
    {
      width: SIZE,
      height: SIZE,
      out,
      depth,
      view,
      projection,
      lightDirection: [1, 0, 0], // light from +X, perpendicular to the quad's face
      ambient: 0.2,
    },
  );
  const i = ((SIZE >> 1) * SIZE + (SIZE >> 1)) * 4;
  return out[i]!;
}

describe("rasteriser normal mapping", () => {
  it("leaves a flat normal map at the geometric-normal shading", () => {
    // Flat (128,128,255) decodes to ~(0,0,1): the face stays perpendicular to the
    // +X light, so it renders at ambient — within rounding of having no normal
    // map (128 is a half-step off true flat 127.5, a sub-pixel tilt).
    expect(Math.abs(centreRed(normalTex(128, 128, 255)) - centreRed(null))).toBeLessThanOrEqual(2);
  });

  it("brightens where the normal map tilts the surface toward the light", () => {
    const flat = centreRed(normalTex(128, 128, 255));
    const towardLight = centreRed(normalTex(255, 128, 128)); // tangent normal (+1,0,0) -> world +X
    expect(towardLight).toBeGreaterThan(flat + 20);
  });

  it("keeps a tilt perpendicular to the light dark (tangent axes oriented right)", () => {
    const flat = centreRed(normalTex(128, 128, 255));
    const towardUp = centreRed(normalTex(128, 255, 128)); // tangent normal (0,+1,0) -> world +Y
    expect(Math.abs(towardUp - flat)).toBeLessThanOrEqual(2);
  });
});
