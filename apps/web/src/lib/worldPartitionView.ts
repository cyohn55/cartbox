/**
 * The Mesh tab's view of the world partition (AAA_FIDELITY_ROADMAP.md F6d; see
 * worldPartition.ts in @cartbox/editor): the scene's cells, from its sidecar,
 * and which would be loaded with the focus at a point.
 */

import { STREAM_UNLOAD_MARGIN, WorldPartition, partitionWorld, type WorldCell } from "@cartbox/editor";
import { parseMeshScene, streamGroups } from "@cartbox/player";

import { encodeMeshSidecar, type MeshSidecar } from "./meshSidecar";

/** The scene's world partition cells, from its sidecar (none when nothing streams). */
export function sidecarCells(sidecar: MeshSidecar, cell: number): WorldCell[] {
  const encoded = encodeMeshSidecar(sidecar);
  const scene = encoded ? parseMeshScene(encoded) : null;
  return scene ? partitionWorld(streamGroups(scene), cell) : [];
}

/** Each cell's state for a focus on the ground plane: loaded within range, held (past range, inside the margin), out. */
export function cellStates(cells: readonly WorldCell[], range: number, focus: readonly [number, number]): ("loaded" | "held" | "out")[] {
  const world = new WorldPartition(cells, { range }, Infinity);
  // The focus at the cells' mean height: the map is from above.
  const y = cells.length > 0 ? cells.reduce((sum, c) => sum + (c.box[1] + c.box[4]) / 2, 0) / cells.length : 0;
  const at: [number, number, number] = [focus[0], y, focus[1]];
  world.update(at);
  cells.forEach((_, k) => world.finished(k));
  return cells.map((_, k) => (world.distance(k) <= range ? "loaded" : world.distance(k) <= range * STREAM_UNLOAD_MARGIN ? "held" : "out"));
}

