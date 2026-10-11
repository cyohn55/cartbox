/**
 * Control settings a player can change from a game's Start menu: how each stick
 * reads (dead zones, max input), how lean becomes look (sensitivity per axis,
 * inversion, a response curve), the stick layout, the triggers' pull, button
 * mapping for a controller and the keyboard, and the on-screen pad's size and
 * opacity (CONTROLLER_SETTINGS_ROADMAP.md). Pure data plus the pure transforms
 * the input layer applies, so every piece is testable without a DOM or a gamepad.
 */

import { parseActionRebinds, type ActionRebind } from "@cartbox/editor";

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

/**
 * How a physical stick reads (C1), as Halo Infinite's thumbstick settings have it.
 * Each value is a share of the stick's travel, 0..1.
 */
export interface StickDeadZones {
  /** Each axis ignores lean below this on its own (so a push straight up stays straight up). */
  readonly axial: number;
  /** Lean below this distance from the centre reads as none. */
  readonly radial: number;
  /** Lean past this reads as full: a stick that never quite reaches its edge still can. */
  readonly maxInput: number;
}

/**
 * How look-stick lean becomes look (C1). Standard passes it as it comes; the
 * others reshape its distance from centre, keeping its direction:
 * - dynamic: an S-curve, fine near the centre, steepest mid-way, settling at the edge;
 * - precision: slower near the centre (lean²), for fine aim;
 * - responsive: quicker off the centre (√lean).
 */
export type ResponseCurve = "standard" | "dynamic" | "precision" | "responsive";
export const RESPONSE_CURVES: readonly ResponseCurve[] = ["standard", "dynamic", "precision", "responsive"];

/**
 * Which stick moves and which looks (C1), as Call of Duty names them:
 * - default: the left stick moves and strafes, the right one looks;
 * - southpaw: swapped;
 * - legacy: the left stick moves forward and back and turns, the right one strafes and looks up and down;
 * - legacySouthpaw: legacy, swapped.
 */
export type StickLayout = "default" | "southpaw" | "legacy" | "legacySouthpaw";
export const STICK_LAYOUTS: readonly StickLayout[] = ["default", "southpaw", "legacy", "legacySouthpaw"];

/**
 * How much a game helps the player aim (C3), read by the cart through
 * cartbox.aimassist() as 0, 1 or 2. What each level does is the game's; in
 * Lockout, off stops the auto-aim's nudge once you aim by hand, standard is how
 * it always played, and strong nudges harder and slows turning across a target.
 */
export type AimAssist = "off" | "standard" | "strong";
export const AIM_ASSISTS: readonly AimAssist[] = ["off", "standard", "strong"];

/** The devices that can look, each with its own look profile (C4). */
export type LookDevice = "controller" | "touch" | "mouse";

/**
 * A device's own look tuning (C4): its sensitivity per axis and response
 * curve. The controller's are the top-level settings; inversion, zoom
 * sensitivity, look acceleration and aim assist are the player's, shared.
 */
export interface LookProfile {
  readonly sensitivity: number;
  readonly sensitivityY: number;
  readonly curve: ResponseCurve;
}

/**
 * The mouse starts on Responsive: a game that eases its stick turn (as
 * Lockout does, by lean²) then turns in step with the mouse.
 */
export const DEFAULT_MOUSE_LOOK: LookProfile = { sensitivity: 1, sensitivityY: 1, curve: "responsive" };

