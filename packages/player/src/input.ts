/**
 * Input handling. Both sources (keyboard, touch) write into a shared
 * {@link GamepadState} that the run loop samples once per frame as a bitmask.
 *
 * The key-binding lookup is a pure function so it can be unit-tested without a DOM.
 */

import { ConsoleButton } from "./types.js";
import { stickDirections } from "./sticks.js";
import { DEFAULT_KEY_BINDINGS, START_KEYS, readPad, type ControlSettings, type PadSnapshot } from "./controls.js";

/**
 * Default keyboard layout, matching TIC-80 conventions: arrows for the D-pad,
 * Z/X for A/B, A/S for X/Y. Keyed by `KeyboardEvent.code` so it is layout-independent.
 */
export { DEFAULT_KEY_BINDINGS };

/**
 * Resolves a physical key to a console button, or undefined if unbound.
 * Pure — no DOM access — so callers and tests can use it freely.
 */
export function resolveButton(
  keyCode: string,
  bindings: Readonly<Record<string, ConsoleButton>> = DEFAULT_KEY_BINDINGS,
): ConsoleButton | undefined {
  return bindings[keyCode];
}

/**
 * Holds the current pressed/released state of every button as a bitmask.
 * Bit N (see {@link ConsoleButton}) is set while that button is held.
 */
export class GamepadState {
  private mask = 0;
  /** D-pad bits the left stick is pressing (kept apart so a key release can't clear them). */
  private stickMask = 0;
  /** What a physical controller is pressing, replaced wholesale each poll. */
  private padMask = 0;
  /** The on-screen sticks and a controller's sticks, kept apart and merged on read. */
  private readonly touchAxes: [number, number, number, number] = [0, 0, 0, 0];
  private readonly padAxes: [number, number, number, number] = [0, 0, 0, 0];

  /** Analog sticks: left x, left y, right x, right y, each −1..1 (y down-positive) —
   *  per stick, whichever source (touch or controller) is leaning further. */
  get axes(): [number, number, number, number] {
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (const i of [0, 2]) {
      const t = Math.hypot(this.touchAxes[i]!, this.touchAxes[i + 1]!);
      const p = Math.hypot(this.padAxes[i]!, this.padAxes[i + 1]!);
      const src = p > t ? this.padAxes : this.touchAxes;
      out[i] = src[i]!;
      out[i + 1] = src[i + 1]!;
    }
    return out;
  }

  /** A controller's state this frame: its pressed console buttons and sticks. */
  setPad(mask: number, axes: readonly number[]): void {
    this.padMask = mask;
    for (let i = 0; i < 4; i += 1) this.padAxes[i] = axes[i] ?? 0;
  }

  press(button: ConsoleButton): void {
    this.mask |= 1 << button;
  }

  release(button: ConsoleButton): void {
    this.mask &= ~(1 << button);
  }

  /**
   * Set a stick's position (0 = left, 1 = right). The left stick also presses
   * the D-pad directions it leans toward, so button-only carts steer with it.
   */
  setStick(index: 0 | 1, x: number, y: number): void {
    this.touchAxes[index * 2] = x;
    this.touchAxes[index * 2 + 1] = y;
    if (index === 0) this.stickMask = stickDirections(x, y);
  }

  /** The engine-facing bitmask for player one. A controller's left stick also
   *  presses the D-pad directions it leans toward, like the on-screen one. */
  get value(): number {
    return this.mask | this.stickMask | this.padMask | stickDirections(this.padAxes[0], this.padAxes[1]);
  }

  reset(): void {
    this.mask = 0;
    this.stickMask = 0;
    this.padMask = 0;
    this.touchAxes.fill(0);
    this.padAxes.fill(0);
  }
}

/** Translates keyboard events into {@link GamepadState} changes. */
export class KeyboardInput {
  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private readonly onKeyUp: (event: KeyboardEvent) => void;

