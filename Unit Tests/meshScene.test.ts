/**
 * Unit tests for the player's runtime mesh scene (`parseMeshScene` +
 * `buildOrbitCamera`): decoding the stored mesh sidecar into placed instances,
 * dropping malformed entries defensively, unioning world-space bounds, and
 * framing them with an orbit camera. An end-to-end check parses a serialized
 * mesh, frames it, and rasterises it — the exact path the MeshOverlaySurface
 * runs each frame — to prove the pieces agree.
 */

import { describe, expect, it } from "vitest";

import { parseMeshScene, buildOrbitCamera } from "@cartbox/player";
import { renderMeshScene, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";

/** A camera-facing unit quad, serialized as the sidecar stores it. */
function serializedQuad(color: [number, number, number] = [1, 0, 0]): string {
  const mesh: MeshAsset = {
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
  return serializeMeshAsset(mesh);
}

/** Build a sidecar JSON string around the given entries. */
function sidecar(entries: unknown[]): string {
  return JSON.stringify({ version: 1, meshes: entries });
}

describe("parseMeshScene", () => {
  it("returns null for empty, missing, or unparseable payloads", () => {
    expect(parseMeshScene(null)).toBeNull();
    expect(parseMeshScene(undefined)).toBeNull();
    expect(parseMeshScene("")).toBeNull();
    expect(parseMeshScene("not json")).toBeNull();
    expect(parseMeshScene(sidecar([]))).toBeNull();
  });

  it("decodes a valid entry into a placed instance with bounds", () => {
    const scene = parseMeshScene(sidecar([{ id: "a", name: "Quad", mesh: serializedQuad(), transform: undefined }]));
    expect(scene).not.toBeNull();
    expect(scene!.instances).toHaveLength(1);
    // Identity transform: the unit quad's world bounds centre on the origin.
    expect(scene!.bounds.center[0]).toBeCloseTo(0, 5);
    expect(scene!.bounds.center[1]).toBeCloseTo(0, 5);
    expect(scene!.bounds.radius).toBeGreaterThan(0);
  });

  it("bakes the placement transform into the instance's world bounds", () => {
    const scene = parseMeshScene(
      sidecar([{ mesh: serializedQuad(), transform: { position: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }]),
    );
    expect(scene).not.toBeNull();
    // The quad spans x∈[-1,1]; translated by +10 its world centre is x≈10.
    expect(scene!.bounds.center[0]).toBeCloseTo(10, 5);
    expect(scene!.bounds.min[0]).toBeCloseTo(9, 5);
    expect(scene!.bounds.max[0]).toBeCloseTo(11, 5);
  });

  it("scales bounds by the placement scale", () => {
    const scene = parseMeshScene(
      sidecar([{ mesh: serializedQuad(), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [3, 3, 3] } }]),
    );
    expect(scene!.bounds.min[0]).toBeCloseTo(-3, 5);
    expect(scene!.bounds.max[0]).toBeCloseTo(3, 5);
  });

  it("drops malformed entries but keeps valid siblings", () => {
    const scene = parseMeshScene(
      sidecar([
        { id: "bad-no-mesh", name: "x" }, // no mesh string
        { id: "bad-garbage", mesh: "{not a mesh}" }, // unparseable geometry
        { id: "good", mesh: serializedQuad() },
      ]),
    );
    expect(scene).not.toBeNull();
    expect(scene!.instances).toHaveLength(1);
  });

  it("returns null when every entry is malformed", () => {
    expect(parseMeshScene(sidecar([{ mesh: 42 }, { mesh: "nope" }]))).toBeNull();
  });
});

describe("buildOrbitCamera + renderMeshScene (runtime path)", () => {
  it("frames a parsed scene so it rasterises into the framebuffer", () => {
    const size = 64;
    const scene = parseMeshScene(sidecar([{ mesh: serializedQuad([0, 1, 0]) }]));
    expect(scene).not.toBeNull();

    const camera = buildOrbitCamera(scene!.bounds, 0, 0, 1);
    const out = new Uint8ClampedArray(size * size * 4);
    const depth = new Float32Array(size * size);
    renderMeshScene(scene!.instances, {
      width: size,
      height: size,
      out,
      depth,
      view: camera.view,
      projection: camera.projection,
      ambient: 1,
    });

    // The auto-framed camera must place the quad on-screen: the centre is covered.
    const centre = ((size >> 1) * size + (size >> 1)) * 4;
    expect(out[centre + 3]).toBe(255);
    expect(out[centre + 1]).toBeGreaterThan(0); // green channel present
  });
});