export interface ControlSettings {
  /** Invert the look vertical axis (push up to aim down). */
  readonly invertY: boolean;
  /** Invert the look horizontal axis (push right to turn left). */
  readonly invertX?: boolean;
  /** Horizontal look sensitivity, 0.25..3: scales the look stick's x before the game reads it. */
  readonly lookSensitivity: number;
  /** Vertical look sensitivity, 0.25..3 (absent: the same as horizontal, as before there were two). */
  readonly lookSensitivityY?: number;
  /** How look-stick lean becomes look. */
  readonly lookCurve?: ResponseCurve;
  /** The physical left and right sticks' dead zones (absent: a 0.18 radial dead zone, as always). */
  readonly leftStick?: StickDeadZones;
  readonly rightStick?: StickDeadZones;
  /** Which stick moves and which looks. */
  readonly stickLayout?: StickLayout;
  /**
   * Look speed while zoomed, ×0.25..2 (C2): multiplies both sensitivities, in a
   * game that reads its look gain (cartbox.lookgain), while it says it is zoomed.
   */
  readonly zoomSensitivity?: number;
  /**
   * Look acceleration, 0..1 (C2), as Halo has it: held at full lean, look speeds
   * up after a short delay, by up to this much more (0 is off). Only a game that
   * reads its look gain can turn faster than full lean, so only there.
   */
  readonly lookAcceleration?: number;
  /** The touch pad's look stick, tuned apart from a controller's (C4; absent: the controller's, as before). */
  readonly touchLook?: LookProfile;
  /** Mouse look (C4): click the game to capture the mouse, and it looks; its own tuning. */
  readonly mouseLook?: LookProfile;
  readonly mouseCapture?: boolean;
  /** How much the game helps aim (C3). */
  readonly aimAssist?: AimAssist;
  /** Input actions (by name) that toggle on a press instead of acting while held (C3). */
  readonly actionToggles?: readonly string[];
  /** Vibration on a controller (and a phone's buzz for strong ones) when the game asks (C3). */
  readonly vibration?: boolean;
  /** How strong vibration is, 0.1..1. */
  readonly vibrationStrength?: number;
  /** How far (0.05..0.95) the left and right triggers must be pulled to press. */
  readonly leftTrigger?: number;
  readonly rightTrigger?: number;
  /** Controller buttons → what they do. */
  readonly padBindings: Readonly<Record<PadButton, ControlTarget>>;
  /** Keyboard `KeyboardEvent.code` → console button. */
  readonly keyBindings: Readonly<Record<string, ConsoleButton>>;
  /** On-screen pad opacity, 0.2..1. */
  readonly touchOpacity: number;
  /** On-screen pad size, 0.7..1.4. */
  readonly touchScale: number;
  /** The player's rebinding of the cart's input actions (EP15), by action name; absent = the cart's own. */
  readonly actionBindings?: Readonly<Record<string, ActionRebind>>;
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

/** A stick as the player always read it: a 0.18 radial dead zone, full lean at the edge. */
export const DEFAULT_STICK_DEAD_ZONES: StickDeadZones = { axial: 0, radial: 0.18, maxInput: 1 };
/** Triggers press past half-way, as they always did. */
export const DEFAULT_TRIGGER_THRESHOLD = 0.5;

export const DEFAULT_CONTROL_SETTINGS: ControlSettings = {
  invertY: false,
  invertX: false,
  lookSensitivity: 1,
  lookSensitivityY: 1,
  lookCurve: "standard",
  leftStick: DEFAULT_STICK_DEAD_ZONES,
  rightStick: DEFAULT_STICK_DEAD_ZONES,
  stickLayout: "default",
  zoomSensitivity: 1,
  lookAcceleration: 0,
  touchLook: { sensitivity: 1, sensitivityY: 1, curve: "standard" },
  mouseLook: DEFAULT_MOUSE_LOOK,
  mouseCapture: false,
  aimAssist: "standard",
  actionToggles: [],
  vibration: true,
  vibrationStrength: 1,
  leftTrigger: DEFAULT_TRIGGER_THRESHOLD,
  rightTrigger: DEFAULT_TRIGGER_THRESHOLD,
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
  const lookSensitivity = num(raw.lookSensitivity, 0.25, 3, defaults.lookSensitivity);
  const curveOf = (v: unknown, fallback: ResponseCurve): ResponseCurve => ((RESPONSE_CURVES as readonly unknown[]).includes(v) ? (v as ResponseCurve) : fallback);
  const profile = (v: unknown, fallback: LookProfile): LookProfile => {
    if (typeof v !== "object" || v === null) return fallback;
    const p = v as Record<string, unknown>;
    const sensitivity = num(p.sensitivity, 0.25, 3, fallback.sensitivity);
    return { sensitivity, sensitivityY: num(p.sensitivityY, 0.25, 3, p.sensitivity !== undefined ? sensitivity : fallback.sensitivityY), curve: curveOf(p.curve, fallback.curve) };
  };
  const deadZones = (v: unknown, fallback: StickDeadZones | undefined): StickDeadZones => {
    const base = fallback ?? DEFAULT_STICK_DEAD_ZONES;
    if (typeof v !== "object" || v === null) return base;
    const z = v as Record<string, unknown>;
    const radial = num(z.radial, 0, 0.5, base.radial);
    return {
      axial: num(z.axial, 0, 0.5, base.axial),
      radial,
      // Full lean must lie past the dead zone.
      maxInput: Math.max(radial + 0.1, num(z.maxInput, 0.5, 1, base.maxInput)),
    };
  };
  const lookSensitivityY =
    raw.lookSensitivityY !== undefined
      ? num(raw.lookSensitivityY, 0.25, 3, defaults.lookSensitivityY ?? lookSensitivity)
      : raw.lookSensitivity !== undefined
        ? lookSensitivity
        : (defaults.lookSensitivityY ?? lookSensitivity);
  const lookCurve = curveOf(raw.lookCurve, defaults.lookCurve ?? "standard");
  return {
    invertY: typeof raw.invertY === "boolean" ? raw.invertY : defaults.invertY,
    invertX: typeof raw.invertX === "boolean" ? raw.invertX : (defaults.invertX ?? false),
    lookSensitivity,
    // Saved before there were two: vertical follows horizontal.
    lookSensitivityY,
    lookCurve,
    // Saved before touch had its own: the controller's, as it played.
    touchLook: profile(raw.touchLook, raw.touchLook === undefined && raw.lookSensitivity !== undefined ? { sensitivity: lookSensitivity, sensitivityY: lookSensitivityY, curve: lookCurve } : (defaults.touchLook ?? { sensitivity: 1, sensitivityY: 1, curve: "standard" })),
    mouseLook: profile(raw.mouseLook, defaults.mouseLook ?? DEFAULT_MOUSE_LOOK),
    mouseCapture: typeof raw.mouseCapture === "boolean" ? raw.mouseCapture : (defaults.mouseCapture ?? false),
    leftStick: deadZones(raw.leftStick, defaults.leftStick),
    rightStick: deadZones(raw.rightStick, defaults.rightStick),
    stickLayout: (STICK_LAYOUTS as readonly unknown[]).includes(raw.stickLayout) ? (raw.stickLayout as StickLayout) : (defaults.stickLayout ?? "default"),
    zoomSensitivity: num(raw.zoomSensitivity, 0.25, 2, defaults.zoomSensitivity ?? 1),
    lookAcceleration: num(raw.lookAcceleration, 0, 1, defaults.lookAcceleration ?? 0),
    aimAssist: (AIM_ASSISTS as readonly unknown[]).includes(raw.aimAssist) ? (raw.aimAssist as AimAssist) : (defaults.aimAssist ?? "standard"),
    actionToggles: Array.isArray(raw.actionToggles)
      ? [...new Set(raw.actionToggles.filter((n): n is string => typeof n === "string" && n.length > 0 && n.length <= 64))].slice(0, 32)
      : (defaults.actionToggles ?? []),
    vibration: typeof raw.vibration === "boolean" ? raw.vibration : (defaults.vibration ?? true),
    vibrationStrength: num(raw.vibrationStrength, 0.1, 1, defaults.vibrationStrength ?? 1),
    leftTrigger: num(raw.leftTrigger, 0.05, 0.95, defaults.leftTrigger ?? DEFAULT_TRIGGER_THRESHOLD),
    rightTrigger: num(raw.rightTrigger, 0.05, 0.95, defaults.rightTrigger ?? DEFAULT_TRIGGER_THRESHOLD),
    padBindings,
    keyBindings,
    touchOpacity: num(raw.touchOpacity, 0.2, 1, defaults.touchOpacity),
    touchScale: num(raw.touchScale, 0.7, 1.4, defaults.touchScale),
    ...(raw.actionBindings !== undefined
      ? { actionBindings: parseActionRebinds(raw.actionBindings) }
      : defaults.actionBindings
        ? { actionBindings: defaults.actionBindings }
        : {}),
  };
}

/** A look-stick lean's distance from centre (0..1) through a response curve. */
export function responseCurve(curve: ResponseCurve | undefined, m: number): number {
  const t = clamp(m, 0, 1);
  switch (curve) {
    case "dynamic":
      return t * t * (3 - 2 * t);
    case "precision":
      return t * t;
    case "responsive":
      return Math.sqrt(t);
    default:
      return t;
  }
}

/**
 * The sticks as the game should see them. The move stick passes through. The
 * look stick goes through its response curve (its distance from centre,
 * keeping its direction), then each axis is scaled by its sensitivity
 * (reaching full lean sooner when it is above 1) and flipped when inverted.
 * With `scale` false (a game that reads its look gain, C2), sensitivity is
 * left to the gain and the stick is only curved and inverted.
 */
export function applyLookSettings(
  axes: readonly number[],
  settings: Pick<ControlSettings, "invertY" | "lookSensitivity"> & Partial<Pick<ControlSettings, "invertX" | "lookSensitivityY" | "lookCurve">>,
  scale = true,
): [number, number, number, number] {
  let x = axes[2] ?? 0;
  let y = axes[3] ?? 0;
  const m = Math.hypot(x, y);
  if (m > 0 && settings.lookCurve && settings.lookCurve !== "standard") {
    const k = responseCurve(settings.lookCurve, m) / m;
    x *= k;
    y *= k;
  }
  const sx = scale ? settings.lookSensitivity : 1;
  const sy = scale ? (settings.lookSensitivityY ?? settings.lookSensitivity) : 1;
  const rx = clamp(x * sx * (settings.invertX ? -1 : 1), -1, 1);
  const ry = clamp(y * sy * (settings.invertY ? -1 : 1), -1, 1);
  return [axes[0] ?? 0, axes[1] ?? 0, rx, ry];
}

/** Look acceleration (C2): how long the look stick must be held at full lean before it ramps, and how long the ramp takes, in ticks. */
export const LOOK_ACCEL_DELAY_TICKS = 9;
export const LOOK_ACCEL_RAMP_TICKS = 30;
/** How far the look stick must lean to count as full lean for acceleration. */
export const LOOK_ACCEL_LEAN = 0.95;

/** Ticks the look stick has been held at full lean, after this tick's look (x, y). */
export function stepLookAcceleration(heldTicks: number, x: number, y: number): number {
  return Math.hypot(x, y) >= LOOK_ACCEL_LEAN ? heldTicks + 1 : 0;
}

/** The look speed multiplier (1 up to 1 + strength) after `heldTicks` at full lean. */
export function lookAccelerationBoost(heldTicks: number, strength: number | undefined): number {
  if (!strength || strength <= 0) return 1;
  const t = clamp((heldTicks - LOOK_ACCEL_DELAY_TICKS) / LOOK_ACCEL_RAMP_TICKS, 0, 1);
  return 1 + strength * t * t * (3 - 2 * t);
}

/**
 * The look gains a game reading cartbox.lookgain gets (C2): each axis's
 * sensitivity times the acceleration boost, and the zoom multiplier.
 */
export function lookGains(
  settings: Pick<ControlSettings, "lookSensitivity"> & Partial<Pick<ControlSettings, "lookSensitivityY" | "zoomSensitivity">>,
  boost = 1,
): { x: number; y: number; zoom: number } {
  return {
    x: settings.lookSensitivity * boost,
    y: (settings.lookSensitivityY ?? settings.lookSensitivity) * boost,
    zoom: settings.zoomSensitivity ?? 1,
  };
}

/**
 * The look settings for the device doing the looking (C4): its own
 * sensitivity and curve over the player's shared inversion and zoom.
 */
export function lookProfileFor(settings: ControlSettings, device: LookDevice): ControlSettings {
  const own = device === "touch" ? settings.touchLook : device === "mouse" ? (settings.mouseLook ?? DEFAULT_MOUSE_LOOK) : undefined;
  if (!own) return settings;
  return { ...settings, lookSensitivity: own.sensitivity, lookSensitivityY: own.sensitivityY, lookCurve: own.curve };
}

/** How far the mouse moves in a tick (px) for full lean (C4), before sensitivity. */
export const MOUSE_FULL_LEAN_PX = 12;

/** A tick's mouse movement as look-stick lean (each −1..1). */
export function mouseLean(dx: number, dy: number, fullPx = MOUSE_FULL_LEAN_PX): [number, number] {
  return [clamp(dx / fullPx, -1, 1), clamp(dy / fullPx, -1, 1)];
}

/** The aim assist level a cart reads (0 off, 1 standard, 2 strong). */
export function aimAssistLevel(assist: AimAssist | undefined): number {
  const i = AIM_ASSISTS.indexOf(assist ?? "standard");
  return i < 0 ? 1 : i;
}

/** The action bits (bit i = action i) the player has set to toggle. */
export function toggleMask(actions: readonly { readonly name: string }[], toggles: readonly string[] | undefined): number {
  if (!toggles || toggles.length === 0) return 0;
  let mask = 0;
  actions.forEach((a, i) => {
    if (i < 32 && toggles.includes(a.name)) mask |= 1 << i;
  });
  return mask >>> 0;
}

/**
 * Hold or toggle per action (C3): a toggled action flips on each press of its
 * controls and stays as it was left; the rest act while held. `raw` and
 * `previous` are the controls held now and last tick; `latched` the toggled
 * actions now on. Returns what the game sees and the new latch.
 */
export function applyActionToggles(raw: number, previous: number, latched: number, toggles: number): { held: number; latched: number } {
  const pressed = raw & ~previous;
  const next = (latched ^ (pressed & toggles)) & toggles;
  return { held: ((raw & ~toggles) | next) >>> 0, latched: next >>> 0 };
}

/** A rumble a game asked for, as the Gamepad API plays it (null: none). */
export interface RumbleEffect {
  readonly duration: number;
  readonly strongMagnitude: number;
  readonly weakMagnitude: number;
}

/** The longest rumble a game can ask for, ms. */
export const RUMBLE_MAX_MS = 1500;

/**
 * The effect for a game's cartbox.rumble(strength, ms) under the player's
 * vibration settings: none when vibration is off or the request is empty. The
 * heavy motor carries the strength; the light one buzzes under it.
 */
export function rumbleEffect(strength: number, ms: number, settings: Partial<Pick<ControlSettings, "vibration" | "vibrationStrength">>): RumbleEffect | null {
  if (settings.vibration === false) return null;
  const s = clamp(strength, 0, 1) * clamp(settings.vibrationStrength ?? 1, 0, 1);
  const duration = Math.round(clamp(ms, 0, RUMBLE_MAX_MS));
  if (s <= 0 || duration <= 0) return null;
  return { duration, strongMagnitude: s, weakMagnitude: Math.min(1, s * 0.6 + 0.1) };
}

/** A physical stick reading with a radial dead zone, rescaled to reach full lean. */
export function deadZoned(x: number, y: number, deadZone = 0.18): [number, number] {
  return shapeStick(x, y, { axial: 0, radial: deadZone, maxInput: 1 });
}

/**
 * A physical stick reading through its dead zones (C1). First each axis on its
 * own past the axial dead zone, then the stick's distance from centre between
 * the radial dead zone and the max input threshold, both rescaled so lean just
 * past a dead zone reads just above nothing and the threshold reads full.
 */
export function shapeStick(x: number, y: number, zones: StickDeadZones): [number, number] {
  const axis = (v: number) => {
    const a = Math.abs(v);
    if (zones.axial <= 0) return v;
    return a <= zones.axial ? 0 : (Math.sign(v) * (a - zones.axial)) / (1 - zones.axial);
  };
  const ax = axis(x);
  const ay = axis(y);
  const m = Math.hypot(ax, ay);
  if (m <= zones.radial || m === 0) return [0, 0];
  const span = Math.max(1e-6, zones.maxInput - zones.radial);
  const k = Math.min(1, (m - zones.radial) / span) / m;
  return [ax * k, ay * k];
}

/**
 * The two sticks as move and look (C1): [moveX, moveY, lookX, lookY] from the
 * physical [leftX, leftY, rightX, rightY] in a stick layout.
 */
export function layoutSticks(axes: readonly number[], layout: StickLayout | undefined): [number, number, number, number] {
  const [lx = 0, ly = 0, rx = 0, ry = 0] = axes;
  switch (layout) {
    case "southpaw":
      return [rx, ry, lx, ly];
    case "legacy":
      // Left: forward/back and turn; right: strafe and look up/down.
      return [rx, ly, lx, ry];
    case "legacySouthpaw":
      return [lx, ry, rx, ly];
    default:
      return [lx, ly, rx, ry];
  }
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
 * sticks (through the player's dead zones, as [moveX, moveY, lookX, lookY] in
 * their stick layout), whether a control bound to "start" is held, and every
 * button held (which input actions bind directly, whatever it's mapped to).
 */
export function readPad(
  raw: PadSnapshot & { readonly mapping?: string; readonly id?: string },
  bindings: Readonly<Record<PadButton, ControlTarget>>,
  tuning: Partial<Pick<ControlSettings, "leftStick" | "rightStick" | "stickLayout" | "leftTrigger" | "rightTrigger">> = {},
): { mask: number; axes: [number, number, number, number]; start: boolean; pressed: Set<PadButton> } {
  const pad = standardizePad(raw);
  let mask = 0;
  let start = false;
  const pressed = new Set<PadButton>();
  const pull = { LT: tuning.leftTrigger ?? DEFAULT_TRIGGER_THRESHOLD, RT: tuning.rightTrigger ?? DEFAULT_TRIGGER_THRESHOLD };
  PAD_BUTTONS.forEach((name, index) => {
    const button = pad.buttons[index];
    // Triggers are analog: they press past the player's pull (a trigger that
    // only reports on or off presses when on). Other buttons past half-way.
    const trigger = name === "LT" || name === "RT" ? pull[name] : null;
    const down = !button ? false : trigger !== null ? (button.value > 0 ? button.value >= trigger : button.pressed) : button.pressed || button.value > 0.5;
    if (!down) return;
    pressed.add(name);
    const target = bindings[name];
    if (target === "start") start = true;
    else if (target !== null && target !== undefined) mask |= 1 << target;
  });
  // An unbound Start still opens the menu when the mapping left nothing else on it.
  if (bindings.Start === null && !Object.values(bindings).includes("start") && pad.buttons[9]?.pressed) start = true;
  const [lx, ly] = shapeStick(pad.axes[0] ?? 0, pad.axes[1] ?? 0, tuning.leftStick ?? DEFAULT_STICK_DEAD_ZONES);
  const [rx, ry] = shapeStick(pad.axes[2] ?? 0, pad.axes[3] ?? 0, tuning.rightStick ?? DEFAULT_STICK_DEAD_ZONES);
  return { mask, axes: layoutSticks([lx, ly, rx, ry], tuning.stickLayout), start, pressed };
}
