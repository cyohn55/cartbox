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

/** The nearest ancestor that scrolls, for a two-finger (or navigating one-finger) pan of a 2D view. */
export function scrollableParent(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (/(auto|scroll)/.test(style.overflow + style.overflowX + style.overflowY) && (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth)) return p;
  }
  return document.scrollingElement;
}

export interface GestureFilter<E extends Element> {
  /** Which presses the view takes (others, say on a child with handlers of its own, are left alone). Default all. */
  readonly accept?: (event: React.PointerEvent<E>) => boolean;
  /** Where the rest of a press it didn't take goes (a child's drag that bubbles up to the view's own handlers). */
  readonly passThrough?: {
    onPointerMove?: (event: React.PointerEvent<E>) => void;
    onPointerUp?: (event: React.PointerEvent<E>) => void;
    onPointerCancel?: (event: React.PointerEvent<E>) => void;
  };
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
  /** The fingers moving the view have lifted (or a Pencil took over). */
  onNavEnd?(el: E): void;
  onUndo?(): void;
  onRedo?(): void;
}

/**
 * Pointer handlers for a canvas: spread them on the element (it should have
 * `touch-action: none`). Options other than `fingers` (which the touch bar
 * sets) are the canvas's own: `drag` "orbit" for a 3D view, "pan" for 2D.
 */
export function useGestures<E extends Element>(handlers: GestureHandlers<E>, options: Omit<GestureOptions, "fingers"> & GestureFilter<E> = {}) {
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
        case "nav-end":
          h.onNavEnd?.(el);
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

  // Presses the view didn't take, whose moves and lifts go to `passThrough`.
  const passed = useRef(new Set<number>());
  const onPointerDown = (event: React.PointerEvent<E>) => {
    if (options.accept && !options.accept(event)) {
      passed.current.add(event.pointerId);
      return;
    }
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
    if (passed.current.has(event.pointerId)) return options.passThrough?.onPointerMove?.(event);
    element.current ??= event.currentTarget;
    dispatch(recognizer.current!.move(sample(event)));
  };
  const onPointerUp = (event: React.PointerEvent<E>) => {
    if (passed.current.delete(event.pointerId)) return options.passThrough?.onPointerUp?.(event);
    dispatch(recognizer.current!.up(sample(event)));
  };
  const onPointerCancel = (event: React.PointerEvent<E>) => {
    if (passed.current.delete(event.pointerId)) return (options.passThrough?.onPointerCancel ?? options.passThrough?.onPointerUp)?.(event);
    dispatch(recognizer.current!.cancel(sample(event)));
  };
  // The attribute marks a gesture surface, so the page never scrolls or zooms
  // under it (see the touch bar) and the stylesheet drops callouts there.
  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, "data-tablet-gestures": "" };
}

/**
 * An element whose pointer capture calls never throw: a view's own handlers
 * capture the pointer they are given, which for a tap (delivered when the
 * finger lifts) or a two-finger drag (a virtual pointer) no longer exists.
 */
