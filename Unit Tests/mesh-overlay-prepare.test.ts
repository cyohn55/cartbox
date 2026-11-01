/**
 * The mesh overlay sends a newly seen mesh's material graphs to compile
 * (AAA_FIDELITY_ROADMAP.md F1e) on the renderer itself: the WebGPU renderer's
 * prepareMaterials is a class method that reads its own fields, so taking it
 * off the renderer and calling it bare threw ("reading 'variants'") and
 * stopped every AAA match on a map with graph materials, Beaver Creek's first.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, lockoutMeshSidecar, type MeshAsset, type MeshMaterial, type MeshSceneInstance } from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene, type SceneRenderer } from "@cartbox/player";

/** A renderer whose prepareMaterials needs its `this`, as the WebGPU renderer's does. */
class FieldRenderer {
  readonly backend = "webgpu" as const;
  private readonly seen = new Set<string>();
  render(): void {}
  dispose(): void {}
  prepareMaterials(materials: Iterable<MeshMaterial>): Promise<void> {
    for (const m of materials) this.seen.add(m.name);
    return Promise.resolve();
  }
  get prepared(): string[] {
    return [...this.seen];
  }
}

describe("the mesh overlay's material graphs", { timeout: 120_000 }, () => {
  it("compiles them through the renderer, not a method taken off it", async () => {
    const scene = parseMeshScene(lockoutMeshSidecar())!;
    const renderer = new FieldRenderer();
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer as unknown as SceneRenderer);
    const material = { name: "glow", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, graph: { nodes: [{ id: "c", op: "constant", params: { value: [1, 0, 0] } }], outputs: { emissive: "c" } } } as unknown as MeshMaterial;
    const mesh = { name: "m", primitives: [{ positions: new Float32Array(9), normals: new Float32Array(9), uvs: new Float32Array(6), indices: Uint32Array.from([0, 1, 2]), material }] } as unknown as MeshAsset;
    const instances = [{ mesh, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[];
    expect(() => (surface as any).prepareGraphs(instances, { prepass: true })).not.toThrow();
    expect(renderer.prepared).toEqual(["glow"]);
  });
});
