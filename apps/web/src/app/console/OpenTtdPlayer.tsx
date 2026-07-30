"use client";

/**
 * Full-screen session for the OpenTTD catalog title inside the handheld.
 *
 * OpenTTD is a whole SDL2 application, not a Cartbox Game ABI module, so — like
 * the other engine runtimes — it runs in a same-origin iframe
 * (public/openttd/cartbox-boot.html) that owns its canvas, main loop, audio and
 * (via IDBFS) its saves. It presents identically to the other iframe players
 * (same stage, loading copy, SELECT = EJECT hint) so the handheld feels like one
 * console.
 *
 * The wrinkle that makes OpenTTD different from every other runtime: it is a
 * point-and-click tycoon with no keyboard-only play. So the console drives an
 * *emulated cursor*. This component keeps a virtual pointer position, nudges it
 * from the held d-pad directions each animation frame, and realises the pure
 * openttdRuntime actions as synthetic DOM events dispatched into the iframe:
 *   - move  → a `mousemove` at the new cursor position (carrying any held button,
 *             so a held A drags and a held B scrolls the map),
 *   - mouse → `mousedown` on press / `mouseup` on release (tap = click, hold =
 *             drag),
 *   - wheel → a `wheel` event at the cursor (zoom),
 *   - key   → a `keydown`/`keyup` (Escape closes the front window).
 *
 * The coordinate math mirrors Emscripten's own: a target given in canvas *internal*
 * pixels maps to `clientX = rect.left + x * rect.width / canvas.width`, so the
 * synthetic event lands exactly where OpenTTD's SDL2 backend expects the pointer.
 * OpenTTD draws its own cursor sprite at that position, so no DOM cursor overlay is
 * needed.
 */

import { useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/staticSite";
import { CONTROL_KEY_CODES } from "./consoleInput";
import type { ConsoleControl } from "./consoleInput";
import {
  OPENTTD_CURSOR_PIXELS_PER_FRAME,
  openttdActionForControl,
} from "@/lib/openttdRuntime";
import type { PlayingCart } from "./consoleOs";

/** Reverse of CONTROL_KEY_CODES: the shell forwards buttons as these key codes. */
const CONTROL_FOR_CODE: Readonly<Record<string, ConsoleControl>> = Object.fromEntries(
  Object.entries(CONTROL_KEY_CODES)
    .filter(([, code]) => code !== null)
    .map(([control, code]) => [code as string, control as ConsoleControl]),
);

/** Left- and right-button bits of the DOM `buttons` bitmask. */
const LEFT_BIT = 1;
const RIGHT_BIT = 2;

/**
 * Drives the emulated cursor and dispatches synthetic mouse/wheel/key events into
 * the OpenTTD iframe. Owns the pointer position and the currently-held buttons so
 * a d-pad move while A (or B) is held becomes a drag (or a map scroll).
 */
class EmulatedCursor {
  /** Cursor position in canvas *internal* pixels; null until the canvas is sized. */
  private x: number | null = null;
  private y: number | null = null;
  /** DOM `buttons` bitmask of the mouse buttons currently held. */
  private buttons = 0;

  constructor(private readonly frame: HTMLIFrameElement) {}

  private canvas(): HTMLCanvasElement | null {
    const win = this.frame.contentWindow as (Window & typeof globalThis) | null;
    return (win?.document.getElementById("canvas") as HTMLCanvasElement | null) ?? null;
  }

  /** Ensure the cursor has a position, centring it the first time the canvas exists. */
  private ensurePosition(canvas: HTMLCanvasElement): void {
    if (this.x === null || this.y === null) {
      this.x = canvas.width / 2;
      this.y = canvas.height / 2;
    }
  }

  private dispatch(type: string, extra: Record<string, number>): void {
    const win = this.frame.contentWindow as (Window & typeof globalThis) | null;
    const canvas = this.canvas();
    if (!win || !canvas || this.x === null || this.y === null) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const clientX = rect.left + this.x * (rect.width / canvas.width);
    const clientY = rect.top + this.y * (rect.height / canvas.height);
    canvas.dispatchEvent(
      new win.MouseEvent(type, { clientX, clientY, bubbles: true, view: win, ...extra }),
    );
  }

  /** Move the cursor by (dx, dy) internal pixels and emit a mousemove. */
  move(dx: number, dy: number): void {
    const canvas = this.canvas();
    if (!canvas) return;
    this.ensurePosition(canvas);
    if (this.x === null || this.y === null) return;
    this.x = Math.max(0, Math.min(canvas.width, this.x + dx));
    this.y = Math.max(0, Math.min(canvas.height, this.y + dy));
    this.dispatch("mousemove", { button: 0, buttons: this.buttons });
  }

  /** Press a mouse button at the current cursor (tap begins here; drag continues on move). */
  press(button: 0 | 2): void {
    const canvas = this.canvas();
    if (!canvas) return;
    this.ensurePosition(canvas);
    this.buttons |= button === 0 ? LEFT_BIT : RIGHT_BIT;
    this.dispatch("mousedown", { button, buttons: this.buttons });
  }

  /** Release a mouse button at the current cursor. */
  release(button: 0 | 2): void {
    this.buttons &= ~(button === 0 ? LEFT_BIT : RIGHT_BIT);
    this.dispatch("mouseup", { button, buttons: this.buttons });
  }

  /** Emit a wheel event at the cursor. dir -1 zooms in, +1 zooms out. */
  wheel(dir: -1 | 1): void {
    const win = this.frame.contentWindow as (Window & typeof globalThis) | null;
    const canvas = this.canvas();
    if (!win || !canvas) return;
    this.ensurePosition(canvas);
    if (this.x === null || this.y === null) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const clientX = rect.left + this.x * (rect.width / canvas.width);
    const clientY = rect.top + this.y * (rect.height / canvas.height);
    canvas.dispatchEvent(
      new win.WheelEvent("wheel", { clientX, clientY, deltaY: dir * 100, bubbles: true, view: win }),
    );
  }

  /** Dispatch a keyboard event into the iframe (for Escape and friends). */
  key(code: string, keyCode: number, down: boolean): void {
    const win = this.frame.contentWindow as (Window & typeof globalThis) | null;
    if (!win) return;
    const target = win.document.getElementById("canvas") ?? win.document;
    target.dispatchEvent(
      new win.KeyboardEvent(down ? "keydown" : "keyup", { code, keyCode, bubbles: true }),
    );
  }
}

export function OpenTtdPlayer({ cart, onExit }: { cart: PlayingCart; onExit: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const cursorRef = useRef<EmulatedCursor | null>(null);
  /** Directions currently held, as unit velocity components. */
  const heldRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [progress, setProgress] = useState<number | null>(null);

  const src = withBasePath("/openttd/cartbox-boot.html");

  // The engine reports load progress, readiness and hard failures by postMessage.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string; loaded?: number; total?: number } | null;
      if (data?.source !== "cartbox-openttd") return;
      if (data.type === "runtime-initialized") setStatus("ready");
      else if (data.type === "error") setStatus("error");
      else if (data.type === "progress" && data.total) {
        setProgress(Math.min(100, Math.round((100 * (data.loaded ?? 0)) / data.total)));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Drive the emulated cursor: an animation loop nudges the pointer from held
  // directions, and forwarded buttons become mouse/wheel/key actions. The whole
  // input contract lives in the pure openttdRuntime map.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const cursor = cursorRef.current;
      const held = heldRef.current;
      if (cursor && (held.x !== 0 || held.y !== 0)) {
        cursor.move(held.x * OPENTTD_CURSOR_PIXELS_PER_FRAME, held.y * OPENTTD_CURSOR_PIXELS_PER_FRAME);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const route = (code: string, down: boolean): void => {
      const control = CONTROL_FOR_CODE[code];
      const cursor = cursorRef.current;
      if (!control || !cursor) return;
      const action = openttdActionForControl(control);
      if (!action) return;

      switch (action.kind) {
        case "move":
          // Set/clear the held velocity component; the rAF loop integrates it.
          if (action.axis === "x") heldRef.current.x = down ? action.dir : 0;
          else heldRef.current.y = down ? action.dir : 0;
          break;
        case "mouse":
          if (down) cursor.press(action.button);
          else cursor.release(action.button);
          break;
        case "wheel":
          if (down) cursor.wheel(action.dir); // edge-triggered: one notch per press
          break;
        case "key":
          cursor.key(action.code, action.keyCode, down);
          break;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => route(event.code, true);
    const onKeyUp = (event: KeyboardEvent) => route(event.code, false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const onFrameLoad = () => {
    if (frameRef.current) {
      cursorRef.current = new EmulatedCursor(frameRef.current);
    }
  };

  return (
    <div className="os-stage os-game" data-testid="game-screen">
      <div className="os-game-stage">
        <iframe
          ref={frameRef}
          className="os-supertux-frame"
          src={src}
          title={cart.title}
          onLoad={onFrameLoad}
          style={{ width: "100%", height: "100%", border: 0, display: "block", background: "#000" }}
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
      {status === "loading" && (
        <div className="os-loading">
          {progress !== null ? `LOADING GAME… ${progress}%` : "LOADING GAME…"}
        </div>
      )}
      {status === "error" && (
        <div className="os-loading" role="alert">
          GAME ERROR —{" "}
          <button type="button" className="os-auth-switch" onClick={onExit}>
            EJECT
          </button>
        </div>
      )}
      <div className="os-game-hint">{cart.title} · d-pad = cursor · A = click · B = scroll · SELECT = EJECT</div>
    </div>
  );
}
