/**
 * Input handling. Both sources (keyboard, touch) write into a shared
 * {@link GamepadState} that the run loop samples once per frame as a bitmask.
 *
 * The key-binding lookup is a pure function so it can be unit-tested without a DOM.
 */

import { ConsoleButton } from "./types.js";
import { stickDirections } from "./sticks.js";
import {
  DEFAULT_KEY_BINDINGS,
  START_KEYS,
  TOUCH_CONTROL_MAX_SIZE,
  TOUCH_CONTROL_MIN_SIZE,
  placeWithin,
  readPad,
  type ControlSettings,
  type LookDevice,
  type PadSnapshot,
  type RumbleEffect,
  TOUCH_CONTROL_IDS,
  type TouchControlId,
  type TouchLayout,
  type TouchLookMode,
} from "./controls.js";

/**
 * Default keyboard layout, matching TIC-80 conventions: arrows for the D-pad,
 * Z/X for A/B, A/S for X/Y. Keyed by `KeyboardEvent.code` so it is layout-independent.
 */
export { DEFAULT_KEY_BINDINGS };

const NO_KEYS: ReadonlySet<string> = new Set();

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
  /** The mouse's look this tick (C4): look only, as lean. */
  private readonly mouseLook: [number, number] = [0, 0];
  /** The gyro's look this tick (C4b). */
  private readonly gyroLook: [number, number] = [0, 0];

  /** Analog sticks: left x, left y, right x, right y, each −1..1 (y down-positive) —
   *  per stick, whichever source (touch, controller or mouse) is leaning further. */
  get axes(): [number, number, number, number] {
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (const i of [0, 2]) {
      const t = Math.hypot(this.touchAxes[i]!, this.touchAxes[i + 1]!);
      const p = Math.hypot(this.padAxes[i]!, this.padAxes[i + 1]!);
      const src = p > t ? this.padAxes : this.touchAxes;
      out[i] = src[i]!;
      out[i + 1] = src[i + 1]!;
    }
    const device = this.lookDevice;
    if (device === "mouse") [out[2], out[3]] = this.mouseLook;
    else if (device === "gyro") [out[2], out[3]] = this.gyroLook;
    return out;
  }

  /** Which device the look stick's reading comes from this tick (C4), so its own look profile applies. */
  get lookDevice(): LookDevice {
    const t = Math.hypot(this.touchAxes[2], this.touchAxes[3]);
    const p = Math.hypot(this.padAxes[2], this.padAxes[3]);
    const m = Math.hypot(this.mouseLook[0], this.mouseLook[1]);
    const g = Math.hypot(this.gyroLook[0], this.gyroLook[1]);
    if (m > 0 && m >= t && m >= p && m >= g) return "mouse";
    if (g > 0 && g >= t && g >= p) return "gyro";
    return p > t ? "controller" : "touch";
  }

  /** The gyro's look this tick (see gyroLean), replaced each tick. */
  setGyroLook(x: number, y: number): void {
    this.gyroLook[0] = x;
    this.gyroLook[1] = y;
  }

  /** The mouse's look this tick (see mouseLean), replaced each tick. */
  setMouseLook(x: number, y: number): void {
    this.mouseLook[0] = x;
    this.mouseLook[1] = y;
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
    this.mouseLook.fill(0);
    this.gyroLook.fill(0);
  }
}

/** Translates keyboard events into {@link GamepadState} changes. */
export class KeyboardInput {
  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private readonly onKeyUp: (event: KeyboardEvent) => void;
  private readonly onBlur: () => void;
  /** Every key held now (KeyboardEvent.code), bound or not — what input actions read. */
  readonly held = new Set<string>();

