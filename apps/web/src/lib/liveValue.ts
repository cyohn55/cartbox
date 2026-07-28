/**
 * A value that is written faster than the thing storing it can catch up.
 *
 * A 3D camera has more than one writer at once — an animation loop stepping
 * movement, a pointer listener turning the view, a wheel listener zooming — and
 * between them they fire far more often than React commits. The obvious shape
 * for that (mirror the prop into a ref, read the ref, call the setter) hides a
 * race that is easy to miss and miserable to use: between one writer calling the
 * setter and the re-render arriving, the ref still holds the *old* value, so the
 * next writer computes from stale state and its update replaces the first one
 * wholesale. Hold a movement key while moving the mouse and the two fight —
 * whichever writes last in a frame is the only one that happened.
 *
 * The fix is to stop treating the stored copy as the source of truth *between*
 * updates. This cell is the live value: every writer updates it synchronously and
 * then announces the result. A value offered from outside is adopted only when it
 * is not simply an echo of something this cell already emitted — which is exactly
 * when the outside really is the authority (a button that moved the camera, a
 * mode switch, a reset).
 *
 * Pure and framework-free, because the rule above is the part worth testing and
 * a hook is a poor place to test it from.
 */

/** A live cell: read `current`, write through `update`, sync with `receive`. */
export interface LiveValue<T> {
  /** The value now, including updates the store has not caught up with yet. */
  readonly current: T;
  /** Apply a change to the live value and announce it. Returns the new value. */
  update(change: (current: T) => T): T;
  /** Offer a value from outside. Ignored when it is an echo of our own. */
  receive(value: T): void;
}

/**
 * How many announced-but-not-yet-echoed updates to remember. Renders lag by a
 * frame or two at worst, so this is generous; the cap only exists so a store that
 * stops echoing entirely cannot grow the list without bound.
 */
const MAX_PENDING = 64;

/**
 * Create a live cell.
 *
 * `isSame` decides whether an incoming value is one this cell announced or
 * something genuinely new. Identity is the right test whenever the store keeps
 * exactly the object it is handed; a field-by-field comparison is needed when it
 * does not (React props rebuilt from separate numbers, for instance).
 */
export function createLiveValue<T>(
  initial: T,
  emit: (next: T) => void,
  isSame: (a: T, b: T) => boolean = Object.is,
): LiveValue<T> {
  let live = initial;
  // Everything announced that the store has not echoed back yet, oldest first.
  //
  // Comparing against only the *latest* announcement is not enough, and the way
  // it fails is the original bug in miniature: a store can catch up with an
  // older update while newer ones are still in flight, and treating that echo as
  // an external value rewinds the cell — after which the next writer computes
  // from stale state again. Keeping the queue means an echo says "caught up this
  // far" rather than "go back".
  const pending: T[] = [];

  return {
    get current(): T {
      return live;
    },
    update(change: (current: T) => T): T {
      const next = change(live);
      live = next;
      pending.push(next);
      if (pending.length > MAX_PENDING) pending.shift();
      emit(next);
      return next;
    },
    receive(value: T): void {
      const echoed = pending.findIndex((entry) => isSame(value, entry));
      if (echoed >= 0) {
        pending.splice(0, echoed + 1);
        return;
      }
      pending.length = 0;
      live = value;
    },
  };
}