  /**
   * @param bindings The key map, or a getter for it (read on every key, so a
   *   rebind from a settings menu applies at once).
   * @param onStart Called for a Start key (Enter / P) that isn't bound to a button.
   */
  constructor(
    private readonly target: Window,
    state: GamepadState,
    bindings: Readonly<Record<string, ConsoleButton>> | (() => Readonly<Record<string, ConsoleButton>>) = DEFAULT_KEY_BINDINGS,
    onStart?: () => void,
  ) {
    const current = typeof bindings === "function" ? bindings : () => bindings;
    // Remember which button each held key pressed, so a rebind while it is held
    // still releases the right one.
    const held = new Map<string, ConsoleButton>();
    this.onKeyDown = (event) => {
      const button = resolveButton(event.code, current());
      if (button !== undefined) {
        held.set(event.code, button);
        state.press(button);
        event.preventDefault(); // stop arrow keys from scrolling the page
      } else if (onStart && START_KEYS.includes(event.code) && !event.repeat) {
        const tag = (event.target as { tagName?: string } | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
        event.preventDefault();
        onStart();
      }
    };
    this.onKeyUp = (event) => {
      const button = held.get(event.code) ?? resolveButton(event.code, current());
      held.delete(event.code);
      if (button !== undefined) {
        state.release(button);
      }
    };

    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
  }

  destroy(): void {
    this.target.removeEventListener("keydown", this.onKeyDown);
    this.target.removeEventListener("keyup", this.onKeyUp);
  }
}

/** One on-screen control: which console button it drives and where it sits. */
export interface TouchControl {
  readonly button: ConsoleButton;
  /** Big glyph on the button. */
  readonly label: string;
  /** Small keyboard-equivalent hint under the glyph (empty for the D-pad). */
  readonly hint: string;
  readonly cluster: "face";
  /** Grid cell inside its cluster's 3x3 grid (1-based column/row). */
  readonly col: number;
  readonly row: number;
}

/**
 * The on-screen face buttons: an Xbox-style diamond bottom-right. The D-pad
 * directions come from the left stick (see {@link TouchInput}), so all eight
 * console buttons stay reachable on a phone or tablet. Pure data so it can be
 * unit-tested without a DOM.
 */
export const TOUCH_LAYOUT: readonly TouchControl[] = [
  { button: ConsoleButton.Y, label: "Y", hint: "S", cluster: "face", col: 2, row: 1 },
  { button: ConsoleButton.X, label: "X", hint: "A", cluster: "face", col: 1, row: 2 },
  { button: ConsoleButton.B, label: "B", hint: "X", cluster: "face", col: 3, row: 2 },
  { button: ConsoleButton.A, label: "A", hint: "Z", cluster: "face", col: 2, row: 3 },
];

/**
 * Whether a device can take touch input at all. Deliberately broader than
 * "the primary pointer is coarse": an iPad in a keyboard/trackpad case reports a
 * *fine* primary pointer yet is still a touchscreen, and it has no gamepad -- it
 * must still get the on-screen controls.
 */
export function hasTouchSupport(maxTouchPoints: number, coarsePointer: boolean): boolean {
  return maxTouchPoints > 0 || coarsePointer;
}

/** Edge length of a face button, and of a thumbstick's ring. */
const FACE_SIZE = "clamp(40px, 8vmin, 68px)";
const STICK_SIZE = "clamp(110px, 24vmin, 190px)";

/**
 * A thumb's offset from a stick's centre as a stick position: −1..1 per axis,
 * clamped to the ring, with a small dead zone so a resting thumb reads 0.
 */
export function stickVector(dx: number, dy: number, radius: number, deadZone = 0.12): { x: number; y: number } {
  const r = Math.max(1, radius);
  let x = dx / r;
  let y = dy / r;
  const m = Math.hypot(x, y);
  if (m > 1) {
    x /= m;
    y /= m;
  }
  if (m < deadZone) return { x: 0, y: 0 };
  // Rescale past the dead zone so the stick still reaches full deflection.
  const k = (Math.min(1, m) - deadZone) / (1 - deadZone) / Math.min(1, m);
  return { x: x * k, y: y * k };
}

/**
 * Renders an on-screen gamepad (two thumbsticks + A/B/X/Y) over the player and maps presses
 * to {@link GamepadState}. Styled inline so it works in any host page without a
 * stylesheet, and driven by pointer events so fingers, pens, trackpad taps and
 * mouse clicks all work; each control tracks its own pointers, so multi-touch
 * (move while firing) behaves. The `data-cbx-*` attributes stay available for
 * hosts that want to restyle it.
 */
export class TouchInput {
  private readonly root: HTMLElement;
  private readonly rightStick: HTMLElement;
  private readonly pad: HTMLElement;
  private readonly restorePosition: (() => void) | null = null;

