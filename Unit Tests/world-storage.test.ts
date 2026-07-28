/**
 * World build-layer persistence tests — the boundary that keeps what a player
 * built between visits. They drive the real {@link saveBuildLayer} /
 * {@link loadBuildLayer} against a real {@link BuildLayer} and a real in-memory
 * store (the same `getItem`/`setItem`/`removeItem` contract `localStorage`
 * implements), so the assertions are on stored bytes and restored blocks rather
 * than on calls to a mock. No DOM or `window` involved.
 */

import { describe, expect, it } from "vitest";

import {
  BUILD_LAYER_KEY,
  loadBuildLayer,
  saveBuildLayer,
  type KeyValueStore,
} from "../apps/web/src/lib/worldStorage";
import { BuildLayer, type WorldPoint } from "../apps/web/src/lib/worldEdit";

/** A real store honouring the Web Storage contract, backed by a Map. */
class MemoryStore implements KeyValueStore {
  private readonly entries = new Map<string, string>();

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  get size(): number {
    return this.entries.size;
  }
}

/** A store that refuses every write, as one at its quota (or in private mode) does. */
class FullStore extends MemoryStore {
  override setItem(): void {
    throw new Error("QuotaExceededError");
  }
}

const LATTICE = 7;

/** Build a layer with one block stacked on the cell above `(3, 3, 3)`. */
function layerWithBlock(material?: number): BuildLayer {
  const layer = new BuildLayer(LATTICE, LATTICE, LATTICE);
  const centre = layer.cellToWorld(3, 3, 3);
  const hit: WorldPoint = [centre[0], centre[1] + 0.5, centre[2]];
  layer.place(hit, [0, 1, 0], { r: 30, g: 60, b: 90 }, material);
  return layer;
}

describe("saveBuildLayer / loadBuildLayer", () => {
  it("carries a build across a fresh layer, as a new visit would", () => {
    const store = new MemoryStore();
    expect(saveBuildLayer(layerWithBlock(), store)).toBe(true);

    const next = new BuildLayer(LATTICE, LATTICE, LATTICE);
    expect(loadBuildLayer(next, store)).toBe(true);
    expect(next.count).toBe(1);
    expect(next.isFilled(3, 4, 3)).toBe(true);
  });

  it("stores under the shared key so an older save is replaced, not accumulated", () => {
    const store = new MemoryStore();
    saveBuildLayer(layerWithBlock(), store);
    saveBuildLayer(layerWithBlock(), store);
    expect(store.size).toBe(1);
    expect(store.getItem(BUILD_LAYER_KEY)).not.toBeNull();
  });

  it("remembers an emptied world by clearing the entry, not saving an empty grid", () => {
    const store = new MemoryStore();
    const layer = layerWithBlock();
    saveBuildLayer(layer, store);

    const placed = layer.cellToWorld(3, 4, 3);
    layer.remove([placed[0], placed[1] + 0.5, placed[2]], [0, 1, 0]);
    expect(layer.count).toBe(0);
    expect(saveBuildLayer(layer, store)).toBe(true);
    expect(store.getItem(BUILD_LAYER_KEY)).toBeNull();

    const next = new BuildLayer(LATTICE, LATTICE, LATTICE);
    expect(loadBuildLayer(next, store)).toBe(false);
    expect(next.count).toBe(0);
  });

  it("reports nothing loaded when there is no save, no storage, or a stale one", () => {
    const empty = new MemoryStore();
    expect(loadBuildLayer(new BuildLayer(LATTICE, LATTICE, LATTICE), empty)).toBe(false);
    expect(loadBuildLayer(new BuildLayer(LATTICE, LATTICE, LATTICE), null)).toBe(false);

    // A save made in a differently sized world is discarded rather than misplaced.
    const stale = new MemoryStore();
    saveBuildLayer(layerWithBlock(), stale);
    const resized = new BuildLayer(LATTICE + 2, LATTICE, LATTICE);
    expect(loadBuildLayer(resized, stale)).toBe(false);
    expect(resized.count).toBe(0);
  });

  it("survives a storage that refuses the write", () => {
    expect(saveBuildLayer(layerWithBlock(), new FullStore())).toBe(false);
    expect(saveBuildLayer(layerWithBlock(), null)).toBe(false);
  });

  it("keeps a textured block's material through the round trip", () => {
    const store = new MemoryStore();
    saveBuildLayer(layerWithBlock(4), store); // material 4 = a textured block

    const next = new BuildLayer(LATTICE, LATTICE, LATTICE);
    expect(loadBuildLayer(next, store)).toBe(true);
    const model = next.toPlacedModel()!;
    expect([...model.model.tile!]).toEqual([4]);
    // Textured blocks are stored white so the tile art shows as authored.
    expect([model.model.r[0], model.model.g[0], model.model.b[0]]).toEqual([255, 255, 255]);
  });
});
