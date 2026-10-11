"use client";

/**
 * The tablet input layer in React (TABLET_EDITOR_ROADMAP.md T1): a store the
 * editor shares — whether touch or a Pencil has been used (which shows the
 * touch bar), the touch bar's modifier toggles and finger setting, and the
 * editor's undo/redo — and `useGestures`, which feeds a canvas's pointer
 * events through a {@link GestureRecognizer} and calls back with what they
 * mean.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type React from "react";

import { GestureRecognizer, NO_MODIFIERS, samplePointer, withModifiers, type GestureOptions, type PointerSample, type TouchModifiers } from "./tabletInput";

export type FingerMode = "auto" | "draw" | "navigate";

export interface TabletState {
  /** A Pencil has been used in this page: one finger navigates (with fingers "auto"). */
  readonly penSeen: boolean;
  /** Touch or a Pencil has been used: the touch bar shows. */
  readonly tabletSeen: boolean;
  readonly modifiers: TouchModifiers;
  readonly fingers: FingerMode;
}

let state: TabletState = { penSeen: false, tabletSeen: false, modifiers: NO_MODIFIERS, fingers: "auto" };
const listeners = new Set<() => void>();
let commands: { undo?: () => void; redo?: () => void } = {};

export const tabletStore = {
  get: (): TabletState => state,
  set(patch: Partial<TabletState>): void {
    const next = { ...state, ...patch };
    if (Object.keys(patch).every((k) => next[k as keyof TabletState] === state[k as keyof TabletState])) return;
    state = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** The editor's undo and redo, for two- and three-finger taps and the touch bar. */
  setCommands(next: { undo?: () => void; redo?: () => void }): void {
    commands = next;
  },
  undo: (): void => commands.undo?.(),
  redo: (): void => commands.redo?.(),
};

export function useTablet(): TabletState {
  return useSyncExternalStore(tabletStore.subscribe, tabletStore.get, tabletStore.get);
}

/** What a canvas does with its pointers; any left out are ignored (undo/redo default to the editor's). */
export interface GestureHandlers<E extends Element> {
  onToolDown?(sample: PointerSample, el: E): void;
  onToolMove?(sample: PointerSample, el: E): void;
  onToolUp?(sample: PointerSample, el: E): void;
  /** The stroke under way is abandoned: undo what it did so far. */
  onToolCancel?(el: E): void;
  onHover?(sample: PointerSample, el: E): void;
  onOrbit?(dx: number, dy: number, el: E): void;
  onPan?(dx: number, dy: number, el: E): void;
  /** Zoom by `factor` (above 1: closer) about the page point (x, y). */
  onZoom?(factor: number, x: number, y: number, el: E): void;
  onLongPress?(sample: PointerSample, el: E): void;
  onUndo?(): void;
  onRedo?(): void;
}

/**
 * Pointer handlers for a canvas: spread them on the element (it should have
 * `touch-action: none`). Options other than `fingers` (which the touch bar
 * sets) are the canvas's own: `drag` "orbit" for a 3D view, "pan" for 2D.
 */
export function useGestures<E extends Element>(handlers: GestureHandlers<E>, options: Omit<GestureOptions, "fingers"> = {}) {
  const tablet = useTablet();
  const recognizer = useRef<GestureRecognizer | null>(null);
  recognizer.current ??= new GestureRecognizer();
  recognizer.current.setOptions({ ...options, fingers: tablet.fingers });
  // The latest handlers, so the timer and the events always reach the current render's closures.
  const latest = useRef(handlers);
  latest.current = handlers;
  const element = useRef<E | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dispatch = useCallback((events: ReturnType<GestureRecognizer["down"]>) => {
    const h = latest.current;
    const el = element.current;
    if (!el) return;
    for (const event of events) {
      switch (event.type) {
        case "tool-down":
          h.onToolDown?.(event.sample, el);
          break;
        case "tool-move":
          h.onToolMove?.(event.sample, el);
          break;
        case "tool-up":
          h.onToolUp?.(event.sample, el);
          break;
        case "tool-cancel":
          h.onToolCancel?.(el);
          break;
        case "hover":
          h.onHover?.(event.sample, el);
          break;
        case "orbit":
          h.onOrbit?.(event.dx, event.dy, el);
          break;
        case "pan":
          h.onPan?.(event.dx, event.dy, el);
          break;
        case "zoom":
          h.onZoom?.(event.factor, event.x, event.y, el);
          break;
        case "long-press":
          h.onLongPress?.(event.sample, el);
          break;
        case "undo":
          (h.onUndo ?? tabletStore.undo)();
          break;
        case "redo":
          (h.onRedo ?? tabletStore.redo)();
          break;
      }
    }
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const sample = (event: React.PointerEvent<E>): PointerSample => withModifiers(samplePointer(event.nativeEvent), tabletStore.get().modifiers);

  const onPointerDown = (event: React.PointerEvent<E>) => {
    element.current = event.currentTarget;
    const s = sample(event);
    if (s.kind !== "mouse") tabletStore.set({ tabletSeen: true, ...(s.kind === "pen" ? { penSeen: true } : {}) });
    const rec = recognizer.current!;
    rec.penSeen = rec.penSeen || tabletStore.get().penSeen;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // (a synthetic or already-released pointer)
    }
    if (s.kind !== "mouse") event.preventDefault();
    dispatch(rec.down(s));
    if (s.kind === "touch") {
      if (timer.current) clearTimeout(timer.current);
      const at = s.t;
      timer.current = setTimeout(() => dispatch(rec.tick(at + (options.longPressMs ?? 500) + 1)), (options.longPressMs ?? 500) + 20);
    }
  };
  const onPointerMove = (event: React.PointerEvent<E>) => {
    element.current ??= event.currentTarget;
    dispatch(recognizer.current!.move(sample(event)));
  };
  const onPointerUp = (event: React.PointerEvent<E>) => {
    dispatch(recognizer.current!.up(sample(event)));
  };
  const onPointerCancel = (event: React.PointerEvent<E>) => {
    dispatch(recognizer.current!.cancel(sample(event)));
  };
  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