  constructor(container: HTMLElement, state: GamepadState, onStart?: () => void) {
    const doc = container.ownerDocument;
    const view = doc.defaultView;

    // The pad is absolutely positioned over the game, so its container must be a
    // containing block. Only touch the style when it is not already one.
    if (view && view.getComputedStyle(container).position === "static") {
      const previous = container.style.position;
      container.style.position = "relative";
      this.restorePosition = () => {
        container.style.position = previous;
      };
    }

    this.root = doc.createElement("div");
    this.root.setAttribute("data-cbx-touch", "");
    Object.assign(this.root.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none", // only the buttons catch input; the game stays visible
      zIndex: "5",
      userSelect: "none",
      webkitUserSelect: "none",
    } satisfies Partial<CSSStyleDeclaration>);

    // Everything that scales and fades with the touch settings lives in `pad`.
    this.pad = doc.createElement("div");
    Object.assign(this.pad.style, { position: "absolute", inset: "0", pointerEvents: "none", transformOrigin: "50% 100%" });
    this.root.appendChild(this.pad);

    // Face buttons: an Xbox-style diamond, bottom-right.
    const face = doc.createElement("div");
    Object.assign(face.style, {
      position: "absolute",
      bottom: "4%",
      right: "3%",
      display: "grid",
      gridTemplateColumns: `repeat(3, ${FACE_SIZE})`,
      gridTemplateRows: `repeat(3, ${FACE_SIZE})`,
      gap: "4px",
    });
    this.pad.appendChild(face);
    for (const control of TOUCH_LAYOUT) face.appendChild(this.createButton(doc, control, state));

    // Two sticks: the left one moves (and drives the D-pad for button-only
    // carts); the right one, beside the face buttons, aims — shown once the cart
    // reads sticks (cartbox.stick), since a button-only cart has no use for it.
    this.createStick(doc, state, 0, { left: "4%", bottom: "6%" });
    this.rightStick = this.createStick(doc, state, 1, { right: `calc(3% + 3 * ${FACE_SIZE} + 8px + 3vmin)`, bottom: "6%" });
    this.rightStick.style.display = "none";

