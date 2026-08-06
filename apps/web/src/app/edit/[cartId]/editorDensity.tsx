"use client";

/**
 * The editor's control-density preference — how much of each tab's inspector is
 * shown at rest.
 *
 * The rails had grown a long tail of infrequently-used controls sitting at the
 * same visual weight as the everyday ones, which made every tab read as busier
 * than the work in front of the creator actually was. Density is the one axis
 * that tames that: in **Simple** the advanced groups fold away to a single
 * heading each; in **Full** they open. It is a preference, not cart content, so
 * it lives here (context + a persisted preference) rather than in the undo
 * timeline, and it is read by {@link ./railControls RailGroup} deep in each tab
 * without any tab having to thread it through.
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";

/** How much of a tab's controls are shown at rest. */
export type EditorDensity = "simple" | "full";

/** New creators open in Simple so the editor is calm before it is complete. */
export const DEFAULT_DENSITY: EditorDensity = "simple";

const STORAGE_KEY = "cartbox.editor.density";

const EditorDensityContext = createContext<EditorDensity>(DEFAULT_DENSITY);

/** Provides the active density to every control below it. */
export const EditorDensityProvider = EditorDensityContext.Provider;

/** The active density. Advanced controls read this to decide their rest state. */
export function useEditorDensity(): EditorDensity {
  return useContext(EditorDensityContext);
}

/**
 * Resolve whether a group should start open.
 *
 * Kept pure and exported so the defaulting rule is asserted directly rather than
 * only through a mounted component: an explicit `defaultOpen` always wins; an
 * advanced group otherwise follows the density; a plain collapsible group rests
 * closed.
 */
export function resolveGroupOpen(
  density: EditorDensity,
  options: { advanced?: boolean; defaultOpen?: boolean },
): boolean {
  if (options.defaultOpen !== undefined) return options.defaultOpen;
  if (options.advanced) return density === "full";
  return false;
}

/**
 * The persisted density preference and a setter.
 *
 * Reads once on mount rather than during render so the server and first client
 * paint agree on {@link DEFAULT_DENSITY}; a stored "full" then applies without a
 * hydration mismatch. Writes are best-effort — a blocked localStorage costs the
 * persistence, not the toggle.
 */
export function useDensityPreference(): [EditorDensity, (density: EditorDensity) => void] {
  const [density, setDensity] = useState<EditorDensity>(DEFAULT_DENSITY);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "simple" || stored === "full") setDensity(stored);
    } catch {
      // No stored preference reachable — keep the default.
    }
  }, []);

  const update = useCallback((next: EditorDensity) => {
    setDensity(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persisting is best-effort; the in-session choice still holds.
    }
  }, []);

  return [density, update];
}
