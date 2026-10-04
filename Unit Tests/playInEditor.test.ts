/**
 * Play in the editor (ENGINE_PARITY_ROADMAP.md EP5): edits pushed into a
 * running scene (placements, materials, lighting) show from the next frame;
 * a structural change is refused; and the ejected camera's orbit.
 */

import { describe, expect, it } from "vitest";

import { serializeMeshAsset, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene, type SceneDraw, type SceneRenderer } from "@cartbox/player";

import { editorOrbit } from "@/lib/playCamera";
import { cameraLookingAt, cameraPivot } from "@/lib/viewportCamera";

function brick(colour: [number, number, number, number]): MeshAsset {
  const p = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1].map((v) => v / 2);
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { name: "brick", primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: colour, baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 } }] };
}

function sidecar(over: { y?: number; colour?: [number, number, number, number]; ambient?: number; extra?: boolean; parented?: boolean } = {}) {
  const t = (y: number) => ({ position: [0, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  return JSON.stringify({
    version: 2,
    meshes: [
      { id: "floor", name: "floor", mesh: serializeMeshAsset(brick([0.5, 0.5, 0.5, 1])), transform: t(0) },
      { id: "box", name: "box", mesh: serializeMeshAsset(brick(over.colour ?? [1, 0, 0, 1])), transform: t(over.y ?? 2), ...(over.parented ? { parent: "floor" } : {}) },
      ...(over.extra ? [{ id: "more", name: "more", mesh: serializeMeshAsset(brick([0, 0, 1, 1])), transform: t(5) }] : []),
    ],
    lighting: { ambient: over.ambient ?? 0.3, sun: { azimuth: 30, elevation: 50, color: [1, 1, 1], intensity: 1 }, lights: [], shadows: false },
  });
}

async function surfaceFor(text: string) {
  const drawn: (readonly MeshSceneInstance[])[] = [];
  const draws: SceneDraw[] = [];
  const renderer: SceneRenderer = {
    backend: "software",
    render: (instances, draw) => {
      drawn.push(instances);
      draws.push(draw);
    },
    dispose: () => {},
  };
  const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 32, parseMeshScene(text)!, renderer);
  const frame = () => {
    surface.blit(new Uint8Array(32 * 32 * 4));
    return { instances: drawn.at(-1)!, draw: draws.at(-1)! };
  };
  return { surface, frame };
}

describe("live edits in a running scene", () => {
  it("moves an object, recolours it and changes the light from the next frame, without a restart", async () => {
    const { surface, frame } = await surfaceFor(sidecar());
    expect(frame().instances[1]!.model[13]).toBeCloseTo(2);
    expect(await surface.applySceneEdits(parseMeshScene(sidecar({ y: 7, colour: [0, 1, 0, 1], ambient: 0.8 }))!)).toBe(true);
    const after = frame();
    expect(after.instances[1]!.model[13]).toBeCloseTo(7);
    expect(after.instances[1]!.mesh.primitives[0]!.material.baseColorFactor).toEqual([0, 1, 0, 1]);
    expect(after.instances[0]!.model[13]).toBeCloseTo(0); // the floor stays put
    expect(after.draw.ambient).toBeCloseTo(0.8);
  });

  it("moves a child with its parent's new placement", async () => {
    const { surface, frame } = await surfaceFor(sidecar({ parented: true }));
    expect(frame().instances[1]!.model[13]).toBeCloseTo(2);
    await surface.applySceneEdits(parseMeshScene(sidecar({ parented: true, y: 4 }))!);
    expect(frame().instances[1]!.model[13]).toBeCloseTo(4);
  });

  it("refuses a change to the scene's structure (it takes a fresh run)", async () => {
    const { surface, frame } = await surfaceFor(sidecar());
    expect(await surface.applySceneEdits(parseMeshScene(sidecar({ extra: true }))!)).toBe(false);
    expect(await surface.applySceneEdits(parseMeshScene(sidecar({ parented: true }))!)).toBe(false);
    expect(frame().instances).toHaveLength(2);
  });
});

describe("ejected camera", () => {
  it("hands the player an orbit about its pivot, relative to the scene's centre", () => {
    const camera = cameraLookingAt([4, 1, -2], 0.5, 0.3, 10);
    const orbit = editorOrbit(camera, [1, 1, 1]);
    expect(orbit).toMatchObject({ yaw: 0.5, pitch: 0.3, distance: 10, hud: false });
    const pivot = cameraPivot(camera);
    orbit.target.forEach((v, k) => expect(v).toBeCloseTo(pivot[k]! - [1, 1, 1][k]!, 9));
    // The player's orbit puts the eye where the editor's camera is.
    const eye = [orbit.target[0] + 1 + orbit.distance * Math.cos(orbit.pitch) * Math.sin(orbit.yaw), orbit.target[1] + 1 + orbit.distance * Math.sin(orbit.pitch), orbit.target[2] + 1 + orbit.distance * Math.cos(orbit.pitch) * Math.cos(orbit.yaw)];
    eye.forEach((v, k) => expect(v).toBeCloseTo(camera.position[k]!, 9));
  });
});


