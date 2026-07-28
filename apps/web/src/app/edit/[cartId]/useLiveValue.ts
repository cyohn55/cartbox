"use client";

/**
 * React's side of {@link createLiveValue}: bind a prop and its setter to a live
 * cell, so listeners and animation loops can write the value many times between
 * two commits without overwriting each other.
 *
 * All the reasoning lives in the cell, which is pure and tested; this is only the
 * wiring. The one React-specific decision is *when* to offer the prop back: it
 * has to be during render, before any listener registered this pass can read the
 * cell, which is why `receive` is called in the component body rather than in an
 * effect.
 */

import { useCallback, useRef } from "react";

import { createLiveValue, type LiveValue } from "@/lib/liveValue";

export function useLiveValue<T>(
  value: T,
  onChange: (next: T) => void,
  isSame?: (a: T, b: T) => boolean,
): [LiveValue<T>, (change: (current: T) => T) => T] {
  // The callback is read through a ref so the cell — which is created once —
  // never holds a stale closure over an older setter.
  const emit = useRef(onChange);
  emit.current = onChange;

  const cell = useRef<LiveValue<T> | null>(null);
  if (cell.current === null) {
    cell.current = createLiveValue(value, (next) => emit.current(next), isSame);
  }
  cell.current.receive(value);

  const update = useCallback((change: (current: T) => T) => cell.current!.update(change), []);
  return [cell.current, update];
}
