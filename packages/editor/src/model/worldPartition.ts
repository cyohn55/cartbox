/**
 * World partition (AAA_FIDELITY_ROADMAP.md F6d): a streaming scene divided
 * into a grid of square cells on the ground plane, each loaded and unloaded
 * as a whole by its distance from the streaming focus.
 *
 * It builds on spatial loading (streaming.ts): the same groups (an object and
 * its children), the same range and unload margin, but a group belongs to the
 * cell its box's centre falls in, and a cell is what loads. A cell coming in
 * range is *requested*; its assets are prepared off the main thread (its
 * textures decoded in workers, its geometry uploaded) and only then is it
 * *loaded* and shown. At most a few cells prepare at once, nearest first, so
 * a fast-moving focus fills in around itself rather than across the map. A
 * cell leaving range (past the margin) unloads, cancelling a preparation in
 * flight, and gives its assets back.
 *
 * Distance is to the cell's box: the union of its groups' boxes, so a cell's
 * tall tower is in range when its top is. Groups are placed where they were
 * authored: something that moves stays in its first cell. Pure.
 */

import { STREAM_UNLOAD_MARGIN, boxDistance, type SceneStreaming, type StreamGroup } from "./streaming";

export const DEFAULT_CELL_SIZE = 64;
export const MIN_CELL_SIZE = 8;
export const MAX_CELL_SIZE = 1024;
/** Cells preparing at once, at most. */
export const MAX_CELLS_LOADING = 2;

/** A cell of the grid: its place, its box and its groups (indices into the stream groups). */
export interface WorldCell {
  readonly i: number;
  readonly j: number;
  readonly box: StreamGroup["box"];
  readonly groups: readonly number[];
  /** Every member of every group (scene instance indices). */
  readonly members: readonly number[];
}

/** Each group into the cell its box's centre falls in (on the ground plane); cells without groups aren't made. */
export function partitionWorld(groups: readonly StreamGroup[], size: number): WorldCell[] {
  const cell = Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, size));
  const byKey = new Map<string, { i: number; j: number; box: number[]; groups: number[]; members: number[] }>();
  groups.forEach((g, k) => {
    const i = Math.floor((g.box[0] + g.box[3]) / 2 / cell);
    const j = Math.floor((g.box[2] + g.box[5]) / 2 / cell);
    const key = `${i},${j}`;
    let c = byKey.get(key);
    if (!c) byKey.set(key, (c = { i, j, box: [...g.box], groups: [], members: [] }));
    for (let a = 0; a < 3; a += 1) {
      c.box[a] = Math.min(c.box[a]!, g.box[a]!);
      c.box[a + 3] = Math.max(c.box[a + 3]!, g.box[a + 3]!);
    }
    c.groups.push(k);
    c.members.push(...g.members);
  });
  return [...byKey.values()]
    .sort((a, b) => a.j - b.j || a.i - b.i)
    .map((c) => ({ i: c.i, j: c.j, box: c.box as unknown as StreamGroup["box"], groups: c.groups, members: c.members }));
}

export type CellState = "unloaded" | "loading" | "loaded";

/**
 * Which cells are in, as the focus moves. {@link update} returns the cells to
 * start preparing and those to unload; the caller says when a preparation
 * finished ({@link finished}), and the cell is then loaded.
 */
export class WorldPartition {
  private readonly states: CellState[];
  private readonly distances: number[];

  constructor(
    readonly cells: readonly WorldCell[],
    readonly streaming: SceneStreaming,
    private readonly maxLoading = MAX_CELLS_LOADING,
  ) {
    this.states = cells.map(() => "unloaded");
    this.distances = cells.map(() => Infinity);
  }

  /** Move the focus: the cells to start preparing (nearest first, within the budget) and those to unload. */
  update(focus: readonly [number, number, number]): { load: number[]; unload: number[] } {
    const { range } = this.streaming;
    const unload: number[] = [];
    const wanted: number[] = [];
    this.cells.forEach((cell, k) => {
      const d = boxDistance(focus, cell.box);
      this.distances[k] = d;
      const state = this.states[k]!;
      if (state !== "unloaded" && d > range * STREAM_UNLOAD_MARGIN) {
        this.states[k] = "unloaded";
        unload.push(k);
      } else if (state === "unloaded" && d <= range) wanted.push(k);
    });
    wanted.sort((a, b) => this.distances[a]! - this.distances[b]!);
    const room = Math.max(0, this.maxLoading - this.states.filter((s) => s === "loading").length);
    const load = wanted.slice(0, room);
    for (const k of load) this.states[k] = "loading";
    return { load, unload };
  }

  /** A preparation finished: the cell is loaded (unless it unloaded meanwhile). Returns whether it loaded. */
  finished(cell: number): boolean {
    if (this.states[cell] !== "loading") return false;
    this.states[cell] = "loaded";
    return true;
  }

  state(cell: number): CellState {
    return this.states[cell] ?? "unloaded";
  }

  /** The focus's distance to a cell at the last update. */
  distance(cell: number): number {
    return this.distances[cell] ?? Infinity;
  }

  /** Every member of every cell that isn't loaded (preparing counts as not yet). */
  unloaded(): Set<number> {
    const out = new Set<number>();
    this.cells.forEach((cell, k) => {
      if (this.states[k] !== "loaded") for (const m of cell.members) out.add(m);
    });
    return out;
  }
}