const safeTargets = new WeakMap<Element, Element>();
function safeTarget<E extends Element>(el: E): E {
  let proxy = safeTargets.get(el);
  if (!proxy) {
    proxy = new Proxy(el, {
      get(target, key) {
        if (key === "setPointerCapture" || key === "releasePointerCapture") {
          return (id: number) => {
            try {
              target[key](id);
            } catch {
              // (no such pointer any more)
            }
          };
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    safeTargets.set(el, proxy);
  }
  return proxy as E;
}

/** A sample as the pointer event a view's mouse handlers read. */
export function asPointerEvent<E extends Element>(s: PointerSample, el: E, patch: Partial<Pick<PointerSample, "button" | "buttons" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">> = {}): React.PointerEvent<E> {
  const target = safeTarget(el);
  const merged = { ...s, ...patch };
  const event = {
    clientX: merged.x,
    clientY: merged.y,
    pageX: merged.x + (typeof window === "undefined" ? 0 : window.scrollX),
    pageY: merged.y + (typeof window === "undefined" ? 0 : window.scrollY),
    button: merged.button,
    buttons: merged.buttons,
    pointerId: merged.id,
    pointerType: merged.kind,
    pressure: merged.pressure,
    tiltX: merged.tiltX,
    tiltY: merged.tiltY,
    twist: merged.twist,
    shiftKey: merged.shiftKey,
    altKey: merged.altKey,
    ctrlKey: merged.ctrlKey,
    metaKey: merged.metaKey,
    currentTarget: target,
    target,
    timeStamp: merged.t,
    defaultPrevented: false,
    preventDefault() {},
    stopPropagation() {},
    isPropagationStopped: () => false,
    isDefaultPrevented: () => false,
  };
  return event as unknown as React.PointerEvent<E>;
}

/** The mouse drag that moves a view: which button, with which keys held. */
export interface NavDrag {
  readonly button?: number;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}

/** A view with mouse handlers of its own, and how its mouse navigates. */
export interface ViewHandlers<E extends Element> {
  onPointerDown?: (event: React.PointerEvent<E>) => void;
  onPointerMove?: (event: React.PointerEvent<E>) => void;
  onPointerUp?: (event: React.PointerEvent<E>) => void;
  /** Ends a drag without acting on it (a stroke a second finger cancelled, a finished two-finger drag). Default: the up handler. */
  onPointerCancel?: (event: React.PointerEvent<E>) => void;
  /** The drag that orbits the view (null: it has none). Default a left drag. */
  readonly orbitDrag?: NavDrag | null;
  /** The drag that pans the view (null: it has none). Default a middle drag. */
  readonly panDrag?: NavDrag | null;
  /** Overrides: by default a pinch is the wheel, and a long press a right click. */
  onZoom?(factor: number, x: number, y: number, el: E): void;
  onLongPress?(sample: PointerSample, el: E): void;
}

/** How much a pinch spreads (or closes) for one wheel notch. */
const NOTCH = 1.12;

/**
 * The tablet layer for a view that already has mouse handlers (TABLET_EDITOR_ROADMAP.md T3).
 * Its handlers keep doing what they do for the mouse and the Pencil (and for
 * one finger until a Pencil is used), and:
 *
 * - two fingers (or one, once a Pencil is used) move the view by driving its
 *   own navigation drag (`orbitDrag`, `panDrag`) with a virtual pointer, so
 *   orbit and pan feel exactly as with the mouse;
 * - a pinch turns the wheel there, a notch per 12% of spread, so it zooms as
 *   the wheel does;
 * - a long press is a right click (and opens a context menu if the view has one);
 * - a stroke a second finger turns into a gesture is ended without acting.
 */
export function useViewGestures<E extends Element>(view: ViewHandlers<E>, options: Omit<GestureOptions, "fingers"> & GestureFilter<E> = {}) {
  const latest = useRef(view);
  latest.current = view;
  const pinch = useRef(1);
  const nav = useRef<{ kind: "orbit" | "pan"; x: number; y: number; drag: NavDrag } | null>(null);

  const virtual = (v: { x: number; y: number; drag: NavDrag }, buttons: number): PointerSample => ({
    id: -1,
    kind: "touch",
    x: v.x,
    y: v.y,
    t: typeof performance === "undefined" ? 0 : performance.now(),
    button: v.drag.button ?? 0,
    buttons,
    pressure: buttons ? 0.5 : 0,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    shiftKey: v.drag.shiftKey ?? false,
    ctrlKey: false,
    metaKey: false,
    altKey: v.drag.altKey ?? false,
  });
  const endNav = (el: E) => {
    const v = nav.current;
    nav.current = null;
    if (!v) return;
    const h = latest.current;
    (h.onPointerCancel ?? h.onPointerUp)?.(asPointerEvent(virtual(v, 0), el));
  };
  const navigate = (kind: "orbit" | "pan", dx: number, dy: number, el: E) => {
    const h = latest.current;
    const drag = kind === "orbit" ? (h.orbitDrag === undefined ? { button: 0 } : h.orbitDrag) : h.panDrag === undefined ? { button: 1 } : h.panDrag;
    if (!drag) return;
    if (nav.current?.kind !== kind) {
      endNav(el);
      const rect = el.getBoundingClientRect();
      nav.current = { kind, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, drag };
      h.onPointerDown?.(asPointerEvent(virtual(nav.current, 1 << (drag.button === 1 ? 2 : drag.button === 2 ? 1 : 0)), el));
    }
    const v = nav.current!;
    v.x += dx;
    v.y += dy;
    h.onPointerMove?.(asPointerEvent(virtual(v, 1 << (drag.button === 1 ? 2 : drag.button === 2 ? 1 : 0)), el));
  };

  return useGestures<E>(
    {
      onToolDown: (s, el) => latest.current.onPointerDown?.(asPointerEvent(s, el)),
      onToolMove: (s, el) => latest.current.onPointerMove?.(asPointerEvent(s, el)),
      onToolUp: (s, el) => latest.current.onPointerUp?.(asPointerEvent(s, el)),
      onToolCancel: (el) => {
        const h = latest.current;
        const r = el.getBoundingClientRect();
        (h.onPointerCancel ?? h.onPointerUp)?.(asPointerEvent(virtual({ x: r.left, y: r.top, drag: {} }, 0), el));
      },
      onHover: (s, el) => latest.current.onPointerMove?.(asPointerEvent(s, el)),
      onOrbit: (dx, dy, el) => navigate("orbit", dx, dy, el),
      onPan: (dx, dy, el) => navigate("pan", dx, dy, el),
      onNavEnd: endNav,
      onZoom: (factor, x, y, el) => {
        if (latest.current.onZoom) return latest.current.onZoom(factor, x, y, el);
        pinch.current *= factor;
        while (pinch.current >= NOTCH || pinch.current <= 1 / NOTCH) {
          const closer = pinch.current > 1;
          pinch.current = closer ? pinch.current / NOTCH : pinch.current * NOTCH;
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: closer ? -100 : 100, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        }
      },
      onLongPress: (s, el) => {
        const h = latest.current;
        if (h.onLongPress) return h.onLongPress(s, el);
        h.onPointerDown?.(asPointerEvent(s, el, { button: 2, buttons: 2 }));
        h.onPointerUp?.(asPointerEvent(s, el, { button: 2, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("contextmenu", { clientX: s.x, clientY: s.y, button: 2, bubbles: true, cancelable: true }));
      },
    },
    options,
  );
}

// One long press at a time, for `longPressProps`.
let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
let pressFired = false;
const endPress = () => {
  if (press) clearTimeout(press.timer);
  press = null;
};

/**
 * A long press on a button (a finger or a Pencil held 500 ms) for what its
 * right-click does: iPad Safari never sends `contextmenu` for one. The click
 * that follows the press is swallowed. Spread on the button.
 */
export function longPressProps(onLongPress: (() => void) | undefined) {
  if (!onLongPress) return {};
  return {
    onPointerDown: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") return;
      endPress();
      pressFired = false;
      press = {
        x: event.clientX,
        y: event.clientY,
        timer: setTimeout(() => {
          press = null;
          pressFired = true;
          onLongPress();
        }, 500),
      };
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) endPress();
    },
    onPointerUp: endPress,
    onPointerCancel: endPress,
    onPointerLeave: endPress,
    onClickCapture: (event: React.MouseEvent) => {
      if (!pressFired) return;
      pressFired = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
