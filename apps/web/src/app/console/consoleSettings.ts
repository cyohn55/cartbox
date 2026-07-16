/**
 * Handheld personalization: shell theme, control layout, face-button colors,
 * and which mini-game lives behind the controls. Pure model + (de)serializer
 * here; persistence is localStorage on the client, with every stored value
 * normalized so bad or stale data can never break the shell.
 */

export const CONSOLE_THEMES = [
  { id: "handheld", label: "My Handheld", blurb: "The handheld you designed at signup." },
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

/**
 * The on-screen operating-system skin. This is a separate axis from the device
 * shell `theme` above: `theme` styles the physical handheld (bezel, buttons),
 * while `osStyle` restyles everything drawn *inside* the screen. "pipboy" is a
 * monochrome phosphor CRT terminal; "modern" is the full-colour Cartbox OS.
 */
export const OS_STYLES = [
  { id: "pipboy", label: "Pip-Boy Terminal", blurb: "Monochrome phosphor CRT — scanlines, glow and boot type." },
  { id: "modern", label: "Modern", blurb: "The clean, full-colour Cartbox interface." },
] as const;
export type OsStyleId = (typeof OS_STYLES)[number]["id"];

/** Phosphor tint for the terminal skin. */
export const OS_PHOSPHORS = [
  { id: "green", label: "Green" },
  { id: "amber", label: "Amber" },
] as const;
export type OsPhosphorId = (typeof OS_PHOSPHORS)[number]["id"];

/** "monthly" defers to the rotation; anything else pins a registry id. */
export type MiniGameChoice = "monthly" | string;

/** Per-face-button custom colors (hex), used when the player goes custom. */
export interface FaceButtonColors {
  x: string;
  y: string;
  a: string;
  b: string;
}

export interface ConsoleSettings {
  theme: ConsoleThemeId;
  controls: ControlLayoutId;
  buttons: ButtonStyleId;
  miniGame: MiniGameChoice;
  /** Swap the D-pad and joystick positions (handedness for single layouts). */
  swapControls: boolean;
  /** Custom colors override the preset; null = use the preset/theme. */
  faceColors: FaceButtonColors | null;
  dpadColor: string | null;
  joystickColor: string | null;
  /** On-screen OS skin (terminal vs modern) — independent of the shell `theme`. */
  osStyle: OsStyleId;
  /** Phosphor tint for the terminal skin. */
  osPhosphor: OsPhosphorId;
  /** Scanline overlay on the terminal skin (some players find it too busy). */
  osScanlines: boolean;
}

export const DEFAULT_CONSOLE_SETTINGS: ConsoleSettings = {
  // The player's pixel-art handheld is the default device; onboarding personalises
  // its colours, and the CSS themes below are opt-in alternatives.
  theme: "handheld",
  controls: "dpad",
  buttons: "snes",
  miniGame: "monthly",
  swapControls: false,
  faceColors: null,
  dpadColor: null,
  joystickColor: null,
  // The retro terminal is the house look for the OS screen; players can switch
  // back to "modern" from onboarding or the settings panel.
  osStyle: "pipboy",
  osPhosphor: "green",
  osScanlines: true,
};

function oneOf<T extends { id: string }>(list: readonly T[], value: unknown, fallback: T["id"]): T["id"] {
  return list.some((item) => item.id === value) ? (value as T["id"]) : fallback;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A valid 6-digit hex color, or null. */
export function normalizeHexColor(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : null;
}

function normalizeFaceColors(value: unknown): FaceButtonColors | null {
  const raw = (value ?? null) as Record<string, unknown> | null;
  if (!raw) {
    return null;
  }
  const x = normalizeHexColor(raw.x);
  const y = normalizeHexColor(raw.y);
  const a = normalizeHexColor(raw.a);
  const b = normalizeHexColor(raw.b);
  return x && y && a && b ? { x, y, a, b } : null;
}

/** Normalizes anything (parsed JSON, stale schema, garbage) into settings. */
export function normalizeConsoleSettings(input: unknown): ConsoleSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    theme: oneOf(CONSOLE_THEMES, raw.theme, DEFAULT_CONSOLE_SETTINGS.theme),
    controls: oneOf(CONTROL_LAYOUTS, raw.controls, DEFAULT_CONSOLE_SETTINGS.controls),
    buttons: oneOf(BUTTON_STYLES, raw.buttons, DEFAULT_CONSOLE_SETTINGS.buttons),
    miniGame: typeof raw.miniGame === "string" && raw.miniGame.length > 0 ? raw.miniGame : "monthly",
    swapControls: raw.swapControls === true,
    faceColors: normalizeFaceColors(raw.faceColors),
    dpadColor: normalizeHexColor(raw.dpadColor),
    joystickColor: normalizeHexColor(raw.joystickColor),
    osStyle: oneOf(OS_STYLES, raw.osStyle, DEFAULT_CONSOLE_SETTINGS.osStyle),
    osPhosphor: oneOf(OS_PHOSPHORS, raw.osPhosphor, DEFAULT_CONSOLE_SETTINGS.osPhosphor),
    // Default on; only an explicit `false` disables scanlines.
    osScanlines: raw.osScanlines !== false,
  };
}

/**
 * Darkens a hex color by a 0..1 factor — used to derive each control's
 * shadow/gradient stop from the single color the player picked.
 */
export function darkenHexColor(hex: string, factor: number): string {
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((pair) => {
    const scaled = Math.round(parseInt(pair, 16) * (1 - factor));
    return Math.max(0, Math.min(255, scaled)).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

/**
 * Inline CSS-variable overrides for the player's custom colors. Only set
 * variables for controls they actually customized, so presets/themes keep
 * styling the rest.
 */
export function customColorStyle(settings: ConsoleSettings): Record<string, string> {
  const style: Record<string, string> = {};
  if (settings.faceColors) {
    for (const key of ["x", "y", "a", "b"] as const) {
      const color = settings.faceColors[key];
      style[`--hh-face-${key}-hi`] = color;
      style[`--hh-face-${key}-lo`] = darkenHexColor(color, 0.35);
    }
  }
  if (settings.dpadColor) {
    style["--hh-dpad-a"] = settings.dpadColor;
    style["--hh-dpad-b"] = darkenHexColor(settings.dpadColor, 0.35);
  }
  if (settings.joystickColor) {
    style["--hh-joy-a"] = settings.joystickColor;
    style["--hh-joy-b"] = darkenHexColor(settings.joystickColor, 0.35);
  }
  return style;
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
