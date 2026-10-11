/**
 * The front layer (a held weapon) on the GPU: where the scene draws on the GPU,
 * the overlay makes a GPU renderer of its own for what the cart poses on the
 * front layer, instead of rasterising it on the CPU every frame — a detailed
 * viewmodel filling a third of a 720p frame costs the CPU rasteriser hundreds
 * of milliseconds. That renderer sees nothing behind the weapon to bend, so it
 * draws refracting materials straight.
 */

import { describe, expect, it } from "vitest";

import { serializeMeshAsset, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene, type SceneDraw, type SceneRenderer } from "@cartbox/player";

function cube(): MeshAsset {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return {
    name: "cube",
    primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorImage: null } }],
  };
}

function glassCube(): MeshAsset {
  const c = cube();
  return { ...c, name: "blade", primitives: c.primitives.map((p) => ({ ...p, material: { ...p.material, alphaMode: "blend" as const, refraction: 0.6, distortion: 0.2 } })) };
}

const sidecar = JSON.stringify({
  version: 2,
  meshes: [
    { id: "box", name: "box", mesh: serializeMeshAsset(cube()), transform: { position: [0, 0, -3], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { id: "blade", name: "blade", mesh: serializeMeshAsset(glassCube()), transform: { position: [0, 0, -1], rotation: [0, 0, 0], scale: [0.2, 0.2, 0.2] } },
  ],
});

/** A stand-in GPU renderer that records what it was asked to draw. */
function recorder(backend: SceneRenderer["backend"]) {
  const drawn: (readonly MeshSceneInstance[])[] = [];
  let disposed = false;
  const renderer: SceneRenderer = {
    backend,
    render: (instances, _draw: SceneDraw) => void drawn.push(instances),
    dispose: () => void (disposed = true),
  };
  return { renderer, drawn, disposed: () => disposed };
}

const frontPose = { index: 1, hidden: false, position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: 1, front: true };

describe("the front layer on the GPU", () => {
  it("is drawn by a GPU renderer of its own once made, without refraction, and that renderer goes with the surface", async () => {
    const main = recorder("webgpu");
    const front = recorder("webgpu");
    let made = 0;
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 64, 36, parseMeshScene(sidecar)!, main.renderer, {
      createFrontRenderer: async () => {
        made += 1;
        return front.renderer;
      },
    });
    surface.setPoseOverrides([frontPose]);
    // The first frame asks for it, and draws the weapon on the CPU meanwhile.
    surface.blit(new Uint8Array(64 * 36 * 4));
    expect(made).toBe(1);
    expect(front.drawn).toHaveLength(0);
    await Promise.resolve();
    await Promise.resolve();
    for (let f = 0; f < 3; f += 1) surface.blit(new Uint8Array(64 * 36 * 4));
    expect(made).toBe(1);
    expect(front.drawn).toHaveLength(3);
    // The scene's renderer no longer gets the weapon; the front one gets only it, drawn straight.
    expect(main.drawn.at(-1)!.map((i) => i.mesh.name)).not.toContain("blade");
    const blade = front.drawn.at(-1)!.map((i) => i.mesh);
    expect(blade.map((m) => m.name)).toEqual(["blade"]);
    expect(main.drawn.at(-1)!.map((i) => i.mesh.name)).toContain("cube");
    for (const p of blade[0]!.primitives) {
      expect(p.material.refraction).toBeUndefined();
      expect(p.material.distortion).toBeUndefined();
      expect(p.material.alphaMode).toBe("blend");
    }
    // The same copy every frame, so the renderer keeps its buffers.
    expect(front.drawn[1]![0]!.mesh).toBe(front.drawn[2]![0]!.mesh);
    surface.destroy();
    expect(front.disposed()).toBe(true);
    expect(main.disposed()).toBe(false); // the scene's renderer belongs to whoever passed it
  });

  it("stays on the CPU when no GPU renderer comes up, or none is offered", async () => {
    const software = recorder("software");
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 64, 36, parseMeshScene(sidecar)!, recorder("webgpu").renderer, {
      createFrontRenderer: async () => software.renderer,
    });
    surface.setPoseOverrides([frontPose]);
    surface.blit(new Uint8Array(64 * 36 * 4));
    await Promise.resolve();
    await Promise.resolve();
    surface.blit(new Uint8Array(64 * 36 * 4));
    expect(software.drawn).toHaveLength(0);
    expect(software.disposed()).toBe(true);
  });
});