  /**
   * @param bindings The key map, or a getter for it (read on every key, so a
   *   rebind from a settings menu applies at once).
   * @param onStart Called for a Start key (Enter / P) that isn't bound to a button.
   * @param claimed Keys the cart's input actions bind. They're the actions':
   *   kept from the page (no scrolling on Space), and they press no console
   *   button and never open Start.
   */
  constructor(
    private readonly target: Window,
    state: GamepadState,
    bindings: Readonly<Record<string, ConsoleButton>> | (() => Readonly<Record<string, ConsoleButton>>) = DEFAULT_KEY_BINDINGS,
    onStart?: () => void,
    claimed: () => ReadonlySet<string> = () => NO_KEYS,
  ) {
    const current = typeof bindings === "function" ? bindings : () => bindings;
    // Remember which button each held key pressed, so a rebind while it is held
    // still releases the right one.
    const held = new Map<string, ConsoleButton>();
    this.onKeyDown = (event) => {
      const tag = (event.target as { tagName?: string } | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (!typing) this.held.add(event.code);
      const button = resolveButton(event.code, current());
      if (claimed().has(event.code) && !typing) {
        event.preventDefault();
        return;
      }
      if (button !== undefined) {
        held.set(event.code, button);
        state.press(button);
        event.preventDefault(); // stop arrow keys from scrolling the page
      } else if (onStart && START_KEYS.includes(event.code) && !event.repeat) {
        if (typing || tag === "BUTTON") return;
        event.preventDefault();
        onStart();
      }
    };
    this.onKeyUp = (event) => {
      this.held.delete(event.code);
      const button = held.get(event.code) ?? resolveButton(event.code, current());
      held.delete(event.code);
      if (button !== undefined) {
        state.release(button);
      }
    };

    // Keys let go while the page wasn't looking never send keyup.
    this.onBlur = () => this.held.clear();

    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
    target.addEventListener("blur", this.onBlur);
  }

  destroy(): void {
    this.target.removeEventListener("keydown", this.onKeyDown);
    this.target.removeEventListener("keyup", this.onKeyUp);
    this.target.removeEventListener("blur", this.onBlur);
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

const controlName = (id: TouchControlId): string =>
  id.startsWith("act:") ? `${id.slice(4)} button` : CONTROL_NAMES[id as (typeof TOUCH_CONTROL_IDS)[number]];

/** How the layout editor names each control (an action's button by its action). */
const CONTROL_NAMES: Record<(typeof TOUCH_CONTROL_IDS)[number], string> = {
  leftStick: "Left stick",
  rightStick: "Right stick",
  A: "A button",
  B: "B button",
  X: "X button",
  Y: "Y button",
  Start: "Start",
};

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
  /** Drag-to-look (C4b): a zone over the right of the screen, and the drag since the last tick (px). */
  private readonly lookZone: HTMLElement;
  private dragX = 0;
  private dragY = 0;
  /** A floating move stick (C4b): a zone over the left of the screen where the thumb lands. */
  private readonly moveZone: HTMLElement;
  private analog = false;
  private lookMode: TouchLookMode = "stick";
  /**
   * Each stick, zone and button's "let go" (for releases the browser never
   * delivers), and the document/window listeners that call them all.
   */
  private readonly letGoes: (() => void)[] = [];
  private readonly unlisten: (() => void)[] = [];
  /** The face buttons' grid (their usual home), and every control the player can move. */
  private readonly face: HTMLElement;
  private readonly controls = new Map<TouchControlId, { readonly el: HTMLElement; readonly inFace: boolean; readonly home: Partial<CSSStyleDeclaration> }>();
  /** The player's layout (the controls they moved), and the pad's overall size. */
  private layout: TouchLayout = {};
  private touchScale = 1;
  /** The game's input actions no face button carries, each with its own button (see setActionButtons), and those held. */
  private actionNames: readonly string[] = [];
  private readonly actionHeldSet = new Set<string>();
  /** Set while the layout is being edited (see editLayout). */
  private editing: { readonly finish: (layout: TouchLayout | null) => void } | null = null;

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
    const face = (this.face = doc.createElement("div"));
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
    for (const control of TOUCH_LAYOUT) {
      const button = this.createButton(doc, control, state);
      face.appendChild(button);
      this.controls.set(ConsoleButton[control.button] as TouchControlId, { el: button, inFace: true, home: {} });
    }

    // Two sticks: the left one moves (and drives the D-pad for button-only
    // carts); the right one, beside the face buttons, aims — shown once the cart
    // reads sticks (cartbox.stick), since a button-only cart has no use for it.
    // Under them (first, so every control draws over it), the zones a
    // floating stick and drag-to-look take their touches from (C4b).
    this.moveZone = this.createZone(doc, { left: "0", top: "30%", width: "45%", bottom: "0" }, "Move (touch anywhere here)");
    this.lookZone = this.createZone(doc, { right: "0", top: "12%", width: "50%", bottom: "0" }, "Look (drag here)");
    const leftPlace = { left: "4%", bottom: "6%" };
    const rightPlace = { right: `calc(3% + 3 * ${FACE_SIZE} + 8px + 3vmin)`, bottom: "6%" };
    const left = this.createStick(doc, state, 0, leftPlace);
    this.rightStick = this.createStick(doc, state, 1, rightPlace).base;
    this.rightStick.style.display = "none";
    this.controls.set("leftStick", { el: left.base, inFace: false, home: leftPlace });
    this.controls.set("rightStick", { el: this.rightStick, inFace: false, home: rightPlace });
    this.wireMoveZone(left);
    this.wireLookZone();

    // Start: opens the game's menu (settings, leave). Top centre, out of the thumbs' way.
    if (onStart) {
      const start = doc.createElement("button");
      start.type = "button";
      start.setAttribute("data-cbx-button", "Start");
      start.setAttribute("aria-label", "Start (menu)");
      start.textContent = "\u2261 START";
      const startPlace = { top: "2%", left: "50%", transform: "translateX(-50%)" };
      this.controls.set("Start", { el: start, inFace: false, home: startPlace });
      Object.assign(start.style, {
        position: "absolute",
        ...startPlace,
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
    this.watchForLostReleases(doc);
  }

  /**
   * A finger's release can go missing: iOS swallows it on a system gesture
   * (a swipe from an edge, a notification, the app switcher), and a control
   * that couldn't capture its pointer misses an up outside it. Without the
   * release, a stick stays leaned and a button stays pressed. So once no
   * finger is on the screen, or the page is hidden or loses focus, every
   * control lets go; and a new finger on a stick takes it over (see createStick).
   */
  private watchForLostReleases(doc: Document): void {
    const view = doc.defaultView;
    const letGoAll = () => {
      for (const letGo of this.letGoes) letGo();
    };
    const onTouchEnd = (event: Event) => {
      if ((event as TouchEvent).touches?.length === 0) letGoAll();
    };
    const onHidden = () => {
      if (doc.visibilityState === "hidden") letGoAll();
    };
    doc.addEventListener("touchend", onTouchEnd, true);
    doc.addEventListener("touchcancel", onTouchEnd, true);
    doc.addEventListener("visibilitychange", onHidden);
    view?.addEventListener("blur", letGoAll);
    view?.addEventListener("pagehide", letGoAll);
    this.unlisten.push(() => {
      doc.removeEventListener("touchend", onTouchEnd, true);
      doc.removeEventListener("touchcancel", onTouchEnd, true);
      doc.removeEventListener("visibilitychange", onHidden);
      view?.removeEventListener("blur", letGoAll);
      view?.removeEventListener("pagehide", letGoAll);
    });
  }

  /**
   * Apply the player's touch settings: overall opacity and size of the pad,
   * where they moved its controls, how it looks, and a floating move stick.
   */
  applySettings(
    settings: Pick<ControlSettings, "touchOpacity" | "touchScale"> & Partial<Pick<ControlSettings, "touchLookMode" | "floatingStick" | "touchLayout">>,
  ): void {
    this.pad.style.opacity = String(settings.touchOpacity);
    this.touchScale = settings.touchScale;
    Object.assign(this.face.style, { scale: String(settings.touchScale), transformOrigin: "100% 100%" }); // grows from its corner
    if (!this.editing) this.layout = settings.touchLayout ?? {};
    this.placeAll();
    this.lookMode = settings.touchLookMode ?? "stick";
    this.moveZone.style.display = settings.floatingStick ? "block" : "none";
    this.showLook();
  }

  /**
   * Put a control where the player moved it (its centre at their spot, at
   * their size), or back where it usually sits: a face button in the
   * diamond, a stick or Start at its corner, growing from its own corner.
   */
  private place(id: TouchControlId): void {
    const control = this.controls.get(id);
    if (!control) return;
    const { el, inFace, home } = control;
    const s = el.style;
    const spot = this.layout[id];
    const base = id === "Start" ? 1 : this.touchScale;
    if (spot) {
      if (el.parentElement !== this.pad) this.pad.appendChild(el);
      Object.assign(s, {
        position: "absolute",
        left: `${(spot.x * 100).toFixed(3)}%`,
        top: `${(spot.y * 100).toFixed(3)}%`,
        right: "auto",
        bottom: "auto",
        transform: "",
        translate: "-50% -50%",
        transformOrigin: "50% 50%",
        scale: String(base * spot.size),
      });
      if (inFace) Object.assign(s, { width: FACE_SIZE, height: FACE_SIZE });
      return;
    }
    if (inFace && el.parentElement !== this.face) this.face.appendChild(el);
    Object.assign(s, { left: "", top: "", right: "", bottom: "", transform: "", translate: "" });
    if (inFace) Object.assign(s, { position: "", width: "", height: "", scale: "", transformOrigin: "" });
    else Object.assign(s, { position: "absolute", ...home, scale: id === "Start" ? "" : String(base), transformOrigin: s.left ? "0% 100%" : "100% 100%" });
  }

  private placeAll(): void {
    for (const id of this.controls.keys()) this.place(id);
  }

  /**
   * Let the player move and resize the pad's controls (and the right stick,
   * shown while they do): drag one to move it, pick one and make it smaller
   * or bigger, reset them all. Resolves with the new layout on Save, or null
   * on Cancel (when the old layout comes back). The game's controls take no
   * input meanwhile: an edit layer lies over them.
   */
  editLayout(): Promise<TouchLayout | null> {
    if (this.editing) return Promise.resolve(null);
    const doc = this.root.ownerDocument;
    const before = this.layout;
    for (const letGo of this.letGoes) letGo();
    this.rightStick.style.display = "block";
    let selected: TouchControlId | null = null;

    const layer = doc.createElement("div");
    layer.setAttribute("data-cbx-layout-editor", "");
    layer.setAttribute("aria-label", "Touch layout editor");
    Object.assign(layer.style, {
      position: "absolute",
      inset: "0",
      zIndex: "10",
      pointerEvents: "auto",
      touchAction: "none",
      background: "rgba(6,8,14,0.35)",
    } as Partial<CSSStyleDeclaration>);

    const bar = doc.createElement("div");
    Object.assign(bar.style, {
      position: "absolute",
      top: "38%",
      left: "50%",
      translate: "-50% -50%",
      display: "flex",
      flexWrap: "wrap",
      justifyContent: "center",
      alignItems: "center",
      gap: "8px",
      maxWidth: "min(92%, 560px)",
      padding: "10px 12px",
      borderRadius: "14px",
      background: "rgba(20,26,40,0.88)",
      border: "1px solid rgba(255,255,255,0.3)",
      color: "rgba(255,255,255,0.92)",
      font: "600 13px/1.3 system-ui, sans-serif",
    } as Partial<CSSStyleDeclaration>);
    const hint = doc.createElement("span");
    hint.style.flex = "1 1 100%";
    hint.style.textAlign = "center";
    const tool = (label: string, aria: string, onTap: () => void) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("aria-label", aria);
      Object.assign(b.style, {
        minWidth: "44px",
        minHeight: "40px",
        padding: "6px 12px",
        borderRadius: "10px",
        border: "1px solid rgba(255,255,255,0.45)",
        background: "rgba(255,255,255,0.08)",
        color: "inherit",
        font: "inherit",
        touchAction: "manipulation",
      } as Partial<CSSStyleDeclaration>);
      b.addEventListener("click", onTap);
      bar.appendChild(b);
      return b;
    };
    const describe = () => {
      hint.textContent = selected
        ? `${controlName(selected)}: drag to move · ${Math.round((this.layout[selected]?.size ?? 1) * 100)}% size`
        : "Drag a stick or button to move it. Tap one to resize it.";
      for (const [id, { el }] of this.controls) {
        el.style.outline = id === selected ? "3px solid rgba(92,208,255,0.95)" : "2px dashed rgba(255,255,255,0.75)";
        el.style.outlineOffset = "3px";
      }
    };
    /** The control's current spot, measured, for one the player hasn't moved yet. */
    const spotOf = (id: TouchControlId) => {
      const own = this.layout[id];
      if (own) return own;
      const frame = this.root.getBoundingClientRect();
      const r = this.controls.get(id)!.el.getBoundingClientRect();
      return { x: (r.left + r.width / 2 - frame.left) / (frame.width || 1), y: (r.top + r.height / 2 - frame.top) / (frame.height || 1), size: 1 };
    };
    const resize = (step: number) => {
      if (!selected) return;
      const spot = spotOf(selected);
      const size = Math.round(Math.min(TOUCH_CONTROL_MAX_SIZE, Math.max(TOUCH_CONTROL_MIN_SIZE, spot.size + step)) * 10) / 10;
      this.layout = { ...this.layout, [selected]: { ...spot, size } };
      this.place(selected);
      describe();
    };
    bar.appendChild(hint);
    tool("−", "Smaller", () => resize(-0.1));
    tool("+", "Bigger", () => resize(0.1));
    tool("Reset", "Reset layout", () => {
      this.layout = {};
      this.placeAll();
      describe();
    });
    // The bar can sit in the middle, at the top or at the bottom, out of the way of whatever is under it.
    const barSpots = ["38%", "16%", "80%"];
    let barSpot = 0;
    tool("⇅", "Move this bar", () => {
      barSpot = (barSpot + 1) % barSpots.length;
      bar.style.top = barSpots[barSpot]!;
    });
    tool("Cancel", "Cancel layout", () => this.editing?.finish(null));
    const save = tool("Save", "Save layout", () => this.editing?.finish(this.layout));
    save.style.background = "rgba(92,208,255,0.85)";
    save.style.color = "#08101c";
    bar.addEventListener("pointerdown", (event) => event.stopPropagation());
    layer.appendChild(bar);

    // Dragging: the control under the finger follows it, kept on screen.
    let drag: { id: TouchControlId; pointer: number; dx: number; dy: number } | null = null;
    layer.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const hit = [...this.controls].reverse().find(([, { el }]) => {
        if (el.style.display === "none") return false;
        const r = el.getBoundingClientRect();
        return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      });
      selected = hit ? hit[0] : null;
      describe();
      if (!hit) return;
      const r = hit[1].el.getBoundingClientRect();
      drag = { id: hit[0], pointer: event.pointerId, dx: event.clientX - (r.left + r.width / 2), dy: event.clientY - (r.top + r.height / 2) };
      // While dragging, the bar fades and lets touches through, so a control can go anywhere.
      Object.assign(bar.style, { opacity: "0.15", pointerEvents: "none" });
      try {
        layer.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic/unsupported pointers: dragging still works while over the layer.
      }
    });
    layer.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      const frame = this.root.getBoundingClientRect();
      const r = this.controls.get(drag.id)!.el.getBoundingClientRect();
      const w = frame.width || 1;
      const h = frame.height || 1;
      const [x, y] = placeWithin((event.clientX - drag.dx - frame.left) / w, (event.clientY - drag.dy - frame.top) / h, r.width / 2 / w, r.height / 2 / h);
      this.layout = { ...this.layout, [drag.id]: { x, y, size: this.layout[drag.id]?.size ?? 1 } };
      this.place(drag.id);
    });
    const endDrag = (event: PointerEvent) => {
      if (drag && event.pointerId === drag.pointer) {
        drag = null;
        Object.assign(bar.style, { opacity: "", pointerEvents: "" });
        describe();
      }
    };
    layer.addEventListener("pointerup", endDrag);
    layer.addEventListener("pointercancel", endDrag);
    layer.addEventListener("contextmenu", (event) => event.preventDefault());

