/**
 * View-dependent specular + emissive from a material map (option 2, slice 5).
 *
 * A camera-facing grey quad (base 0.5) carries a 1×1 packed material map
 * (RGBA = height, specular, roughness, emissive). The rasteriser reads it for a
 * Blinn-Phong glint whose half-vector depends on the camera, and for an emissive
 * floor that keeps a surface bright when the light turns away:
 *   - specular > 0            -> a glint brighter than the plain diffuse surface;
 *   - the same map, orbited    -> a dimmer glint (the highlight is view-dependent);
 *   - emissive with light off  -> stays lit where a plain surface goes dark;
 *   - an all-zero material map  -> byte-identical to carrying none (the gate).
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

/** A mid-grey, UV-mapped quad facing the camera (normal +Z). */
function greyQuad(): MeshAsset {
  return {
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorImage: null },
      },
    ],
  };
}

/** A 1×1 packed material map: R=height, G=specular, B=roughness, A=emissive. */
function materialTex(height: number, specular: number, roughness: number, emissive: number): DecodedTexture {
  return { width: 1, height: 1, data: Uint8ClampedArray.from([height, specular, roughness, emissive]) };
}

const SIZE = 64;
const identity = (): Mat4 => composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);

/**
 * Render the quad through a camera at `eye` under a directional light, with an
 * optional material map, and return the centre pixel's red channel.
 */
function centreRed(
  material: DecodedTexture | null,
  eye: readonly [number, number, number],
  light: readonly [number, number, number],
  ambient = 0.05,
): number {
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  const depth = new Float32Array(SIZE * SIZE);
  renderMeshScene(
    [{ mesh: greyQuad(), model: identity(), materialTextures: material ? [material] : undefined }],
    {
      width: SIZE,
      height: SIZE,
      out,
      depth,
      view: viewMatrix([eye[0], eye[1], eye[2]], [0, 0, 0]),
      projection: projectionMatrix((50 * Math.PI) / 180, 1, 0.1, 100),
      lightDirection: light,
      ambient,
    },
  );
  const i = ((SIZE >> 1) * SIZE + (SIZE >> 1)) * 4;
  return out[i]!;
}

describe("rasteriser material map — specular + emissive", () => {
  it("adds a specular glint brighter than the plain diffuse surface", () => {
    const front: [number, number, number] = [0, 0, 5];
    const light: [number, number, number] = [0, 0, 1]; // straight on
    const plain = centreRed(null, front, light);
    const glossy = centreRed(materialTex(0, 255, 200, 0), front, light);
    expect(glossy).toBeGreaterThan(plain + 20);
  });

  it("moves the highlight with the camera (the glint is view-dependent)", () => {
    const light: [number, number, number] = [0, 0, 1];
    const material = materialTex(0, 255, 200, 0);
    // Head-on, the half-vector aligns with the surface normal -> peak glint.
    const front = centreRed(material, [0, 0, 5], light);
    // Orbited, the half-vector tilts off the normal -> a weaker glint on the
    // same texel, which is the whole point of a view-dependent highlight.
    const orbited = centreRed(material, [4, 0, 3], light);
    expect(front).toBeGreaterThan(orbited + 20);
  });

  it("keeps an emissive surface lit when the light turns away", () => {
    const front: [number, number, number] = [0, 0, 5];
    const side: [number, number, number] = [1, 0, 0]; // perpendicular: no diffuse
    const dark = centreRed(null, front, side);
    const glowing = centreRed(materialTex(0, 0, 200, 255), front, side);
    expect(dark).toBeLessThan(20); // ambient-only, nearly black
    expect(glowing).toBeGreaterThan(100); // lifted to its emissive floor
  });

  it("renders identically to no material map when the map is all zero (the gate)", () => {
    const front: [number, number, number] = [0, 0, 5];
    const light: [number, number, number] = [0.4, 0.2, 0.9];
    const none = centreRed(null, front, light);
    const trivial = centreRed(materialTex(0, 0, 0, 0), front, light);
    expect(trivial).toBe(none);
  });
});