    // Start: opens the game's menu (settings, leave). Top centre, out of the thumbs' way.
    if (onStart) {
      const start = doc.createElement("button");
      start.type = "button";
      start.setAttribute("data-cbx-button", "Start");
      start.setAttribute("aria-label", "Start (menu)");
      start.textContent = "\u2261 START";
      Object.assign(start.style, {
        position: "absolute",
        top: "2%",
        left: "50%",
        transform: "translateX(-50%)",
        pointerEvents: "auto",
        touchAction: "none",
        padding: "6px 14px",
        borderRadius: "999px",
        border: "2px solid rgba(255,255,255,0.45)",
        background: "rgba(20,26,40,0.55)",
        color: "rgba(255,255,255,0.92)",
        font: "700 12px/1 system-ui, sans-serif",
        letterSpacing: "1px",
        cursor: "pointer",
      } as Partial<CSSStyleDeclaration>);
      start.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        onStart();
      });
      this.pad.appendChild(start);
    }
    container.appendChild(this.root);
  }

  /** Apply the player's touch settings: overall opacity and size of the pad. */
  applySettings(settings: Pick<ControlSettings, "touchOpacity" | "touchScale">): void {
    this.pad.style.opacity = String(settings.touchOpacity);
    for (const child of Array.from(this.pad.children) as HTMLElement[]) {
      if (child.getAttribute("data-cbx-button") === "Start") continue;
      child.style.scale = String(settings.touchScale);
      child.style.transformOrigin = child.style.left ? "0% 100%" : "100% 100%"; // grow from its own corner
    }
  }

  /** Show the right stick: the cart reads analog sticks. */
  setAnalog(on: boolean): void {
    this.rightStick.style.display = on ? "block" : "none";
  }

  /** A virtual thumbstick: a ring you press anywhere in, and a knob that follows the thumb. */
  private createStick(doc: Document, state: GamepadState, index: 0 | 1, place: Partial<CSSStyleDeclaration>): HTMLElement {
    const base = doc.createElement("div");
    base.setAttribute("data-cbx-stick", index === 0 ? "left" : "right");
    base.setAttribute("aria-label", index === 0 ? "Left stick" : "Right stick");
    Object.assign(base.style, {
      position: "absolute",
      width: STICK_SIZE,
      height: STICK_SIZE,
      borderRadius: "50%",
      border: "2px solid rgba(255,255,255,0.4)",
      background: "radial-gradient(circle, rgba(20,26,40,0.25) 0%, rgba(20,26,40,0.5) 70%)",
      pointerEvents: "auto",
      touchAction: "none",
      webkitTouchCallout: "none",
      webkitTapHighlightColor: "transparent",
      ...place,
    } as Partial<CSSStyleDeclaration>);
    const knob = doc.createElement("div");
    Object.assign(knob.style, {
      position: "absolute",
      left: "30%",
      top: "30%",
      width: "40%",
      height: "40%",
      borderRadius: "50%",
      border: "2px solid rgba(255,255,255,0.6)",
      background: "rgba(92,208,255,0.35)",
      pointerEvents: "none",
      transform: "translate(0px, 0px)",
    } as Partial<CSSStyleDeclaration>);
    base.appendChild(knob);

    let pointer: number | null = null;
    const move = (event: PointerEvent) => {
      const rect = base.getBoundingClientRect();
      const radius = rect.width / 2 || 1;
      const { x, y } = stickVector(event.clientX - (rect.left + radius), event.clientY - (rect.top + radius), radius);
      state.setStick(index, x, y);
      knob.style.transform = `translate(${(x * radius * 0.6).toFixed(1)}px, ${(y * radius * 0.6).toFixed(1)}px)`;
      knob.style.background = "rgba(92,208,255,0.6)";
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== pointer) return;
      pointer = null;
      state.setStick(index, 0, 0);
      knob.style.transform = "translate(0px, 0px)";
      knob.style.background = "rgba(92,208,255,0.35)";
    };
    base.addEventListener("pointerdown", (event) => {
      if (pointer !== null) return; // one thumb per stick
      event.preventDefault();
      pointer = event.pointerId;
      try {
        base.setPointerCapture(event.pointerId); // keep tracking when the thumb leaves the ring
      } catch {
        // Synthetic/unsupported pointers: tracking still works while inside.
      }
      move(event);
    });
    base.addEventListener("pointermove", (event) => {
      if (event.pointerId === pointer) move(event);
    });
    base.addEventListener("pointerup", end);
    base.addEventListener("pointercancel", end);
    base.addEventListener("lostpointercapture", end);
    base.addEventListener("contextmenu", (event) => event.preventDefault());
    this.pad.appendChild(base);
    return base;
  }

  private createButton(doc: Document, control: TouchControl, state: GamepadState): HTMLButtonElement {
    const element = doc.createElement("button");
    element.type = "button";
    element.setAttribute("data-cbx-button", ConsoleButton[control.button]);
    element.setAttribute("aria-label", `${ConsoleButton[control.button]} button`);
    const round = true;
    Object.assign(element.style, {
      gridColumn: String(control.col),
      gridRow: String(control.row),
      pointerEvents: "auto",
      touchAction: "none", // no scroll / zoom / double-tap-zoom while playing
      webkitTouchCallout: "none",
      webkitTapHighlightColor: "transparent",
      margin: "0",
      padding: "0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: round ? "50%" : "10px",
      border: "2px solid rgba(255,255,255,0.45)",
      background: "rgba(20,26,40,0.45)",
      color: "rgba(255,255,255,0.92)",
      font: "700 clamp(14px, 3vmin, 22px)/1 system-ui, sans-serif",
      cursor: "pointer",
    } as Partial<CSSStyleDeclaration>);
    element.textContent = control.label;
    if (control.hint) {
      const hint = doc.createElement("span");
      hint.textContent = control.hint;
      Object.assign(hint.style, { font: "500 10px/1 system-ui, sans-serif", opacity: "0.6", marginTop: "2px" });
      element.appendChild(hint);
    }

    // Count the pointers holding this control so a second finger lifting off does
    // not release a button the first finger still holds.
    const held = new Set<number>();
    const setVisual = (down: boolean) => {
      element.style.background = down ? "rgba(92,208,255,0.55)" : "rgba(20,26,40,0.45)";
    };
    const press = (event: PointerEvent) => {
      event.preventDefault();
      held.add(event.pointerId);
      try {
        element.setPointerCapture(event.pointerId); // keep the press if the finger drifts
      } catch {
        // Synthetic/unsupported pointers: the plain press still works.
      }
      state.press(control.button);
      setVisual(true);
    };
    const release = (event: PointerEvent) => {
      if (!held.delete(event.pointerId)) return;
      if (held.size === 0) {
        state.release(control.button);
        setVisual(false);
      }
    };
    element.addEventListener("pointerdown", press);
    element.addEventListener("pointerup", release);
    element.addEventListener("pointercancel", release);
    element.addEventListener("lostpointercapture", release);
    element.addEventListener("contextmenu", (event) => event.preventDefault()); // iOS long-press callout
    return element;
  }

  destroy(): void {
    this.root.remove();
    this.restorePosition?.();
  }
}

