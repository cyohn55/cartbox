/**
 * Persist a handheld chosen through the in-world OS customizer, using the same
 * storage the onboarding page (`HandheldPicker`) writes — so a handheld picked in
 * the voxel world is indistinguishable from one picked on the 2D screen, and the
 * console, cards and profile all read it unchanged.
 *
 * The OS customizer edits the real {@link HandheldConfig} (a `HandheldScheme` plus
 * the console-skin settings), so saving is a direct translation: the scheme +
 * marquee become the stored handheld, and the OS-skin fields become console
 * settings. Client-only (touches localStorage), so it lives apart from the pure
 * OS state machine and is called by the world component on "PICK".
 */

import { animatedPresetView } from "./handheldAnimated";
import { CUSTOM_PRESET_ID, type StoredHandheld } from "./handheld";
import { loadConsoleSettings, saveConsoleSettings } from "../app/console/consoleSettings";
import type { HandheldConfig } from "./cartboxOs";

/** Where the handheld choice is remembered (must match HandheldPicker). */
const LOCAL_HANDHELD_KEY = "cartbox.handheld";

/**
 * Translate the OS customizer's config into the stored handheld: a custom scheme,
 * plus the selected marquee's game id when one is set (resolved from the animated
 * preset registry, the same way the onboarding save does).
 */
export function buildStoredHandheld(config: HandheldConfig): StoredHandheld {
  const game = config.marquee ? animatedPresetView(config.marquee)?.game : undefined;
  return {
    presetId: CUSTOM_PRESET_ID,
    scheme: config.scheme,
    ...(game ? { animation: game } : {}),
  };
}

/**
 * Save the chosen handheld and OS-skin settings. Mirrors HandheldPicker's save:
 * the handheld goes to localStorage, and the terminal style/phosphor/scanlines
 * become the live console's settings with the handheld theme selected.
 */
export function saveHandheldChoice(config: HandheldConfig): void {
  try {
    window.localStorage.setItem(LOCAL_HANDHELD_KEY, JSON.stringify(buildStoredHandheld(config)));
  } catch {
    /* Storage unavailable (private mode); the choice simply isn't remembered. */
  }
  saveConsoleSettings({
    ...loadConsoleSettings(),
    theme: "handheld",
    osStyle: config.osStyle,
    osPhosphor: config.osPhosphor,
    osPhosphorColor: config.osPhosphorColor,
    osScanlines: config.osScanlines,
  });
}
