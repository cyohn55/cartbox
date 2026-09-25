/**
 * Control settings a player can change from a game's Start menu: aim inversion,
 * look sensitivity, button mapping for a controller and the keyboard, and the
 * on-screen pad's size and opacity. Pure data plus the pure transforms the input
 * layer applies, so every piece is testable without a DOM or a gamepad.
 */

import { ConsoleButton } from "./types.js";

/**
 * A standard-mapping gamepad's buttons (an Xbox 360 / Xbox controller), in Gamepad API index order.
 * Guide (the big Xbox button) is reported by some browsers only.
 */
export const PAD_BUTTONS = [
  "A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "LS", "RS", "Up", "Down", "Left", "Right", "Guide",
] as const;
export type PadButton = (typeof PAD_BUTTONS)[number];

/** What a physical control does: press a console button, open the Start menu, or nothing. */
export type ControlTarget = ConsoleButton | "start" | null;

export interface ControlSettings {
  /** Invert the right stick's vertical axis (push up to aim down). */
  readonly invertY: boolean;
  /** Look sensitivity, 0.25..3: scales the right stick before the game reads it. */
  readonly lookSensitivity: number;
  /** Controller buttons → what they do. */
  readonly padBindings: Readonly<Record<PadButton, ControlTarget>>;
  /** Keyboard `KeyboardEvent.code` → console button. */
  readonly keyBindings: Readonly<Record<string, ConsoleButton>>;
  /** On-screen pad opacity, 0.2..1. */
  readonly touchOpacity: number;
  /** On-screen pad size, 0.7..1.4. */
  readonly touchScale: number;
}

/** Face buttons to face buttons, the D-pad to the D-pad, and the triggers doubling up. */
export const DEFAULT_PAD_BINDINGS: Readonly<Record<PadButton, ControlTarget>> = {
  A: ConsoleButton.A,
  B: ConsoleButton.B,
  X: ConsoleButton.X,
  Y: ConsoleButton.Y,
  LB: ConsoleButton.X,
  RB: ConsoleButton.Y,
  LT: ConsoleButton.X,
  RT: ConsoleButton.A,
  Back: "start",
  Start: "start",
  LS: null,
  RS: ConsoleButton.X,
  Up: ConsoleButton.Up,
  Down: ConsoleButton.Down,
  Left: ConsoleButton.Left,
  Right: ConsoleButton.Right,
  Guide: "start",
};

export const DEFAULT_KEY_BINDINGS: Readonly<Record<string, ConsoleButton>> = {
  ArrowUp: ConsoleButton.Up,
  ArrowDown: ConsoleButton.Down,
  ArrowLeft: ConsoleButton.Left,
  ArrowRight: ConsoleButton.Right,
  KeyZ: ConsoleButton.A,
  KeyX: ConsoleButton.B,
  KeyA: ConsoleButton.X,
  KeyS: ConsoleButton.Y,
};

/** Keys that open the Start menu (unless rebound to a console button). */
export const START_KEYS: readonly string[] = ["Escape", "Enter", "KeyP"];

