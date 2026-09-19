"use client";

/**
 * A floating, dockable tool palette.
 *
 * The sprite editor's tools used to be pinned in a fixed strip above the canvas.
 * This wraps that same content in a movable palette the creator controls: drag it
 * anywhere over the editor, snap it to any edge (top / right / bottom / left), or
 * collapse it to just its handle. Docking left or right stands the palette up into
 * a column; top, bottom and free-floating lay it out in a row.
 *
 * Purely chrome and placement — it renders whatever tools it is handed and owns
 * none of their state. Its own placement is remembered per-viewer in
 * localStorage, wrapped so a blocked or private store never breaks the editor.
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import styles from "./editor.module.css";

export type ToolbarDock = "top" | "bottom" | "left" | "right" | "free";

/** How close (px) a dragged edge must come to a bound before it snaps to it. */
const SNAP_PX = 56;

interface Persisted {
  dock: ToolbarDock;
  x: number;
  y: number;
  collapsed: boolean;
}

function loadState(key: string): Persisted | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    if (!parsed || typeof parsed !== "object") return null;
    const dock = parsed.dock;
    const valid: ToolbarDock[] = ["top", "bottom", "left", "right", "free"];
    return {
      dock: dock && valid.includes(dock) ? dock : "top",
      x: typeof parsed.x === "number" ? parsed.x : 24,
      y: typeof parsed.y === "number" ? parsed.y : 24,
      collapsed: Boolean(parsed.collapsed),
    };
  } catch {
    return null;
  }
}

function saveState(key: string, state: Persisted) {
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Private mode / blocked storage: placement just won't persist. Not fatal.
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/** The subset of a bounding rect the palette positions itself against. */
type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

interface FloatingToolbarProps {
  /** The region the palette lives in and snaps to — the sprite editor's body. */
  boundsRef: RefObject<HTMLElement | null>;
  /** Per-viewer key under which the placement is remembered. */
  storageKey: string;
  title?: string;
  children: ReactNode;
}

export function FloatingToolbar({ boundsRef, storageKey, title = "Tools", children }: FloatingToolbarProps) {
  const [dock, setDock] = useState<ToolbarDock>("top");
  const [pos, setPos] = useState({ x: 24, y: 24 });
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // Bumped to recompute the edge-anchored position after a resize.
  const [, forceTick] = useState(0);

  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  // Restore the saved placement once, on the client, so first paint matches SSR.
  useEffect(() => {
    const saved = loadState(storageKey);
    if (saved) {
      setDock(saved.dock);
      setPos({ x: saved.x, y: saved.y });
      setCollapsed(saved.collapsed);
    }
    setHydrated(true);
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated) return;
    saveState(storageKey, { dock, x: pos.x, y: pos.y, collapsed });
  }, [hydrated, storageKey, dock, pos, collapsed]);

  // Edge-anchored docks are positioned from the bounds rect, so re-measure when
  // the window resizes or the editor region scrolls under the palette.
  useEffect(() => {
    const onChange = () => forceTick((n) => n + 1);
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
    };
  }, []);

  const bounds = (): Rect => {
    const el = boundsRef.current;
    if (el) return el.getBoundingClientRect();
    // SSR / not-yet-mounted fallback — no DOMRect constructor on the server.
    const w = typeof window === "undefined" ? 1024 : window.innerWidth;
    const h = typeof window === "undefined" ? 768 : window.innerHeight;
    return { left: 0, top: 0, right: w, bottom: h, width: w, height: h };
  };

  const orientation = dock === "left" || dock === "right" ? "vertical" : "horizontal";

  const style: CSSProperties = (() => {
    const r = bounds();
    switch (dock) {
      case "top":
        return { left: r.left, top: r.top, width: r.width };
      case "bottom":
        return { left: r.left, top: r.bottom, width: r.width, transform: "translateY(-100%)" };
      case "left":
        return { left: r.left, top: r.top, height: r.height };
      case "right":
        return { left: r.right, top: r.top, height: r.height, transform: "translateX(-100%)" };
      case "free":
      default: {
        const w = barRef.current?.offsetWidth ?? 0;
        const h = barRef.current?.offsetHeight ?? 0;
        return { left: clamp(pos.x, r.left, r.right - w), top: clamp(pos.y, r.top, r.bottom - h) };
      }
    }
  })();

  const onGripDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.preventDefault();
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    // Float it at exactly where it currently sits, then follow the pointer.
    setDock("free");
    setPos({ x: rect.left, y: rect.top });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onGripMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    const r = bounds();
    const w = barRef.current?.offsetWidth ?? 0;
    const h = barRef.current?.offsetHeight ?? 0;
    const x = clamp(event.clientX - dragRef.current.dx, r.left, r.right - w);
    const y = clamp(event.clientY - dragRef.current.dy, r.top, r.bottom - h);
    setPos({ x, y });
  };

  const onGripUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // capture may already be gone
    }
    // Snap to the nearest edge it was dropped against, otherwise stay floating.
    const r = bounds();
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    const distances: Array<[ToolbarDock, number]> = [
      ["top", rect.top - r.top],
      ["bottom", r.bottom - rect.bottom],
      ["left", rect.left - r.left],
      ["right", r.right - rect.right],
    ];
    const [nearest, dist] = distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
    if (dist <= SNAP_PX) setDock(nearest);
  };

  const DOCK_BUTTONS: Array<{ id: ToolbarDock; glyph: string; label: string }> = [
    { id: "top", glyph: "⌃", label: "Dock to top" },
    { id: "bottom", glyph: "⌄", label: "Dock to bottom" },
    { id: "left", glyph: "‹", label: "Dock to left" },
    { id: "right", glyph: "›", label: "Dock to right" },
  ];

  return (
    <div
      ref={barRef}
      className={styles.floatBar}
      style={style}
      data-orient={orientation}
      data-collapsed={collapsed || undefined}
      role="toolbar"
      aria-label={title}
      aria-orientation={orientation}
    >
      <div
        className={styles.floatBarHead}
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        title="Drag to move — release near an edge to dock"
      >
        <span className={styles.floatBarGrip} aria-hidden>
          ⠿
        </span>
        <span className={styles.floatBarTitle}>{title}</span>
        <div className={styles.floatBarDocks}>
          {DOCK_BUTTONS.map((button) => (
            <button
              key={button.id}
              type="button"
              className={styles.floatBarDockBtn}
              data-active={dock === button.id || undefined}
              // Don't let the grip's drag handler start when a dock button is tapped.
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setDock(button.id)}
              title={button.label}
              aria-label={button.label}
              aria-pressed={dock === button.id}
            >
              {button.glyph}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.floatBarToggle}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? "Expand tools" : "Collapse tools"}
          aria-label={collapsed ? "Expand tools" : "Collapse tools"}
          aria-expanded={!collapsed}
        >
          {collapsed ? "▸" : "▾"}
        </button>
      </div>

      {!collapsed && <div className={styles.floatBarBody}>{children}</div>}
    </div>
  );
}
