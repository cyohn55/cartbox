/**
 * DeltaHistory (AAA_PRODUCTION_ROADMAP.md W1): undo and redo that keep the
 * present whole and every other step as a delta, within a memory budget
 * rather than a fixed count.
 *
 * EditHistory keeps each step as a full snapshot, so a cart's 60 steps cost
 * 60 copies of its banks however small each edit was. Here a step costs what
 * changed: `diff(to, from)` makes the patch that turns one state into
 * another, `apply` replays it, and `size` says what it costs. Steps are
 * forgotten oldest first once the total passes the budget, however many
 * there are.
 *
 * The same interface as EditHistory (current, record, undo, redo, canUndo,
 * canRedo, size), so a caller swaps one for the other.
 */

export interface DeltaCodec<T, D> {
  /** The patch that, applied to `from`, gives `to`. */
  diff(to: T, from: T): D;
  apply(from: T, patch: D): T;
  /** What a patch costs, in bytes (an estimate is fine). */
  size(patch: D): number;
}

export interface DeltaHistoryOptions<T> {
  /** Bytes the undo and redo steps may hold together. */
  budget?: number;
  equals?: (a: T, b: T) => boolean;
}

const DEFAULT_BUDGET = 64 * 1024 * 1024;

export class DeltaHistory<T, D> {
  private present: T;
  /** Patches back toward the past, newest last; and forward toward the future, nearest last. */
  private readonly back: { patch: D; bytes: number }[] = [];
  private readonly forward: { patch: D; bytes: number }[] = [];
  private bytes = 0;
  private readonly budget: number;
  private readonly equals: (a: T, b: T) => boolean;

  constructor(
    initial: T,
    private readonly codec: DeltaCodec<T, D>,
    options: DeltaHistoryOptions<T> = {},
  ) {
    this.present = initial;
    this.budget = Math.max(0, options.budget ?? DEFAULT_BUDGET);
    this.equals = options.equals ?? Object.is;
  }

  current(): T {
    return this.present;
  }

  /** Steps held (the present counts as one, as in EditHistory). */
  size(): number {
    return 1 + this.back.length + this.forward.length;
  }

  /** Bytes the steps hold. */
  memory(): number {
    return this.bytes;
  }

  canUndo(): boolean {
    return this.back.length > 0;
  }

  canRedo(): boolean {
    return this.forward.length > 0;
  }

  record(next: T): boolean {
    if (this.equals(next, this.present)) return false;
    for (const f of this.forward) this.bytes -= f.bytes;
    this.forward.length = 0;
    const patch = this.codec.diff(this.present, next);
    const bytes = this.codec.size(patch);
    this.back.push({ patch, bytes });
    this.bytes += bytes;
    this.present = next;
    // Over budget: forget the oldest steps (always keeping the newest one, so one undo works).
    while (this.bytes > this.budget && this.back.length > 1) this.bytes -= this.back.shift()!.bytes;
    return true;
  }

  undo(): T | null {
    const step = this.back.pop();
    if (!step) return null;
    this.bytes -= step.bytes;
    const previous = this.codec.apply(this.present, step.patch);
    const patch = this.codec.diff(this.present, previous);
    const bytes = this.codec.size(patch);
    this.forward.push({ patch, bytes });
    this.bytes += bytes;
    this.present = previous;
    return previous;
  }

  redo(): T | null {
    const step = this.forward.pop();
    if (!step) return null;
    this.bytes -= step.bytes;
    const next = this.codec.apply(this.present, step.patch);
    const patch = this.codec.diff(this.present, next);
    const bytes = this.codec.size(patch);
    this.back.push({ patch, bytes });
    this.bytes += bytes;
    this.present = next;
    return next;
  }
}

/** A patch between two byte arrays: the target's length, and the runs where it differs from the source. */
export interface BytesPatch {
  readonly length: number;
  readonly runs: readonly { readonly at: number; readonly bytes: Uint8Array }[];
}

/** The runs of `to` that differ from `from` (runs closer than 16 bytes merged, so a scattered edit isn't a run per byte). */
export function diffBytes(to: Uint8Array, from: Uint8Array): BytesPatch {
  const runs: { at: number; bytes: Uint8Array }[] = [];
  let start = -1;
  let lastDiff = -1;
  for (let i = 0; i < to.length; i += 1) {
    const differs = i >= from.length || to[i] !== from[i];
    if (differs) {
      if (start < 0) start = i;
      lastDiff = i;
    } else if (start >= 0 && i - lastDiff > 16) {
      runs.push({ at: start, bytes: to.slice(start, lastDiff + 1) });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ at: start, bytes: to.slice(start, lastDiff + 1) });
  return { length: to.length, runs };
}

export function applyBytes(from: Uint8Array, patch: BytesPatch): Uint8Array {
  const out = new Uint8Array(patch.length);
  out.set(from.subarray(0, Math.min(from.length, patch.length)));
  for (const run of patch.runs) out.set(run.bytes, run.at);
  return out;
}

export function bytesPatchSize(patch: BytesPatch): number {
  return 16 + patch.runs.reduce((n, r) => n + 16 + r.bytes.length, 0);
}
