/**
 * EditHistory — a bounded undo/redo stack over immutable snapshots of some
 * editable state T. It is deliberately ignorant of what a snapshot contains: the
 * caller captures state into a T and restores state from a T, and EditHistory
 * only sequences those snapshots along a single timeline.
 *
 * The model is a linear timeline with a cursor. `record` appends a new present
 * (discarding any redo tail), while `undo`/`redo` move the cursor without losing
 * the surrounding snapshots. Keeping this pure (no timers, no DOM, no engine)
 * lets the same object back every editor tab and be unit-tested with plain
 * inputs and outputs.
 */

export interface EditHistoryOptions<T> {
  /** Cap on retained snapshots, including the baseline. Oldest are dropped first. */
  limit?: number;
  /**
   * Treats two snapshots as the same timeline state so that an idle "commit"
   * that produced no real change is not recorded. Defaults to reference identity.
   */
  equals?: (a: T, b: T) => boolean;
}

const DEFAULT_LIMIT = 50;

export class EditHistory<T> {
  private readonly snapshots: T[];
  private cursor: number;
  private readonly limit: number;
  private readonly equals: (a: T, b: T) => boolean;

  constructor(initial: T, options: EditHistoryOptions<T> = {}) {
    this.snapshots = [initial];
    this.cursor = 0;
    this.limit = Math.max(1, options.limit ?? DEFAULT_LIMIT);
    this.equals = options.equals ?? Object.is;
  }

  /**
   * The snapshot at the cursor — the state currently applied to the editor. The
   * cursor is kept within bounds by every mutator, so this is always defined.
   */
  current(): T {
    return this.at(this.cursor);
  }

  /** How many snapshots the timeline holds (baseline plus recorded edits). */
  size(): number {
    return this.snapshots.length;
  }

  canUndo(): boolean {
    return this.cursor > 0;
  }

  canRedo(): boolean {
    return this.cursor < this.snapshots.length - 1;
  }

  /**
   * Append `snapshot` as the new present, discarding any redo tail. A snapshot
   * equal to the current one is ignored, so coalesced commits that changed
   * nothing do not bloat the timeline. Returns true only when the timeline
   * actually advanced.
   */
  record(snapshot: T): boolean {
    if (this.equals(snapshot, this.at(this.cursor))) return false;
    // Drop any redo tail: recording after an undo forks a new future.
    this.snapshots.splice(this.cursor + 1);
    this.snapshots.push(snapshot);
    this.cursor = this.snapshots.length - 1;
    this.enforceLimit();
    return true;
  }

  /** Step back one snapshot and return it, or null when already at the oldest. */
  undo(): T | null {
    if (!this.canUndo()) return null;
    this.cursor -= 1;
    return this.at(this.cursor);
  }

  /** Step forward one snapshot and return it, or null when already at newest. */
  redo(): T | null {
    if (!this.canRedo()) return null;
    this.cursor += 1;
    return this.at(this.cursor);
  }

  private enforceLimit(): void {
    const overflow = this.snapshots.length - this.limit;
    if (overflow <= 0) return;
    this.snapshots.splice(0, overflow);
    this.cursor = Math.max(0, this.cursor - overflow);
  }

  /** Reads a snapshot the class invariants guarantee is present at `index`. */
  private at(index: number): T {
    const snapshot = this.snapshots[index];
    if (snapshot === undefined) {
      throw new RangeError(`EditHistory: no snapshot at index ${index}`);
    }
    return snapshot;
  }
}