/**
 * Reads a physical controller (an Xbox 360 or any standard-mapping gamepad)
 * through the Gamepad API once per frame: its bindings press console buttons,
 * its sticks feed the analog channel, and a control bound to "start" opens the
 * Start menu (on press, not while held).
 */
export class GamepadInput {
  private startHeld = false;
  /** The pad index in use, so a second controller plugged in later doesn't take over mid-game. */
  private index: number | null = null;

  constructor(
    private readonly nav: { getGamepads?: () => ArrayLike<(PadSnapshot & { mapping?: string; id?: string; connected?: boolean; index?: number }) | null> },
    private readonly state: GamepadState,
    private readonly settings: () => ControlSettings,
    private readonly onStart?: () => void,
  ) {}

  poll(): void {
    const pads = this.nav.getGamepads?.() ?? [];
    let pad: (PadSnapshot & { connected?: boolean; index?: number }) | null = null;
    if (this.index !== null) pad = pads[this.index] ?? null;
    if (!pad || pad.connected === false) {
      pad = null;
      this.index = null;
      for (let i = 0; i < pads.length; i += 1) {
        const candidate = pads[i];
        if (candidate && candidate.connected !== false) {
          pad = candidate;
          this.index = i;
          break;
        }
      }
    }
    if (!pad) {
      this.state.setPad(0, [0, 0, 0, 0]);
      this.startHeld = false;
      return;
    }
    const { mask, axes, start } = readPad(pad, this.settings().padBindings);
    this.state.setPad(mask, axes);
    if (start && !this.startHeld) this.onStart?.();
    this.startHeld = start;
  }

  /** Whether a controller is connected (for hints like "press Start"). */
  get connected(): boolean {
    return this.index !== null;
  }
}
