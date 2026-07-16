"use client";

/**
 * The player's handheld skin (the region colours), shared reactively between the
 * settings panel — where they recolour it — and the image console, which renders
 * it. Mirrors ConsoleSettingsContext: SSR renders the default preset, the stored
 * skin applies after hydration, and every change persists to localStorage. When
 * a backend is present (the full app, not the static demo) changes also sync to
 * the profile, debounced so dragging a colour picker doesn't flood the API.
 */

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { handheldPreset, type HandheldGameId, type HandheldRegionId } from "@cartbox/editor";

import { authHeaders } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";
import {
  CUSTOM_PRESET_ID,
  CUSTOM_ART_PRESET_ID,
  defaultHandheld,
  normalizeHandheld,
  type HandheldArt,
  type StoredHandheld,
} from "@/lib/handheld";

/** localStorage key the onboarding picker and the console both read/write. */
const STORAGE_KEY = "cartbox.handheld";

/** How long after the last edit to sync the skin to the profile. */
const PROFILE_SYNC_DELAY_MS = 600;

interface HandheldSkinContextValue {
  /** The current skin (preset id + the applied region colours). */
  handheld: StoredHandheld;
  /** Recolour one region, marking the skin as custom (drops any custom art). */
  recolorRegion: (region: HandheldRegionId, color: string) => void;
  /** Replace the whole skin with a premade preset (drops any custom art). */
  applyPreset: (presetId: string) => void;
  /** Apply free-form pixel art drawn in the editor as the current skin. */
  applyCustomArt: (art: HandheldArt) => void;
  /**
   * Play a marquee animation on the chassis: the pre-rendered sheet is the
   * displayed art, and the scene id is recorded so the UI can show which is
   * active and recolouring can re-render it in the new colours.
   */
  applyAnimation: (art: HandheldArt, game: HandheldGameId) => void;
  /** Drop any custom art / animation, reverting to the recoloured scheme. */
  clearArt: () => void;
  /** Restore the default skin. */
  reset: () => void;
}

const HandheldSkinContext = createContext<HandheldSkinContextValue | null>(null);

/** Read the stored skin, coercing anything malformed to a valid one. */
function loadStoredHandheld(): StoredHandheld {
  if (typeof window === "undefined") return defaultHandheld();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeHandheld(JSON.parse(raw)) : defaultHandheld();
  } catch {
    return defaultHandheld();
  }
}

export function HandheldSkinProvider({ children }: { children: ReactNode }) {
  // SSR renders the default; the stored skin applies after hydration.
  const [handheld, setHandheld] = useState<StoredHandheld>(defaultHandheld());
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setHandheld(loadStoredHandheld());
    return () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, []);

  /** Persist a change: localStorage immediately, the profile debounced. */
  const persist = (next: StoredHandheld) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable (private mode); keep the in-memory change.
    }
    if (isStaticExport) return; // the static demo has no backend to sync to
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      void (async () => {
        try {
          await fetch("/api/console/me/handheld", {
            method: "PUT",
            headers: await authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ handheld: next }),
          });
        } catch {
          // Best-effort; localStorage already holds the authoritative copy.
        }
      })();
    }, PROFILE_SYNC_DELAY_MS);
  };

  const commit = (make: (current: StoredHandheld) => StoredHandheld) => {
    setHandheld((current) => {
      const next = make(current);
      persist(next);
      return next;
    });
  };

  const recolorRegion = (region: HandheldRegionId, color: string) =>
    commit((current) => ({ presetId: CUSTOM_PRESET_ID, scheme: { ...current.scheme, [region]: color } }));

  const applyPreset = (presetId: string) => {
    const preset = handheldPreset(presetId);
    commit(() => ({ presetId: preset.id, scheme: preset.scheme }));
  };

  // Keep the region scheme (so recolouring later still works) but flag the skin
  // as custom art; the console renders `art` in preference to the scheme.
  const applyCustomArt = (art: HandheldArt) =>
    commit((current) => ({ presetId: CUSTOM_ART_PRESET_ID, scheme: current.scheme, art }));

  const applyAnimation = (art: HandheldArt, game: HandheldGameId) =>
    commit((current) => ({ presetId: CUSTOM_ART_PRESET_ID, scheme: current.scheme, art, animation: game }));

  // Drop art/animation but keep the colours; mark the skin custom only if it was
  // previously custom-art (a premade keeps its own id).
  const clearArt = () =>
    commit((current) => ({
      presetId: current.presetId === CUSTOM_ART_PRESET_ID ? CUSTOM_PRESET_ID : current.presetId,
      scheme: current.scheme,
    }));

  const reset = () => commit(() => defaultHandheld());

  return (
    <HandheldSkinContext.Provider
      value={{ handheld, recolorRegion, applyPreset, applyCustomArt, applyAnimation, clearArt, reset }}
    >
      {children}
    </HandheldSkinContext.Provider>
  );
}

export function useHandheldSkin(): HandheldSkinContextValue {
  const value = useContext(HandheldSkinContext);
  if (!value) {
    throw new Error("useHandheldSkin must be used inside HandheldSkinProvider");
  }
  return value;
}
