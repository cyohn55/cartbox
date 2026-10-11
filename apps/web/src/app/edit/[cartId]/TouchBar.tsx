"use client";

/**
 * The touch bar (TABLET_EDITOR_ROADMAP.md T1): once touch or an Apple Pencil
 * is used, a small bar floats at the bottom of the editor with what a tablet
 * has no keys for — Add, Remove and Loop toggles that stand in for holding
 * Shift, Ctrl/⌘ and Alt on the next pick or box, what one finger does (draw,
 * navigate, or draw until a Pencil is used), and undo/redo.
 */

import { useEffect, useState } from "react";
import type React from "react";

import { tabletStore, useTablet, type FingerMode } from "@/lib/useTabletGestures";

const FINGER_LABEL: Record<FingerMode, string> = { auto: "Fingers: auto", draw: "Fingers draw", navigate: "Fingers navigate" };
const NEXT_FINGERS: Record<FingerMode, FingerMode> = { auto: "draw", draw: "navigate", navigate: "auto" };

const bar: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: "max(12px, env(safe-area-inset-bottom))",
  transform: "translateX(-50%)",
  zIndex: 900,
  display: "flex",
  gap: 6,
  padding: 6,
  borderRadius: 14,
  background: "rgba(16, 20, 32, 0.9)",
  boxShadow: "0 4px 18px rgba(0,0,0,0.35)",
  touchAction: "manipulation",
  userSelect: "none",
  WebkitUserSelect: "none",
};
const key = (on: boolean): React.CSSProperties => ({
  minWidth: 44,
  minHeight: 44,
  padding: "0 12px",
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.18)",
  background: on ? "#3a7bfd" : "rgba(255,255,255,0.06)",
  color: "#fff",
  fontSize: 14,
  fontWeight: on ? 600 : 400,
  whiteSpace: "nowrap",
  cursor: "pointer",
});
const divider: React.CSSProperties = { width: 1, background: "rgba(255,255,255,0.18)", margin: "4px 2px" };

export function TouchBar(): React.ReactElement | null {
  const tablet = useTablet();
  // Folded away to one button, for when the bar covers something (T4).
  const [folded, setFolded] = useState(false);
  // A touch or a Pencil anywhere in the editor shows the bar (and a Pencil
  // switches fingers to navigating), not only on the canvases that use them.
  useEffect(() => {
    const seen = (event: PointerEvent) => {
      if (event.pointerType === "touch") tabletStore.set({ tabletSeen: true });
      else if (event.pointerType === "pen") tabletStore.set({ tabletSeen: true, penSeen: true });
    };
    window.addEventListener("pointerdown", seen, { capture: true, passive: true });
    // No page zoom or scroll under the editor's gesture surfaces (T4): iPad
    // Safari can still pinch-zoom the page through `touch-action`, and only
    // cancelling its touch moves and its own gesture events stops that.
    // Elsewhere (panels, text) the page still zooms, for whoever needs it.
    const onSurface = (event: Event) => event.target instanceof Element && event.target.closest("canvas, [data-tablet-gestures]") !== null;
    const holdTouch = (event: TouchEvent) => {
      if (onSurface(event)) event.preventDefault();
    };
    const holdGesture = (event: Event) => {
      if (onSurface(event)) event.preventDefault();
    };
    document.addEventListener("touchmove", holdTouch, { passive: false });
    document.addEventListener("gesturestart", holdGesture);
    document.addEventListener("gesturechange", holdGesture);
    return () => {
      window.removeEventListener("pointerdown", seen, { capture: true });
      document.removeEventListener("touchmove", holdTouch);
      document.removeEventListener("gesturestart", holdGesture);
      document.removeEventListener("gesturechange", holdGesture);
    };
  }, []);
  if (!tablet.tabletSeen) return null;
  if (folded) {
    return (
      <div role="toolbar" aria-label="Touch controls" style={{ ...bar, left: "auto", right: "max(12px, env(safe-area-inset-right))", transform: "none" }}>
        <button type="button" style={key(false)} aria-label="Show the touch controls" title="Show the touch controls" onClick={() => setFolded(false)}>
          ⌃
        </button>
      </div>
    );
  }
  const mods = tablet.modifiers;
  const toggle = (name: keyof typeof mods) => tabletStore.set({ modifiers: { ...mods, [name]: !mods[name] } });
  return (
    <div role="toolbar" aria-label="Touch controls" style={bar}>
      <button type="button" style={key(mods.add)} aria-pressed={mods.add} title="Add to the selection (as holding Shift)" onClick={() => toggle("add")}>
        Add
      </button>
      <button type="button" style={key(mods.remove)} aria-pressed={mods.remove} title="Remove from the selection (as holding Ctrl or ⌘)" onClick={() => toggle("remove")}>
        Remove
      </button>
      <button type="button" style={key(mods.loop)} aria-pressed={mods.loop} title="Pick a whole loop (as holding Alt)" onClick={() => toggle("loop")}>
        Loop
      </button>
      <span style={divider} aria-hidden />
      <button
        type="button"
        style={key(tablet.fingers !== "auto")}
        title={
          tablet.fingers === "auto"
            ? "One finger draws until you use the Pencil, then navigates"
            : tablet.fingers === "draw"
              ? "One finger draws and picks; two fingers navigate"
              : "One finger navigates (taps still pick); draw with the Pencil"
        }
        onClick={() => tabletStore.set({ fingers: NEXT_FINGERS[tablet.fingers] })}
      >
        {FINGER_LABEL[tablet.fingers]}
      </button>
      <span style={divider} aria-hidden />
      <button type="button" style={key(false)} aria-label="Undo" title="Undo (or tap with two fingers)" onClick={() => tabletStore.undo()}>
        ↶
      </button>
      <button type="button" style={key(false)} aria-label="Redo" title="Redo (or tap with three fingers)" onClick={() => tabletStore.redo()}>
        ↷
      </button>
      <button type="button" style={key(false)} aria-label="Fold the touch controls away" title="Fold the touch controls away" onClick={() => setFolded(true)}>
        ⌄
      </button>
    </div>
  );
}