    this.root.appendChild(layer);
    describe();
    return new Promise((resolve) => {
      this.editing = {
        finish: (layout) => {
          this.editing = null;
          layer.remove();
          for (const { el } of this.controls.values()) Object.assign(el.style, { outline: "", outlineOffset: "" });
          if (layout === null) this.layout = before;
          this.placeAll();
          this.showLook();
          resolve(layout === null ? null : { ...layout });
        },
      };
    });
  }

  /** Close the layout editor as if cancelled (a menu opened over it, say). */
  cancelLayoutEdit(): void {
    this.editing?.finish(null);
  }

  /**
   * A button for each of the game's input actions that no face button
   * carries (a grenade, a zoom, a piece of equipment): a column above the
   * face buttons, each movable in the layout editor like any control. Its
   * actions held now are {@link heldActions}.
   */
  setActionButtons(names: readonly string[]): void {
    if (names.join("\n") === this.actionNames.join("\n")) return;
    for (const old of this.actionNames) {
      const id = `act:${old}` as const;
      this.controls.get(id)?.el.remove();
      this.controls.delete(id);
    }
    this.actionHeldSet.clear();
    this.actionNames = [...names];
    const doc = this.root.ownerDocument;
    names.forEach((name, i) => {
      const id = `act:${name}` as const;
      const el = doc.createElement("button");
      el.type = "button";
      el.setAttribute("data-cbx-action", name);
      el.setAttribute("aria-label", `${name} button`);
      el.textContent = name.toUpperCase().slice(0, 10);
      Object.assign(el.style, {
        position: "absolute",
        height: `calc(${FACE_SIZE} * 0.72)`,
        minWidth: `calc(${FACE_SIZE} * 1.5)`,
        padding: "0 10px",
        pointerEvents: "auto",
        touchAction: "none",
        webkitTouchCallout: "none",
        webkitTapHighlightColor: "transparent",
        borderRadius: "999px",
        border: "2px solid rgba(255,255,255,0.45)",
        background: "rgba(20,26,40,0.45)",
        color: "rgba(255,255,255,0.92)",
        font: "700 clamp(10px, 2.2vmin, 14px)/1 system-ui, sans-serif",
        letterSpacing: "0.5px",
        cursor: "pointer",
      } as Partial<CSSStyleDeclaration>);
      // A column above the face buttons, the first nearest them.
      const home = { right: "3%", bottom: `calc(4% + 3 * ${FACE_SIZE} + 20px + ${i} * (${FACE_SIZE} * 0.72 + 8px))` };
      const held = new Set<number>();
      const setVisual = (down: boolean) => {
        el.style.background = down ? "rgba(92,208,255,0.55)" : "rgba(20,26,40,0.45)";
      };
      el.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        held.add(event.pointerId);
        try {
          el.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic/unsupported pointers: the plain press still works.
        }
        this.actionHeldSet.add(name);
        setVisual(true);
      });
      const release = (event: PointerEvent) => {
        if (!held.delete(event.pointerId) || held.size > 0) return;
        this.actionHeldSet.delete(name);
        setVisual(false);
      };
      el.addEventListener("pointerup", release);
      el.addEventListener("pointercancel", release);
      el.addEventListener("lostpointercapture", release);
      el.addEventListener("contextmenu", (event) => event.preventDefault());
      this.letGoes.push(() => {
        if (held.size === 0) return;
        held.clear();
        this.actionHeldSet.delete(name);
        setVisual(false);
      });
      this.pad.appendChild(el);
      this.controls.set(id, { el, inFace: false, home });
      this.place(id);
    });
  }

  /** The game's input actions whose touch buttons are held now (see setActionButtons). */
  get heldActions(): ReadonlySet<string> {
    return this.actionHeldSet;
  }

  /** Show the right stick (or the drag zone): the cart reads analog sticks. */
  setAnalog(on: boolean): void {
    this.analog = on;
    this.showLook();
  }

  private showLook(): void {
    this.rightStick.style.display = this.analog && this.lookMode === "stick" ? "block" : "none";
    this.lookZone.style.display = this.analog && this.lookMode === "drag" ? "block" : "none";
  }

  /**
   * Drag-to-look (C4b): the drag since the last tick (px), cleared; null when
   * the pad looks with its stick. The player turns it into look lean.
   */
  takeDrag(): [number, number] | null {
    if (this.lookMode !== "drag" || !this.analog) return null;
    const out: [number, number] = [this.dragX, this.dragY];
    this.dragX = 0;
    this.dragY = 0;
    return out;
  }

  /** A transparent zone (behind every control) that takes touches for a floating stick or drag-to-look. */
  private createZone(doc: Document, place: Partial<CSSStyleDeclaration>, label: string): HTMLElement {
    const zone = doc.createElement("div");
    zone.setAttribute("data-cbx-zone", "");
    zone.setAttribute("aria-label", label);
    Object.assign(zone.style, {
      position: "absolute",
      display: "none",
      pointerEvents: "auto",
      touchAction: "none",
      webkitTouchCallout: "none",
      webkitTapHighlightColor: "transparent",
      ...place,
    } as Partial<CSSStyleDeclaration>);
    zone.addEventListener("contextmenu", (event) => event.preventDefault());
    this.pad.appendChild(zone);
    return zone;
  }

  /** Drag-to-look: one finger at a time, its movement summed until the next tick. */
  private wireLookZone(): void {
    let pointer: number | null = null;
    let lastX = 0;
    let lastY = 0;
    this.lookZone.addEventListener("pointerdown", (event) => {
      // The newest finger looks (an earlier one's release may have gone missing).
      event.preventDefault();
      pointer = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      try {
        this.lookZone.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic/unsupported pointers: tracking still works while inside.
      }
    });
    this.lookZone.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointer) return;
      this.dragX += event.clientX - lastX;
      this.dragY += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
    });
    const end = (event: PointerEvent) => {
      if (event.pointerId === pointer) pointer = null;
    };
    this.lookZone.addEventListener("pointerup", end);
    this.lookZone.addEventListener("pointercancel", end);
    this.lookZone.addEventListener("lostpointercapture", end);
    this.letGoes.push(() => {
      pointer = null;
    });
  }

  /** A floating move stick: a touch in the zone brings the stick to the thumb, and it goes home on release. */
  private wireMoveZone(stick: { base: HTMLElement; grab: (event: PointerEvent, from: HTMLElement) => void }): void {
    this.moveZone.addEventListener("pointerdown", (event) => {
      const frame = this.root.getBoundingClientRect();
      // Centred under the thumb, whatever its size.
      Object.assign(stick.base.style, {
        left: `${event.clientX - frame.left}px`,
        top: `${event.clientY - frame.top}px`,
        right: "auto",
        bottom: "auto",
        translate: "-50% -50%",
        transformOrigin: "50% 50%",
      });
      stick.grab(event, this.moveZone);
    });
    // Home: the player's spot for it, or its corner.
    stick.base.addEventListener("cbx-stick-release", () => this.place("leftStick"));
  }

  /**
   * A virtual thumbstick: a ring you press anywhere in, and a knob that follows
   * the thumb. `grab` starts a thumb from elsewhere (a floating stick's zone),
   * tracked on that element; the stick fires "cbx-stick-release" when let go.
   */
  private createStick(
    doc: Document,
    state: GamepadState,
    index: 0 | 1,
    place: Partial<CSSStyleDeclaration>,
  ): { base: HTMLElement; grab: (event: PointerEvent, from: HTMLElement) => void } {
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
    const letGo = () => {
      pointer = null;
      state.setStick(index, 0, 0);
      knob.style.transform = "translate(0px, 0px)";
      knob.style.background = "rgba(92,208,255,0.35)";
      base.dispatchEvent(new Event("cbx-stick-release"));
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId === pointer) letGo();
    };
    this.letGoes.push(() => {
      if (pointer !== null) letGo();
    });
    const grab = (event: PointerEvent, from: HTMLElement): void => {
      // The newest finger on a stick drives it. Ignoring it while an earlier
      // finger "holds" the stick would leave the stick stuck whenever that
      // finger's release went missing.
      event.preventDefault();
      pointer = event.pointerId;
      try {
        from.setPointerCapture(event.pointerId); // keep tracking when the thumb leaves the ring
      } catch {
        // Synthetic/unsupported pointers: tracking still works while inside.
      }
      move(event);
    };
    for (const el of index === 0 ? [base, this.moveZone] : [base]) {
      el.addEventListener("pointermove", (event) => {
        if (event.pointerId === pointer) move(event);
      });
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
      el.addEventListener("lostpointercapture", end);
    }
    base.addEventListener("pointerdown", (event) => grab(event, base));
    base.addEventListener("contextmenu", (event) => event.preventDefault());
    this.pad.appendChild(base);
    return { base, grab };
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
    this.letGoes.push(() => {
      if (held.size === 0) return;
      held.clear();
      state.release(control.button);
      setVisual(false);
    });
    element.addEventListener("pointerdown", press);
    element.addEventListener("pointerup", release);
    element.addEventListener("pointercancel", release);
    element.addEventListener("lostpointercapture", release);
    element.addEventListener("contextmenu", (event) => event.preventDefault()); // iOS long-press callout
    return element;
  }

  destroy(): void {
    this.editing?.finish(null);
    for (const off of this.unlisten) off();
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
  /** Every controller button held at the last poll — what input actions read. */
  pressed: ReadonlySet<string> = NO_KEYS;
  /** The pad index in use, so a second controller plugged in later doesn't take over mid-game. */
  private index: number | null = null;

  constructor(
    private readonly nav: { getGamepads?: () => ArrayLike<(PadSnapshot & { mapping?: string; id?: string; connected?: boolean; index?: number }) | null> },
    private readonly state: GamepadState,
    private readonly settings: () => ControlSettings,
    private readonly onStart?: () => void,
    /** Buttons the cart's input actions bind: they're the actions', and press no console button. */
    private readonly claimed: () => ReadonlySet<string> = () => NO_KEYS,
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
      this.pressed = NO_KEYS;
      return;
    }
    const claimed = this.claimed();
    let bindings = this.settings().padBindings;
    if (claimed.size > 0) bindings = Object.fromEntries(Object.entries(bindings).map(([b, t]) => [b, claimed.has(b) ? null : t])) as typeof bindings;
    const { mask, axes, start, pressed } = readPad(pad, bindings, this.settings());
    this.state.setPad(mask, axes);
    this.pressed = pressed;
    if (start && !this.startHeld) this.onStart?.();
    this.startHeld = start;
  }

  /** Whether a controller is connected (for hints like "press Start"). */
  get connected(): boolean {
    return this.index !== null;
  }

  /** Rumble the controller in use (C3), where the browser and the pad can. */
  rumble(effect: RumbleEffect): void {
    if (this.index === null) return;
    const pad = this.nav.getGamepads?.()[this.index] as { vibrationActuator?: { playEffect?: (type: string, params: object) => Promise<unknown> } } | null | undefined;
    pad?.vibrationActuator?.playEffect?.("dual-rumble", { startDelay: 0, ...effect })?.catch(() => undefined);
  }
}
