/**
 * Tablet input for the editor's canvases (TABLET_EDITOR_ROADMAP.md T1): what a
 * mouse, an Apple Pencil or a finger reports, how far a pick by each reaches,
 * and a recogniser that turns raw pointers into what a canvas acts on — tool
 * strokes, orbit or pan, pinch zoom, undo/redo taps and long presses.
 *
 * - The Pencil is the tool. While it's down, fingers are a resting palm and
 *   are ignored.
 * - One finger draws until a Pencil has been used, then navigates (a tap still
 *   picks); `fingers` forces either. A finger is held back until it's clearly
 *   drawing (it moves) so that a second finger landing turns the touch into a
 *   gesture rather than a stroke — and a stroke a second finger interrupts is
 *   cancelled.
 * - Two fingers drag (orbit or pan, as the canvas likes) and pinch (zoom);
 *   three pan. A quick two-finger tap is undo, three-finger redo.
 * - A finger held still is a long press: what right-click or Alt-click does.
 *
 * Pure: it is fed samples and the time, and returns events. `useGestures`
 * (tabletGestures.ts) wires it to a canvas.
 */

export type PointerKind = "mouse" | "pen" | "touch";

/** One pointer at one moment: page (client) pixels, milliseconds. */
export interface PointerSample {
  readonly id: number;
  readonly kind: PointerKind;
  readonly x: number;
  readonly y: number;
  readonly t: number;
  /** The button that changed (0 primary, 2 secondary), as PointerEvent.button. */
  readonly button: number;
  /** The buttons held, as PointerEvent.buttons (0 for a hovering Pencil or mouse). */
  readonly buttons: number;
  /** 0..1: a Pencil's force; 1 for a mouse button or a finger, which report none worth using. */
  readonly pressure: number;
  /** Degrees the Pencil leans along x and y (0 upright), and its barrel turned (0..359). */
  readonly tiltX: number;
  readonly tiltY: number;
  readonly twist: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

/** The fields of a PointerEvent a sample reads. */
export interface PointerLike {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly timeStamp: number;
  readonly button: number;
  readonly buttons: number;
  readonly pressure: number;
  readonly tiltX?: number;
  readonly tiltY?: number;
  readonly twist?: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

export function pointerKind(type: string): PointerKind {
  return type === "pen" ? "pen" : type === "touch" ? "touch" : "mouse";
}

/** A pointer event as a sample. */
export function samplePointer(e: PointerLike): PointerSample {
  const kind = pointerKind(e.pointerType);
  // A Pencil on the glass reports its force (Safari can report 0 on the very
  // first contact: a floor keeps that dab from vanishing); off it, 0.
  const pressure = kind === "pen" ? (e.buttons !== 0 ? Math.max(0.05, Math.min(1, e.pressure || 0)) : 0) : 1;
  return {
    id: e.pointerId,
    kind,
    x: e.clientX,
    y: e.clientY,
    t: e.timeStamp,
    button: e.button,
    buttons: e.buttons,
    pressure,
    tiltX: e.tiltX ?? 0,
    tiltY: e.tiltY ?? 0,
    twist: e.twist ?? 0,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    metaKey: e.metaKey,
    altKey: e.altKey,
  };
}

/**
 * How much of a brush a stroke lays down, 0..1: a Pencil's pressure on a
 * gentle curve (light touches stay usable, a firm press reaches full), and
 * full strength for a mouse or a finger.
 */
export function strokePressure(sample: Pick<PointerSample, "kind" | "pressure">): number {
  if (sample.kind !== "pen") return 1;
  return Math.max(0.08, Math.min(1, sample.pressure ** 0.8));
}

/** What a Pencil's pressure scales on a paint brush. */
export type PressureMode = "both" | "size" | "opacity" | "off";

/** The brush a dab at `pressure` paints with: pressure scales its size (down to 40%) and/or its opacity. */
export function pressureBrush(radius: number, opacity: number, pressure: number, mode: PressureMode): { radius: number; opacity: number } {
  const p = Math.max(0, Math.min(1, pressure));
  return {
    radius: mode === "both" || mode === "size" ? radius * (0.4 + 0.6 * p) : radius,
    opacity: mode === "both" || mode === "opacity" ? opacity * p : opacity,
  };
}

/** How far (CSS pixels) a pick by each kind of pointer reaches: a fingertip covers far more than a cursor's hot spot. */
export const PICK_REACH_PX: Readonly<Record<PointerKind, number>> = { mouse: 8, pen: 11, touch: 24 };

/**
 * A pick radius in normalised device units (the -1..1 square) for a canvas
 * `cssWidth` pixels wide, never below `floor` (the radius the canvas used
 * before reach depended on the pointer).
 */
export function pickReachNdc(kind: PointerKind, cssWidth: number, floor = 0): number {
  if (!(cssWidth > 0)) return floor;
  return Math.max(floor, PICK_REACH_PX[kind] / (cssWidth / 2));
}

/** The touch bar's stand-ins for held keys: Add (Shift), Remove (Ctrl/⌘) and Loop (Alt). */
export interface TouchModifiers {
  readonly add: boolean;
  readonly remove: boolean;
  readonly loop: boolean;
}

export const NO_MODIFIERS: TouchModifiers = { add: false, remove: false, loop: false };

/** A sample with the touch bar's toggles added to the keys it reports held. */
export function withModifiers(sample: PointerSample, mods: TouchModifiers): PointerSample {
  if (!mods.add && !mods.remove && !mods.loop) return sample;
  return { ...sample, shiftKey: sample.shiftKey || mods.add, ctrlKey: sample.ctrlKey || mods.remove, altKey: sample.altKey || mods.loop };
}

export type GestureEvent =
  | { readonly type: "tool-down" | "tool-move" | "tool-up"; readonly sample: PointerSample }
  /** The stroke under way is abandoned (a second finger made it a gesture, or the pointer was cancelled): undo what it did. */
  | { readonly type: "tool-cancel" }
  /** A mouse or a Pencil moving over the canvas without pressing. */
  | { readonly type: "hover"; readonly sample: PointerSample }
  /** Drag the view by (dx, dy) page pixels. */
  | { readonly type: "orbit" | "pan"; readonly dx: number; readonly dy: number }
  /** Zoom by `factor` (above 1: closer, fingers spreading) about (x, y). */
  | { readonly type: "zoom"; readonly factor: number; readonly x: number; readonly y: number }
  | { readonly type: "undo" | "redo" }
  /** A finger held still: what a right-click or an Alt-click does. */
  | { readonly type: "long-press"; readonly sample: PointerSample };

export interface GestureOptions {
  /** What one finger does: draw (the tool), navigate, or draw until a Pencil is seen (default). */
  readonly fingers?: "auto" | "draw" | "navigate";
  /** What dragging the view does: turn round it (3D) or slide it (2D). Default orbit. */
  readonly drag?: "orbit" | "pan";
  /** How far (px) a finger moves before it counts as moving. Default 8. */
  readonly slop?: number;
  /** How long (ms) a still finger is held before it's a long press. Default 500. */
  readonly longPressMs?: number;
  /** How long (ms) a multi-finger touch may last and still be a tap. Default 300. */
  readonly tapMs?: number;
}

interface Touch {
  readonly start: PointerSample;
  last: PointerSample;
}

type Mode =
  | "idle"
  /** One finger down, not yet moved: a tap, a stroke or a long press. */
  | "pending"
  /** A stroke (mouse, Pencil or a drawing finger). */
  | "tool"
  /** One navigating finger. */
  | "navigate"
  /** Two or more fingers. */
  | "gesture"
  /** A long press fired: nothing more until the finger lifts. */
  | "held";

/** Turns pointer samples into canvas events (see the module comment). */
export class GestureRecognizer {
  /** A Pencil has been used: one finger navigates from now on (with `fingers: "auto"`). */
  penSeen = false;
  private mode: Mode = "idle";
  private readonly touches = new Map<number, Touch>();
  /** Touches that landed under a Pencil (a palm): ignored until they lift. */
  private readonly ignored = new Set<number>();
  /** The pointer drawing (mouse, Pencil or finger), or null. */
  private toolId: number | null = null;
  private toolIsTouch = false;
  /** The mouse or Pencil pointer down, or null. */
  private down_: number | null = null;
  /** The multi-finger touch: when it began, the most fingers it had, how far it moved, and its last centre and spread. */
  private gesture = { t: 0, fingers: 0, moved: 0, cx: 0, cy: 0, spread: 0 };
  /** One finger: how far it has moved (for tap vs drag). */
  private travelled = 0;

