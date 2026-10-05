/**
 * Input actions (ENGINE_PARITY_ROADMAP.md EP15): named actions — "jump",
 * "fire", "reload" — each bound per device: keyboard keys, controller buttons,
 * and console buttons (which also covers the on-screen pad and anything the
 * player's control settings map onto them). The cart asks for the action, not
 * the key, so it works on every device, and a player can rebind it.
 *
 * Pure and DOM-free: actions, defensive reading, the mask a set of held
 * controls makes, player rebinding on top, and labels for on-screen prompts.
 * The player feeds the mask to the cart (see actionsSdk.ts in the player).
 */

/** A standard-mapping controller's buttons, in Gamepad API order (the player's PAD_BUTTONS). */
export const ACTION_PAD_BUTTONS = [
  "A", "B", "X", "Y", "LB", "RB", "LT", "RT", "Back", "Start", "LS", "RS", "Up", "Down", "Left", "Right", "Guide",
] as const;
export type ActionPadButton = (typeof ACTION_PAD_BUTTONS)[number];

/** The console's buttons by name, in their bit order (btn ids 0..7). */
export const ACTION_CONSOLE_BUTTONS = ["up", "down", "left", "right", "a", "b", "x", "y"] as const;

export interface InputAction {
  /** Lua-safe: letters, digits and _, not starting with a digit. */
  readonly name: string;
  /** Keyboard keys (KeyboardEvent.code: "Space", "KeyG", "ShiftLeft" …). */
  readonly keys: readonly string[];
  /** Controller buttons. */
  readonly pad: readonly ActionPadButton[];
  /** Console buttons (btn ids 0..7). */
  readonly buttons: readonly number[];
}

/** A player's rebinding of one action: the devices it names replace the cart's bindings for that device. */
export interface ActionRebind {
  readonly keys?: readonly string[];
  readonly pad?: readonly ActionPadButton[];
}

/** At most 24: an action's bit rides above the 8 console buttons in a 32-bit replay mask. */
export const MAX_ACTIONS = 24;
export const MAX_ACTION_BINDINGS = 4;

const NAME = /^[A-Za-z_]\w{0,23}$/;
const KEY_CODE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;
const PADS = new Set<string>(ACTION_PAD_BUTTONS);

function uniq<T>(list: readonly T[]): T[] {
  return [...new Set(list)].slice(0, MAX_ACTION_BINDINGS);
}

const readKeys = (value: unknown): string[] => (Array.isArray(value) ? uniq(value.filter((k): k is string => typeof k === "string" && KEY_CODE.test(k))) : []);
const readPad = (value: unknown): ActionPadButton[] => (Array.isArray(value) ? uniq(value.filter((b): b is ActionPadButton => typeof b === "string" && PADS.has(b))) : []);
const readButtons = (value: unknown): number[] =>
  Array.isArray(value) ? uniq(value.filter((b): b is number => Number.isInteger(b) && b >= 0 && b < ACTION_CONSOLE_BUTTONS.length)) : [];

/** Read stored actions defensively: names unique and Lua-safe, bindings valid and capped, at most {@link MAX_ACTIONS}. */
export function parseInputActions(value: unknown): InputAction[] {
  if (!Array.isArray(value)) return [];
  const out: InputAction[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    const r = raw as { name?: unknown; keys?: unknown; pad?: unknown; buttons?: unknown } | null;
    if (!r || typeof r.name !== "string" || !NAME.test(r.name) || names.has(r.name)) continue;
    if (out.length >= MAX_ACTIONS) break;
    names.add(r.name);
    out.push({ name: r.name, keys: readKeys(r.keys), pad: readPad(r.pad), buttons: readButtons(r.buttons) });
  }
  return out;
}

/** Read a player's stored rebinding defensively (only actions it names, only valid bindings). */
export function parseActionRebinds(value: unknown): Record<string, ActionRebind> {
  const out: Record<string, ActionRebind> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!NAME.test(name) || !raw || typeof raw !== "object") continue;
    const r = raw as { keys?: unknown; pad?: unknown };
    out[name] = { ...(r.keys !== undefined ? { keys: readKeys(r.keys) } : {}), ...(r.pad !== undefined ? { pad: readPad(r.pad) } : {}) };
  }
  return out;
}

/** The actions with a player's rebinding applied (a device it rebinds replaces the cart's bindings for it). */
export function reboundActions(actions: readonly InputAction[], rebinds: Readonly<Record<string, ActionRebind>> | null | undefined): InputAction[] {
  if (!rebinds) return [...actions];
  return actions.map((a) => {
    const r = rebinds[a.name];
    return r ? { ...a, ...(r.keys ? { keys: [...r.keys] } : {}), ...(r.pad ? { pad: [...r.pad] } : {}) } : a;
  });
}

/** What's held this tick, per device. */
export interface HeldControls {
  readonly keys: ReadonlySet<string>;
  readonly pad: ReadonlySet<string>;
  /** The console buttons' bitmask (bit N = btn N). */
  readonly buttons: number;
}

/** The actions held this tick as a bitmask (bit i = actions[i]): any of an action's bindings held holds it. */
export function actionMask(actions: readonly InputAction[], held: HeldControls): number {
  let mask = 0;
  actions.forEach((a, i) => {
    if (i >= MAX_ACTIONS) return;
    if (a.keys.some((k) => held.keys.has(k)) || a.pad.some((b) => held.pad.has(b)) || a.buttons.some((b) => (held.buttons & (1 << b)) !== 0)) mask |= 1 << i;
  });
  return mask >>> 0;
}

/** A new action, unbound. */
export function newInputAction(taken: readonly InputAction[], base = "action"): InputAction {
  const names = new Set(taken.map((a) => a.name));
  let name = base;
  for (let n = 2; names.has(name); n += 1) name = `${base}${n}`;
  return { name, keys: [], pad: [], buttons: [] };
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "Backspace",
  ShiftLeft: "Shift",
  ShiftRight: "Right Shift",
  ControlLeft: "Ctrl",
  ControlRight: "Right Ctrl",
  AltLeft: "Alt",
  AltRight: "Right Alt",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Backslash: "\\",
};

/** A key code as a person reads it: "KeyG" → "G", "Digit1" → "1", "ShiftLeft" → "Shift". */
export function keyLabel(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code]!;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

/** An action's bindings for one device, as a prompt reads them ("G / Q"); console buttons stand in when the device has none. */
export function actionLabel(action: InputAction, device: "keyboard" | "pad"): string {
  const own = device === "keyboard" ? action.keys.map(keyLabel) : action.pad.map(String);
  const list = own.length > 0 ? own : action.buttons.map((b) => ACTION_CONSOLE_BUTTONS[b]!.toUpperCase());
  return list.join(" / ");
}
