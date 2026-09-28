/**
 * Spatial loading (ENGINE_ROADMAP.md, Phase 4 — streaming within one map): a
 * big single map, where levels don't fit, loads its objects by distance
 * instead — like Unreal's World Partition. With streaming on, every object is
 * spatially loaded unless it's marked always loaded: it draws and simulates
 * only while the streaming focus (the camera, or a point the cart sets with
 * `cartbox.streamfocus`) is within `range` of it, and a published cart fetches
 * its textures as the focus approaches.
 *
 * - An object's children load with it; objects in a level are the level's to
 *   load, and reserve prefab copies and terrain are never spatially loaded.
 * - Distance is measured to the object's bounds (with its children), so a
 *   big floor stays loaded while you stand anywhere on it.
 * - A loaded object stays loaded until the focus is a little past the range
 *   ({@link STREAM_UNLOAD_MARGIN}), so standing on the boundary doesn't flicker.
 *
 * Stored on the mesh sidecar as `streaming: {range}`, and on an entry as
 * `alwaysLoaded: true`. Pure.
 */

export interface SceneStreaming {
  /** Loading distance, world units. */
  readonly range: number;
}

export const DEFAULT_STREAM_RANGE = 60;
export const MIN_STREAM_RANGE = 5;
export const MAX_STREAM_RANGE = 5000;
/** A loaded object unloads only past range × this. */
export const STREAM_UNLOAD_MARGIN = 1.15;
/** Textures are fetched from range × this, ahead of the object loading. */
export const STREAM_PREFETCH = 1.5;

/** Read stored streaming settings; null when absent or malformed (streaming off). */
export function readStreaming(value: unknown): SceneStreaming | null {
  if (!value || typeof value !== "object") return null;
  const range = (value as { range?: unknown }).range;
  if (typeof range !== "number" || !Number.isFinite(range)) return null;
  return { range: Math.max(MIN_STREAM_RANGE, Math.min(MAX_STREAM_RANGE, range)) };
}

/** A spatially loaded object and its children, and the box they fill. */
export interface StreamGroup {
  readonly members: readonly number[];
  /** World bounds: [minX, minY, minZ, maxX, maxY, maxZ]. */
  readonly box: readonly [number, number, number, number, number, number];
}

/** Distance from a point to a box (0 inside it). */
export function boxDistance(p: readonly [number, number, number], box: StreamGroup["box"]): number {
  const dx = Math.max(box[0] - p[0], 0, p[0] - box[3]);
  const dy = Math.max(box[1] - p[1], 0, p[1] - box[4]);
  const dz = Math.max(box[2] - p[2], 0, p[2] - box[5]);
  return Math.hypot(dx, dy, dz);
}

/**
 * Which spatially loaded groups are in, as the focus moves. Starts with none
 * loaded; the first {@link update} loads what's in range.
 */
export class SpatialLoader {
  private readonly loaded: boolean[];
  private readonly fetched: boolean[];
  private started = false;

  constructor(
    readonly groups: readonly StreamGroup[],
    readonly streaming: SceneStreaming,
  ) {
    this.loaded = groups.map(() => false);
    this.fetched = groups.map(() => false);
  }

  /**
   * Move the focus. Returns whether any group loaded or unloaded, and the
   * groups that came within prefetch range for the first time (their assets
   * should start loading).
   */
  update(focus: readonly [number, number, number]): { changed: boolean; approached: number[] } {
    const { range } = this.streaming;
    let changed = !this.started;
    this.started = true;
    const approached: number[] = [];
    this.groups.forEach((group, i) => {
      const d = boxDistance(focus, group.box);
      const inRange = this.loaded[i] ? d <= range * STREAM_UNLOAD_MARGIN : d <= range;
      if (inRange !== this.loaded[i]) {
        this.loaded[i] = inRange;
        changed = true;
      }
      if (!this.fetched[i] && d <= range * STREAM_PREFETCH) {
        this.fetched[i] = true;
        approached.push(i);
      }
    });
    return { changed, approached };
  }

  /** Whether a group is loaded. */
  isLoaded(group: number): boolean {
    return this.loaded[group] ?? false;
  }

  /** Every member of every group that isn't loaded. */
  unloaded(): Set<number> {
    const out = new Set<number>();
    this.groups.forEach((group, i) => {
      if (!this.loaded[i]) for (const m of group.members) out.add(m);
    });
    return out;
  }
}
