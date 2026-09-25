/**
 * A player's settings for a game page (the Start menu): controls, audio and
 * display, kept in this browser. Pure helpers so the menu's logic is testable;
 * storage access is wrapped because it can be unavailable (private windows).
 */

import {
  ConsoleButton,
  DEFAULT_CONTROL_SETTINGS,
  DEFAULT_PAD_BINDINGS,
  parseControlSettings,
  type ControlSettings,
  type ControlTarget,
  type PadButton,
} from "@cartbox/player";

export interface GameSettings {
  readonly controls: ControlSettings;
  /** Master volume 0..1. */
  readonly volume: number;
  readonly muted: boolean;
  readonly showFps: boolean;
  /** Enter full screen when a game starts. */
  readonly fullscreen: boolean;
}

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  controls: DEFAULT_CONTROL_SETTINGS,
  volume: 0.8,
  muted: false,
  showFps: false,
  fullscreen: true,
};

export function parseGameSettings(value: unknown): GameSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_GAME_SETTINGS;
  const raw = value as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    controls: parseControlSettings(raw.controls),
    volume: typeof raw.volume === "number" && Number.isFinite(raw.volume) ? Math.max(0, Math.min(1, raw.volume)) : DEFAULT_GAME_SETTINGS.volume,
    muted: bool(raw.muted, DEFAULT_GAME_SETTINGS.muted),
    showFps: bool(raw.showFps, DEFAULT_GAME_SETTINGS.showFps),
    fullscreen: bool(raw.fullscreen, DEFAULT_GAME_SETTINGS.fullscreen),
  };
}

const key = (game: string) => `cartbox:settings:${game}`;

export function loadGameSettings(game: string, storage: Pick<Storage, "getItem"> | null = safeStorage()): GameSettings {
  try {
    const raw = storage?.getItem(key(game));
    return raw ? parseGameSettings(JSON.parse(raw)) : DEFAULT_GAME_SETTINGS;
  } catch {
    return DEFAULT_GAME_SETTINGS;
  }
}

export function saveGameSettings(game: string, settings: GameSettings, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(key(game), JSON.stringify(settings));
  } catch {
    // Storage full or blocked: the settings still apply for this session.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** One of a game's actions, as the Start menu names it. */
export interface GameAction {
  readonly button: ConsoleButton;
  readonly label: string;
}

/** Lockout's actions on the eight console buttons. */
export const LOCKOUT_ACTIONS: readonly GameAction[] = [
  { button: ConsoleButton.A, label: "Fire (melee up close)" },
  { button: ConsoleButton.B, label: "Jump" },
  { button: ConsoleButton.X, label: "Zoom / grenade (double-tap)" },
  { button: ConsoleButton.Y, label: "Swap weapon" },
  { button: ConsoleButton.Up, label: "Forward" },
  { button: ConsoleButton.Down, label: "Back" },
  { button: ConsoleButton.Left, label: "Turn / strafe left" },
  { button: ConsoleButton.Right, label: "Turn / strafe right" },
];

/** The Halo layout on an Xbox 360 controller: RT fires, A jumps, LT throws, Y swaps, a stick click zooms. */
export const HALO_PAD_BINDINGS: Readonly<Record<PadButton, ControlTarget>> = {
  ...DEFAULT_PAD_BINDINGS,
  A: ConsoleButton.B,
  B: ConsoleButton.A,
  X: ConsoleButton.Y,
  Y: ConsoleButton.Y,
  RT: ConsoleButton.A,
  LT: ConsoleButton.X,
  RB: ConsoleButton.Y,
  LB: ConsoleButton.X,
  RS: ConsoleButton.X,
};

export const PAD_PRESETS: readonly { readonly name: string; readonly bindings: Readonly<Record<PadButton, ControlTarget>> }[] = [
  { name: "Default (A = A)", bindings: DEFAULT_PAD_BINDINGS },
  { name: "Halo (RT fire, A jump)", bindings: HALO_PAD_BINDINGS },
];

/**
 * Bind `code` to `button` as that action's key: the action's previous keys go,
 * and the key leaves whatever action it had.
 */
export function rebindKey(
  bindings: Readonly<Record<string, ConsoleButton>>,
  code: string,
  button: ConsoleButton,
): Record<string, ConsoleButton> {
  const next: Record<string, ConsoleButton> = {};
  for (const [k, b] of Object.entries(bindings)) if (b !== button && k !== code) next[k] = b;
  next[code] = button;
  return next;
}

/** The keys bound to an action, for display ("KeyZ" → "Z", "ArrowUp" → "↑"). */
export function keysFor(bindings: Readonly<Record<string, ConsoleButton>>, button: ConsoleButton): string[] {
  return Object.entries(bindings)
    .filter(([, b]) => b === button)
    .map(([code]) => keyLabel(code));
}

export function keyLabel(code: string): string {
  const arrows: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
  if (arrows[code]) return arrows[code]!;
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}
