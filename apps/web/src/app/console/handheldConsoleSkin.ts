/**
 * Map a chosen handheld skin (the seven region colours) onto the console shell's
 * CSS custom properties, so the live handheld the player uses adopts the look
 * they designed at signup. This drives the "My Handheld" console theme.
 *
 * Pure: given a scheme it returns inline CSS-variable overrides. Each colour is
 * validated and its darker gradient stop derived with the console's own
 * `darkenHexColor`, so a malformed scheme just leaves that variable to the theme.
 */

import type { HandheldScheme } from "@cartbox/editor";

import { darkenHexColor, normalizeHexColor } from "./consoleSettings";

/** How much darker each control's second gradient stop is than its base. */
const CONTROL_SHADE = 0.35;

/**
 * CSS-variable overrides that repaint the shell in the handheld's colours:
 * chassis → shell body + outer glow, D-pad panel → control base, D-pad →
 * D-pad/joystick, buttons → the four face buttons, button letters →
 * face-button ink.
 */
export function handheldConsoleVariables(scheme: HandheldScheme): Record<string, string> {
  const style: Record<string, string> = {};

  const chassis = normalizeHexColor(scheme.face);
  if (chassis) {
    style["--hh-shell-a"] = chassis;
    style["--hh-shell-b"] = darkenHexColor(chassis, 0.22);
    style["--hh-shell-c"] = darkenHexColor(chassis, 0.4);
    style["--hh-outer-a"] = darkenHexColor(chassis, 0.5);
    style["--hh-outer-b"] = darkenHexColor(chassis, 0.72);
  }

  const control = normalizeHexColor(scheme.dpadPanel);
  if (control) {
    style["--hh-control-a"] = control;
    style["--hh-control-b"] = darkenHexColor(control, CONTROL_SHADE);
  }

  const dpad = normalizeHexColor(scheme.dpad);
  if (dpad) {
    style["--hh-dpad-a"] = dpad;
    style["--hh-dpad-b"] = darkenHexColor(dpad, CONTROL_SHADE);
    style["--hh-joy-a"] = dpad;
    style["--hh-joy-b"] = darkenHexColor(dpad, CONTROL_SHADE);
  }

  const ink = normalizeHexColor(scheme.buttonLetter);
  if (ink) style["--hh-face-ink"] = ink;

  const face = normalizeHexColor(scheme.buttonColor);
  if (face) {
    for (const key of ["x", "y", "a", "b"] as const) {
      style[`--hh-face-${key}-hi`] = face;
      style[`--hh-face-${key}-lo`] = darkenHexColor(face, CONTROL_SHADE);
    }
  }

  return style;
}

/** localStorage key the onboarding screen writes the chosen handheld to. */
export const STORED_HANDHELD_KEY = "cartbox.handheld";

/**
 * Read the scheme the player saved at onboarding from localStorage, or null when
 * absent/unreadable. Kept tiny and dependency-free so it is safe to call during
 * render on the client.
 */
export function readStoredHandheldScheme(): Partial<HandheldScheme> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORED_HANDHELD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { scheme?: Partial<HandheldScheme> } | null;
    return parsed?.scheme ?? null;
  } catch {
    return null;
  }
}
