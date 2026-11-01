/**
 * World partition (AAA_FIDELITY_ROADMAP.md F6d): a streaming scene's groups
 * in grid cells, each loaded whole, nearest first and a few at a time, shown
 * once its assets are prepared, and giving them back when it leaves range.
 */

import { describe, expect, it } from "vitest";

import { WorldPartition, partitionWorld, readStreaming, serializeMeshAsset, type MeshAsset, type StreamGroup } from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene, streamGroups, type SceneRenderer } from "@cartbox/player";

import { cellStates, sidecarCells } from "../apps/web/src/lib/worldPartitionView";
import { decodeMeshSidecar, setMeshStreaming } from "../apps/web/src/lib/meshSidecar";

const box = (x: number, z: number, s = 2): StreamGroup["box"] => [x - s / 2, 0, z - s / 2, x + s / 2, s, z + s / 2];
const group = (members: number[], x: number, z: number, s = 2): StreamGroup => ({ members, box: box(x, z, s) });

describe("the world partition's cells", () => {
  it("puts each group in the cell its centre falls in, its box the union of theirs", () => {
    const cells = partitionWorld([group([0], 10, 10), group([1, 2], 50, 10), group([3], 60, 20, 30), group([4], -10, 70)], 64);
    expect(cells.map((c) => [c.i, c.j])).toEqual([[-1, 1], [0, 0]].sort((a, b) => a[1]! - b[1]! || a[0]! - b[0]!) as number[][]);
    const home = cells.find((c) => c.i === 0 && c.j === 0)!;
    expect(home.members).toEqual([0, 1, 2, 3]);
    // The big group reaches out of the cell: so does the cell's box.
    expect(home.box[3]).toBe(75);
    expect(home.box[4]).toBe(30);
  });

  it("loads the nearest cells first, a few at a time, shows each once prepared, and unloads past the margin", () => {
    const cells = partitionWorld([0, 1, 2, 3, 4].map((k) => group([k], k * 20 + 5, 5)), 20);
    const world = new WorldPartition(cells, { range: 50 }, 2);
    // From x = 45: cells at 45, 25/65, 5/85 (within 50) want in; two at a time, nearest first.
    let step = world.update([45, 1, 5]);
    expect(step.load).toEqual([2, 1]);
    expect(world.unloaded().size).toBe(5);
    // Nothing more starts while two prepare.
    expect(world.update([45, 1, 5]).load).toEqual([]);
    expect(world.finished(2)).toBe(true);
    expect([...world.unloaded()].sort()).toEqual([0, 1, 3, 4]);
    step = world.update([45, 1, 5]);
    expect(step.load).toEqual([3]);
    // A cell preparing when it leaves range unloads; its preparation finishing then shows nothing.
    step = world.update([400, 1, 5]);
    expect(step.unload.sort()).toEqual([1, 2, 3]);
    expect(world.finished(3)).toBe(false);
    expect(world.unloaded().size).toBe(5);
  });

  it("holds a loaded cell a little past its range", () => {
    const world = new WorldPartition(partitionWorld([group([0], 5, 5)], 20), { range: 10 });
    world.update([5, 1, 14]);
    world.finished(0);
    // 10 + 1 from the box's edge: within the 15% margin.
    expect(world.update([5, 1, 17]).unload).toEqual([]);
    expect(world.update([5, 1, 30]).unload).toEqual([0]);
  });

  it("reads and stores a cell size, clamped", () => {
    expect(readStreaming({ range: 40, cell: 32 })).toEqual({ range: 40, cell: 32 });
    expect(readStreaming({ range: 40, cell: 2 })).toEqual({ range: 40, cell: 8 });
    expect(readStreaming({ range: 40 })).toEqual({ range: 40 });
  });
});

function cube(): MeshAsset {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { name: "cube", primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorImage: null } }] };
}

/** Four crates along x, two sharing a mesh, every 30 units, and the player, always loaded. */
function sidecar(streaming: unknown) {
  const shared = serializeMeshAsset(cube());
  const T = (x: number) => ({ position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  return JSON.stringify({
    version: 2,
    streaming,
    meshes: [
      { id: "player", name: "player", mesh: serializeMeshAsset(cube()), transform: T(0), alwaysLoaded: true },
      { id: "a", name: "a", mesh: shared, transform: T(10) },
      { id: "b", name: "b", mesh: shared, transform: T(40) },
      { id: "c", name: "c", mesh: serializeMeshAsset(cube()), transform: T(70) },
    ],
  });
}

describe("the world partition in the player", () => {
  it("leaves a cell's objects bare until it loads, and gives back geometry no loaded object uses", async () => {
    const scene = parseMeshScene(sidecar({ range: 20, cell: 30 }))!;
    const released: MeshAsset[][] = [];
    const renderer = { backend: "software", render() {}, dispose() {}, releaseMeshes: (m: readonly MeshAsset[]) => released.push([...m]) } as unknown as SceneRenderer;
    const surface = (await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer)) as any;
    const groups = streamGroups(scene);
    expect(groups.map((g) => g.members)).toEqual([[1], [2], [3]]);
    // Bare until loaded: no maps at all.
    expect("textures" in surface.instances[1]).toBe(false);
    expect("textures" in surface.instances[0]).toBe(true);
    await surface.loadCell([1]);
    await surface.loadCell([2]);
    expect(surface.cellLoaded(1)).toBe(true);
    expect("textures" in surface.instances[1]).toBe(true);
    // a and b share a mesh: unloading a keeps it, unloading b gives it back.
    surface.unloadCell([1]);
    expect(released).toEqual([]);
    expect("textures" in surface.instances[1]).toBe(false);
    surface.unloadCell([2]);
    expect(released).toEqual([[scene.instances[2]!.mesh]]);
  });

  it("streams foliage blocks with their cells", () => {
    const withFoliage = { ...parseMeshScene(sidecar({ range: 20, cell: 30 }))! };
    const instances = withFoliage.instances.map((inst, i) => (i === 3 ? { ...inst, terrain: true as const, foliage: { cull: 50 } as never } : inst));
    expect(streamGroups({ ...withFoliage, instances }).map((g) => g.members)).toEqual([[1], [2], [3]]);
    expect(streamGroups({ ...withFoliage, instances, streaming: { range: 20 } }).map((g) => g.members)).toEqual([[1], [2]]);
  });
});

describe("the world partition in the editor", () => {
  it("draws the scene's cells, and which load with the focus where it is", () => {
    const stored = decodeMeshSidecar(sidecar({ range: 20, cell: 30 }))!;
    const cells = sidecarCells(stored, 30);
    expect(cells.map((c) => [c.i, c.members.length])).toEqual([[0, 1], [1, 1], [2, 1]]);
    expect(cellStates(cells, 20, [25, 0])).toEqual(["loaded", "loaded", "out"]);
    expect(cellStates(cells, 20, [55, 0])).toEqual(["out", "loaded", "loaded"]);
    // Just past range, inside the unload margin: held.
    // The crate at 70 reaches 70.5: 21.5 away is held (within 15% past 20), 24.5 away is out.
    expect(cellStates(cells, 20, [92, 0])[2]).toBe("held");
    expect(cellStates(cells, 20, [95, 0])[2]).toBe("out");
    // The cell size round-trips through the sidecar.
    expect(setMeshStreaming(stored, { range: 20, cell: 48 }).streaming).toEqual({ range: 20, cell: 48 });
  });
});