  constructor(private options: GestureOptions = {}) {}

  setOptions(options: GestureOptions): void {
    this.options = options;
  }

  private get slop(): number {
    return this.options.slop ?? 8;
  }

  /** Whether one finger draws (rather than navigates) right now. */
  fingersDraw(): boolean {
    const fingers = this.options.fingers ?? "auto";
    return fingers === "draw" || (fingers === "auto" && !this.penSeen);
  }

  down(s: PointerSample): GestureEvent[] {
    if (s.kind !== "touch") {
      const out: GestureEvent[] = [];
      if (s.kind === "pen") {
        this.penSeen = true;
        // A Pencil lands while fingers are on the glass: they're a palm. Drop
        // whatever they were doing (cancel a finger stroke) and ignore them.
        if (this.toolIsTouch && this.mode === "tool") out.push({ type: "tool-cancel" });
        for (const id of this.touches.keys()) this.ignored.add(id);
        this.touches.clear();
      }
      this.down_ = s.id;
      this.toolId = s.id;
      this.toolIsTouch = false;
      this.mode = "tool";
      out.push({ type: "tool-down", sample: s });
      return out;
    }
    // A finger under a Pencil that's down: a palm.
    if (this.down_ !== null && this.mode === "tool" && !this.toolIsTouch) {
      this.ignored.add(s.id);
      return [];
    }
    this.touches.set(s.id, { start: s, last: s });
    if (this.touches.size === 1) {
      this.travelled = 0;
      this.toolId = s.id;
      this.toolIsTouch = true;
      this.mode = this.fingersDraw() ? "pending" : "navigate";
      return [];
    }
    // A second (or third) finger: a gesture. A stroke the first finger had begun is abandoned.
    const out: GestureEvent[] = this.mode === "tool" && this.toolIsTouch ? [{ type: "tool-cancel" }] : [];
    if (this.mode !== "gesture") this.gesture = { t: this.firstTouchTime(), fingers: 0, moved: this.travelled, cx: 0, cy: 0, spread: 0 };
    this.mode = "gesture";
    this.toolId = null;
    this.gesture.fingers = Math.max(this.gesture.fingers, this.touches.size);
    this.rebase();
    return out;
  }