export const DEFAULT_CONTROL_SETTINGS: ControlSettings = {
  invertY: false,
  lookSensitivity: 1,
  padBindings: DEFAULT_PAD_BINDINGS,
  keyBindings: DEFAULT_KEY_BINDINGS,
  touchOpacity: 0.85,
  touchScale: 1,
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isConsoleButton = (v: unknown): v is ConsoleButton => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 7;

/**
 * Read stored settings (e.g. from localStorage), keeping only valid fields and
 * falling back to the defaults for anything missing or malformed.
 */
export function parseControlSettings(value: unknown, defaults: ControlSettings = DEFAULT_CONTROL_SETTINGS): ControlSettings {
  if (typeof value !== "object" || value === null) return defaults;
  const raw = value as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
  const padBindings: Record<PadButton, ControlTarget> = { ...defaults.padBindings };
  if (typeof raw.padBindings === "object" && raw.padBindings !== null) {
    for (const [name, target] of Object.entries(raw.padBindings as Record<string, unknown>)) {
      if (!(PAD_BUTTONS as readonly string[]).includes(name)) continue;
      if (target === null || target === "start" || isConsoleButton(target)) padBindings[name as PadButton] = target;
    }
  }
  let keyBindings: Record<string, ConsoleButton> = { ...defaults.keyBindings };
  if (typeof raw.keyBindings === "object" && raw.keyBindings !== null) {
    const entries = Object.entries(raw.keyBindings as Record<string, unknown>).filter(
      (entry): entry is [string, ConsoleButton] => /^[A-Za-z0-9]{1,24}$/.test(entry[0]) && isConsoleButton(entry[1]),
    );
    if (entries.length > 0) keyBindings = Object.fromEntries(entries);
  }
  return {
    invertY: typeof raw.invertY === "boolean" ? raw.invertY : defaults.invertY,
    lookSensitivity: num(raw.lookSensitivity, 0.25, 3, defaults.lookSensitivity),
    padBindings,
    keyBindings,
    touchOpacity: num(raw.touchOpacity, 0.2, 1, defaults.touchOpacity),
    touchScale: num(raw.touchScale, 0.7, 1.4, defaults.touchScale),
  };
}

/**
 * The sticks as the game should see them: the right stick scaled by the look
 * sensitivity (reaching full lean sooner when it is above 1) and its vertical
 * axis flipped when aim is inverted. The left stick passes through.
 */
export function applyLookSettings(
  axes: readonly number[],
  settings: Pick<ControlSettings, "invertY" | "lookSensitivity">,
): [number, number, number, number] {
  const s = settings.lookSensitivity;
  const rx = clamp((axes[2] ?? 0) * s, -1, 1);
  const ry = clamp((axes[3] ?? 0) * s * (settings.invertY ? -1 : 1), -1, 1);
  return [axes[0] ?? 0, axes[1] ?? 0, rx, ry];
}

/** A physical stick reading with a radial dead zone, rescaled to reach full lean. */
export function deadZoned(x: number, y: number, deadZone = 0.18): [number, number] {
  const m = Math.hypot(x, y);
  if (m < deadZone) return [0, 0];
  const k = Math.min(1, (m - deadZone) / (1 - deadZone)) / m;
  return [x * k, y * k];
}

/** One gamepad snapshot (the fields the reader uses from the Gamepad API). */
export interface PadSnapshot {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

/**
 * A gamepad in the standard layout. Browsers remap most controllers to it
 * (`mapping: "standard"`), but some report a raw layout instead — Firefox on
 * Linux gives an Xbox 360 pad in evdev order (Back 6, Start 7, Guide 8, the
 * triggers and D-pad as axes), where Start would otherwise read as a trigger.
 * Known raw Xbox layouts are translated; anything else passes through as is.
 */
export function standardizePad<T extends PadSnapshot & { readonly mapping?: string; readonly id?: string }>(pad: T): PadSnapshot {
  if (pad.mapping === "standard" || pad.mapping === undefined) return pad;
  const xbox = /x-?box|xinput|045e|360/i.test(pad.id ?? "");
  if (!xbox || pad.buttons.length < 11 || pad.axes.length < 8) return pad;
  const b = (i: number) => pad.buttons[i] ?? { pressed: false, value: 0 };
  const axis = (i: number) => pad.axes[i] ?? 0;
  const synth = (down: boolean, value = down ? 1 : 0) => ({ pressed: down, value });
  // Triggers rest at -1 and reach 1 fully pulled.
  const trigger = (i: number) => {
    const value = (axis(i) + 1) / 2;
    return synth(value > 0.5, value);
  };
  return {
    axes: [axis(0), axis(1), axis(3), axis(4)],
    buttons: [
      b(0), b(1), b(2), b(3), b(4), b(5),
      trigger(2), trigger(5),
      b(6), b(7), b(9), b(10),
      synth(axis(7) < -0.5), synth(axis(7) > 0.5), synth(axis(6) < -0.5), synth(axis(6) > 0.5),
      b(8),
    ],
  };
}

/**
 * What a gamepad is doing: the console-button mask its bindings press, both
 * sticks (dead-zoned), and whether a control bound to "start" is held.
 */
export function readPad(
  raw: PadSnapshot & { readonly mapping?: string; readonly id?: string },
  bindings: Readonly<Record<PadButton, ControlTarget>>,
): { mask: number; axes: [number, number, number, number]; start: boolean } {
  const pad = standardizePad(raw);
  let mask = 0;
  let start = false;
  PAD_BUTTONS.forEach((name, index) => {
    const button = pad.buttons[index];
    // Triggers are analog; count them as pressed past half-way.
    const down = button ? button.pressed || button.value > 0.5 : false;
    if (!down) return;
    const target = bindings[name];
    if (target === "start") start = true;
    else if (target !== null && target !== undefined) mask |= 1 << target;
  });
  // An unbound Start still opens the menu when the mapping left nothing else on it.
  if (bindings.Start === null && !Object.values(bindings).includes("start") && pad.buttons[9]?.pressed) start = true;
  const [lx, ly] = deadZoned(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
  const [rx, ry] = deadZoned(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
  return { mask, axes: [lx, ly, rx, ry], start };
}
