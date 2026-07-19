"use client";

/**
 * Full-screen session for a ScummVM catalog title inside the handheld.
 *
 * ScummVM is a whole SDL application, not a Cartbox Game ABI module, so it runs
 * in a same-origin iframe (public/scummvm/cartbox-boot.html) that owns its own
 * canvas, main loop, audio and — via IDBFS autoPersist — its own durable saves.
 * The counterpart for `wasm-app` titles is PortedGameScreen; both present
 * identically (same stage, loading copy, SELECT = EJECT hint) so the handheld
 * feels like one console.
 *
 * The handheld's buttons reach the point-and-click engine two ways: the iframe
 * canvas receives real taps directly (the natural way to click a hotspot), and
 * the shell's forwarded buttons are translated here — the d-pad drives a virtual
 * cursor, the face buttons are mouse clicks — using the pure mapping in
 * scummvmRuntime, then dispatched as synthetic events into the iframe.
 */

import { useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/staticSite";
import { CONTROL_KEY_CODES } from "./consoleInput";
import type { ConsoleControl } from "./consoleInput";
import {
  VirtualCursor,
  controlAction,
  type CursorPosition,
} from "@/lib/scummvmRuntime";
import type { PlayingCart } from "./consoleOs";

/** Reverse of CONTROL_KEY_CODES: the shell forwards buttons as these key codes. */
const CONTROL_FOR_CODE: Readonly<Record<string, ConsoleControl>> = Object.fromEntries(
  Object.entries(CONTROL_KEY_CODES)
    .filter(([, code]) => code !== null)
    .map(([control, code]) => [code as string, control as ConsoleControl]),
);

/** Dispatches synthetic pointer/keyboard events into the ScummVM iframe canvas. */
class IframeInput {
  constructor(private readonly frame: HTMLIFrameElement) {}

  /** The iframe's realm, whose own event constructors SDL's handlers expect. */
  #window(): (Window & typeof globalThis) | null {
    return (this.frame.contentWindow as (Window & typeof globalThis) | null) ?? null;
  }

  #canvas(): HTMLCanvasElement | null {
    return (this.#window()?.document.getElementById("canvas") as HTMLCanvasElement | null) ?? null;
  }

  /** The canvas's CSS size — the coordinate space SDL maps pointer events from. */
  bounds(): { width: number; height: number } | null {
    const canvas = this.#canvas();
    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) {
      return null;
    }
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  }

  mouseMove(position: CursorPosition): void {
    this.#mouse("mousemove", position);
  }

  mouseButton(button: number, down: boolean, position: CursorPosition): void {
    this.#mouse(down ? "mousedown" : "mouseup", position, button);
  }

  key(code: string, down: boolean): void {
    const win = this.#window();
    const canvas = this.#canvas();
    if (!win || !canvas) return;
    canvas.dispatchEvent(new win.KeyboardEvent(down ? "keydown" : "keyup", { code, bubbles: true }));
  }

  #mouse(type: string, position: CursorPosition, button = 0): void {
    const win = this.#window();
    const canvas = this.#canvas();
    if (!win || !canvas) return;
    canvas.dispatchEvent(
      new win.MouseEvent(type, {
        clientX: position.x,
        clientY: position.y,
        button,
        buttons: type === "mousedown" ? (button === 2 ? 2 : 1) : 0,
        bubbles: true,
        view: win,
      }),
    );
  }
}

export function ScummVmPlayer({ cart, onExit }: { cart: PlayingCart; onExit: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const inputRef = useRef<IframeInput | null>(null);
  const cursorRef = useRef<VirtualCursor | null>(null);
  const rafRef = useRef<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const target = cart.game?.target ?? "";
  const src = withBasePath(`/scummvm/cartbox-boot.html#${encodeURIComponent(target)}`);

  // The engine reports readiness and hard failures by postMessage, so the host
  // can drop the loading overlay without polling pixels.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string } | null;
      if (data?.source !== "cartbox-scummvm") return;
      if (data.type === "runtime-initialized") setStatus("ready");
      else if (data.type === "error") setStatus("error");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Advance the virtual cursor each frame and push a pointer move when it moved.
  // The cursor is created lazily once the iframe canvas has a measurable size,
  // so its bounds match the space SDL maps clicks from.
  useEffect(() => {
    const step = () => {
      const input = inputRef.current;
      if (input) {
        if (!cursorRef.current) {
          const bounds = input.bounds();
          if (bounds) cursorRef.current = new VirtualCursor(bounds);
        }
        const cursor = cursorRef.current;
        if (cursor) {
          const moved = cursor.advance(1 / 60);
          if (moved) input.mouseMove(moved);
        }
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Translate the shell's forwarded buttons (arrow keys + Z/X/A/S) into ScummVM
  // pointer and key input. Real taps on the canvas pass through the iframe
  // untouched, so a player can also just click a hotspot.
  useEffect(() => {
    const route = (code: string, down: boolean): void => {
      const control = CONTROL_FOR_CODE[code];
      const input = inputRef.current;
      const cursor = cursorRef.current;
      if (!control || !input) return;
      const action = controlAction(control);
      if (!action) return;
      switch (action.kind) {
        case "cursor":
          if (cursor) {
            if (down) cursor.hold(action.direction);
            else cursor.release(action.direction);
          }
          break;
        case "mouse":
          input.mouseButton(action.button, down, cursor?.position ?? { x: 0, y: 0 });
          break;
        case "key":
          input.key(action.code, down);
          break;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => route(event.code, true);
    const onKeyUp = (event: KeyboardEvent) => route(event.code, false);
    const onBlur = () => cursorRef.current?.releaseAll();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const onFrameLoad = () => {
    if (frameRef.current) {
      inputRef.current = new IframeInput(frameRef.current);
    }
  };

  return (
    <div className="os-stage os-game" data-testid="game-screen">
      <div className="os-game-stage">
        <iframe
          ref={frameRef}
          className="os-scummvm-frame"
          src={src}
          title={cart.title}
          onLoad={onFrameLoad}
          // The engine draws the whole screen; no extra chrome, no scrolling.
          style={{ width: "100%", height: "100%", border: 0, display: "block", background: "#000" }}
          // Point-and-click needs the pointer; the sandbox still blocks top
          // navigation and popups from the embedded engine.
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
      {status === "loading" && <div className="os-loading">LOADING GAME…</div>}
      {status === "error" && (
        <div className="os-loading" role="alert">
          GAME ERROR —{" "}
          <button type="button" className="os-auth-switch" onClick={onExit}>
            EJECT
          </button>
        </div>
      )}
      <div className="os-game-hint">{cart.title} · SELECT = EJECT</div>
    </div>
  );
}