  move(s: PointerSample): GestureEvent[] {
    if (s.kind !== "touch") {
      if (this.down_ === s.id && this.mode === "tool") return [{ type: "tool-move", sample: s }];
      if (this.down_ === null && s.buttons === 0) return [{ type: "hover", sample: s }];
      return [];
    }
    const touch = this.touches.get(s.id);
    if (!touch) return [];
    const prev = touch.last;
    touch.last = s;
    switch (this.mode) {
      case "pending": {
        this.travelled += Math.hypot(s.x - prev.x, s.y - prev.y);
        if (Math.hypot(s.x - touch.start.x, s.y - touch.start.y) <= this.slop) return [];
        this.mode = "tool";
        return [
          { type: "tool-down", sample: touch.start },
          { type: "tool-move", sample: s },
        ];
      }
      case "tool":
        return this.toolId === s.id ? [{ type: "tool-move", sample: s }] : [];
      case "navigate": {
        this.travelled += Math.hypot(s.x - prev.x, s.y - prev.y);
        if (this.travelled <= this.slop && Math.hypot(s.x - touch.start.x, s.y - touch.start.y) <= this.slop) return [];
        return [{ type: this.options.drag ?? "orbit", dx: s.x - prev.x, dy: s.y - prev.y }];
      }
      case "gesture": {
        const { cx, cy, spread } = this.centre();
        const dx = cx - this.gesture.cx;
        const dy = cy - this.gesture.cy;
        const out: GestureEvent[] = [];
        if (dx !== 0 || dy !== 0) out.push({ type: this.touches.size >= 3 ? "pan" : (this.options.drag ?? "orbit"), dx, dy });
        if (this.touches.size >= 2 && this.gesture.spread > 0 && spread > 0 && spread !== this.gesture.spread) {
          out.push({ type: "zoom", factor: spread / this.gesture.spread, x: cx, y: cy });
        }
        this.gesture.moved += Math.hypot(dx, dy) + Math.abs(spread - this.gesture.spread);
        this.gesture.cx = cx;
        this.gesture.cy = cy;
        this.gesture.spread = spread;
        return out;
      }
      default:
        return [];
    }
  }

