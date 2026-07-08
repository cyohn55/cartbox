/**
 * Button-driven UI navigation, pure parts:
 *
 *  - Spatial focus picking: given the rectangle of the focused element and
 *    the rectangles of every candidate, choose which one a D-pad direction
 *    moves the cursor to. DOM-free so it's unit-testable; the React layer
 *    supplies real getBoundingClientRect() values.
 *
 *  - Konami detector: recognizes ↑↑↓↓←→←→BA on the shell buttons to hand the
 *    controls to the background mini-game.
 */

import type { ConsoleControl } from "./consoleInput";

export type CursorDirection = "up" | "down" | "left" | "right";

export interface FocusRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Center {
  x: number;
  y: number;
}

function centerOf(rect: FocusRect): Center {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Picks the candidate the cursor should move to, or -1 when none lies in that
 * direction. Scoring favors the nearest element along the pressed axis and
 * penalizes sideways drift, so grids, rows, and columns all feel right.
 */
export function pickNextFocus(
  current: FocusRect,
  candidates: readonly FocusRect[],
  direction: CursorDirection,
): number {
  const from = centerOf(current);
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let index = 0; index < candidates.length; index += 1) {
    const to = centerOf(candidates[index]!);
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    let forward: number;
    let sideways: number;
    switch (direction) {
      case "up":
        forward = -dy;
        sideways = Math.abs(dx);
        break;
      case "down":
        forward = dy;
        sideways = Math.abs(dx);
        break;
      case "left":
        forward = -dx;
        sideways = Math.abs(dy);
        break;
      case "right":
        forward = dx;
        sideways = Math.abs(dy);
        break;
    }

    if (forward < 1) {
      continue; // not in the pressed direction
    }
    const score = forward + sideways * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  }

  return best;
}

/** Index of the candidate nearest the top-left corner — the initial cursor. */
export function pickInitialFocus(candidates: readonly FocusRect[]): number {
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < candidates.length; index += 1) {
    const { x, y } = centerOf(candidates[index]!);
    const score = y * 3 + x;
    if (score < bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best;
}

/** The classic sequence, in shell-control terms. */
export const KONAMI_SEQUENCE: readonly ConsoleControl[] = [
  "up",
  "up",
  "down",
  "down",
  "left",
  "right",
  "left",
  "right",
  "b",
  "a",
];

/**
 * KMP failure table for the sequence, so overlapping attempts match
 * (↑↑↑↓↓←→←→BA completes: the extra ↑ keeps two steps of progress).
 */
const KONAMI_FALLBACK: number[] = (() => {
  const fallback = [0];
  let prefix = 0;
  for (let i = 1; i < KONAMI_SEQUENCE.length; i += 1) {
    while (prefix > 0 && KONAMI_SEQUENCE[i] !== KONAMI_SEQUENCE[prefix]) {
      prefix = fallback[prefix - 1]!;
    }
    if (KONAMI_SEQUENCE[i] === KONAMI_SEQUENCE[prefix]) {
      prefix += 1;
    }
    fallback.push(prefix);
  }
  return fallback;
})();

/**
 * Feed every button press in; `feed` returns true on the press that completes
 * the code. Mismatches fall back to the longest still-viable partial match
 * instead of discarding all progress.
 */
export class KonamiDetector {
  private progress = 0;

  feed(control: ConsoleControl): boolean {
    while (this.progress > 0 && control !== KONAMI_SEQUENCE[this.progress]) {
      this.progress = KONAMI_FALLBACK[this.progress - 1]!;
    }
    if (control === KONAMI_SEQUENCE[this.progress]) {
      this.progress += 1;
    }
    if (this.progress === KONAMI_SEQUENCE.length) {
      this.progress = 0;
      return true;
    }
    return false;
  }

  reset(): void {
    this.progress = 0;
  }
}
