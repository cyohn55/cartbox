/**
 * Handheld personalization: shell theme, control layout, face-button colors,
 * and which mini-game lives behind the controls. Pure model + (de)serializer
 * here; persistence is localStorage on the client, with every stored value
 * normalized so bad or stale data can never break the shell.
 */

export const CONSOLE_THEMES = [
  { id: "indigo", label: "Indigo Workbench", blurb: "The Cartbox house look." },
  { id: "retro", label: "Retro Handheld", blurb: "Warm cream shell, classic maroon buttons." },
  { id: "sleek", label: "Sleek Clean", blurb: "Near-black glass, minimal lines." },
  { id: "arcade", label: "Arcade Shell", blurb: "Neon body with a mini-game living behind the buttons." },
] as const;
export type ConsoleThemeId = (typeof CONSOLE_THEMES)[number]["id"];

export const CONTROL_LAYOUTS = [
  { id: "dpad", label: "D-Pad" },
  { id: "joystick", label: "Joystick" },
  { id: "both", label: "Both" },
] as const;
export type ControlLayoutId = (typeof CONTROL_LAYOUTS)[number]["id"];

export const BUTTON_STYLES = [
  { id: "snes", label: "Four-color" },
  { id: "mono", label: "Monochrome" },
  { id: "amber", label: "Amber" },
  { id: "neon", label: "Neon" },
] as const;
export type ButtonStyleId = (typeof BUTTON_STYLES)[number]["id"];

/** "monthly" defers to the rotation; anything else pins a registry id. */
export type MiniGameChoice = "monthly" | string;

export interface ConsoleSettings {
  theme: ConsoleThemeId;
  controls: ControlLayoutId;
  buttons: ButtonStyleId;
  miniGame: MiniGameChoice;
}

export const DEFAULT_CONSOLE_SETTINGS: ConsoleSettings = {
  theme: "indigo",
  controls: "dpad",
  buttons: "snes",
  miniGame: "monthly",
};

function oneOf<T extends { id: string }>(list: readonly T[], value: unknown, fallback: T["id"]): T["id"] {
  return list.some((item) => item.id === value) ? (value as T["id"]) : fallback;
}

/** Normalizes anything (parsed JSON, stale schema, garbage) into settings. */
export function normalizeConsoleSettings(input: unknown): ConsoleSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    theme: oneOf(CONSOLE_THEMES, raw.theme, DEFAULT_CONSOLE_SETTINGS.theme),
    controls: oneOf(CONTROL_LAYOUTS, raw.controls, DEFAULT_CONSOLE_SETTINGS.controls),
    buttons: oneOf(BUTTON_STYLES, raw.buttons, DEFAULT_CONSOLE_SETTINGS.buttons),
    miniGame: typeof raw.miniGame === "string" && raw.miniGame.length > 0 ? raw.miniGame : "monthly",
  };
}

const STORAGE_KEY = "cartbox.console.settings";

export function loadConsoleSettings(): ConsoleSettings {
  if (typeof window === "undefined") {
    return DEFAULT_CONSOLE_SETTINGS;
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return normalizeConsoleSettings(stored ? JSON.parse(stored) : null);
  } catch {
    return DEFAULT_CONSOLE_SETTINGS;
  }
}

export function saveConsoleSettings(settings: ConsoleSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode / quota — settings just won't persist */
  }
}