  up(s: PointerSample): GestureEvent[] {
    return this.lift(s, false);
  }

  /** The browser took the pointer away (pointercancel): a stroke under way is abandoned. */
  cancel(s: PointerSample): GestureEvent[] {
    return this.lift(s, true);
  }

  /** Called a little after a finger lands (and on any later timer): fires a long press once a still finger has been held long enough. */
  tick(now: number): GestureEvent[] {
    if ((this.mode !== "pending" && this.mode !== "navigate") || this.touches.size !== 1) return [];
    const touch = [...this.touches.values()][0]!;
    if (now - touch.start.t < (this.options.longPressMs ?? 500)) return [];
    if (this.travelled > this.slop || Math.hypot(touch.last.x - touch.start.x, touch.last.y - touch.start.y) > this.slop) return [];
    this.mode = "held";
    return [{ type: "long-press", sample: touch.start }];
  }

  private lift(s: PointerSample, cancelled: boolean): GestureEvent[] {
    if (s.kind !== "touch") {
      if (this.down_ !== s.id) return [];
      this.down_ = null;
      this.toolId = null;
      this.mode = "idle";
      return [cancelled ? { type: "tool-cancel" } : { type: "tool-up", sample: s }];
    }
    if (this.ignored.delete(s.id)) return [];
    const touch = this.touches.get(s.id);
    if (!touch) return [];
    this.touches.delete(s.id);
    const mode = this.mode;
    const out: GestureEvent[] = [];
    if (mode === "pending" || mode === "navigate") {
      // A finger lifted without having moved: a tap, which picks as a click does.
      const still = this.travelled <= this.slop && Math.hypot(s.x - touch.start.x, s.y - touch.start.y) <= this.slop;
      if (still && !cancelled) out.push({ type: "tool-down", sample: touch.start }, { type: "tool-up", sample: { ...s, x: touch.start.x, y: touch.start.y } });
    } else if (mode === "tool") {
      if (this.toolId === s.id) out.push(cancelled ? { type: "tool-cancel" } : { type: "tool-up", sample: s });
    } else if (mode === "gesture") {
      if (this.touches.size > 0) {
        // Fingers remain: carry on from where they are (no jump).
        this.rebase();
        return out;
      }
      const quick = s.t - this.gesture.t <= (this.options.tapMs ?? 300) && this.gesture.moved <= this.slop * 2;
      if (quick && !cancelled) out.push({ type: this.gesture.fingers >= 3 ? "redo" : "undo" });
    }
    if (this.touches.size === 0) {
      this.mode = "idle";
      this.toolId = null;
      this.toolIsTouch = false;
    }
    return out;
  }

  private firstTouchTime(): number {
    let t = Infinity;
    for (const touch of this.touches.values()) t = Math.min(t, touch.start.t);
    return Number.isFinite(t) ? t : 0;
  }

  /** The centre of the fingers down and their spread (mean distance from it). */
  private centre(): { cx: number; cy: number; spread: number } {
    let cx = 0;
    let cy = 0;
    for (const touch of this.touches.values()) {
      cx += touch.last.x;
      cy += touch.last.y;
    }
    const n = Math.max(1, this.touches.size);
    cx /= n;
    cy /= n;
    let spread = 0;
    for (const touch of this.touches.values()) spread += Math.hypot(touch.last.x - cx, touch.last.y - cy);
    return { cx, cy, spread: spread / n };
  }

  private rebase(): void {
    const { cx, cy, spread } = this.centre();
    this.gesture.cx = cx;
    this.gesture.cy = cy;
    this.gesture.spread = spread;
  }
}
