"use client";

/**
 * Full-screen session for the Cube 2: Sauerbraten catalog title in the handheld.
 *
 * Cube 2 runs on BananaBread (a WASM+WebGL port of the Cube 2 engine), so — like
 * ScummVM / SuperTux / DOS / Quake — it runs in a same-origin iframe
 * (public/cube2/cartbox-boot.html) that owns its canvas, loop, audio and saves.
 *
 * The shell forwards each console button as a synthetic KeyboardEvent on
 * `window`; this component re-dispatches the mapped Cube 2 action (see the pure
 * cube2Runtime map) into the iframe. The subtlety unique to Cube 2 is that the
 * engine is mouse-look only — it has no keyboard-turn bind — so the d-pad's
 * left/right do not send keys; instead, while held they run an animation-frame
 * loop that synthesizes mouse motion into the canvas, which is how the engine
 * turns the view. Face buttons are keys, forced with a legacy keyCode the way
 * DosPlayer does (the constructor's init dict cannot set keyCode).
 */

import { useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/staticSite";
import { CONTROL_KEY_CODES } from "./consoleInput";
import type { ConsoleControl } from "./consoleInput";
import { cube2ActionForControl, CUBE2_TURN_PIXELS_PER_FRAME } from "@/lib/cube2Runtime";
import type { PlayingCart } from "./consoleOs";

/** Reverse of CONTROL_KEY_CODES: the shell forwards buttons as these key codes. */
const CONTROL_FOR_CODE: Readonly<Record<string, ConsoleControl>> = Object.fromEntries(
  Object.entries(CONTROL_KEY_CODES)
    .filter(([, code]) => code !== null)
    .map(([control, code]) => [code as string, control as ConsoleControl]),
);

/** Bridges the shell's forwarded buttons into the BananaBread iframe. */
class IframeInput {
  /** Net turn direction currently held (sum of -1 left and +1 right presses). */
  #turn = 0;
  #rafId: number | null = null;
  /** Accumulated synthetic cursor X, so successive events also carry a real delta. */
  #cursorX = 400;

  constructor(private readonly frame: HTMLIFrameElement) {}

  #window(): (Window & typeof globalThis) | null {
    return (this.frame.contentWindow as (Window & typeof globalThis) | null) ?? null;
  }

  #canvas(): HTMLCanvasElement | null {
    return (this.#window()?.document.getElementById("canvas") as HTMLCanvasElement | null) ?? null;
  }

  key(code: string, keyCode: number, down: boolean): void {
    const win = this.#window();
    const doc = win?.document;
    if (!win || !doc) return;
    const event = new win.KeyboardEvent(down ? "keydown" : "keyup", {
      code,
      key: code,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "keyCode", { get: () => keyCode });
    Object.defineProperty(event, "which", { get: () => keyCode });
    // Emscripten registers its keyboard handler on the document.
    doc.dispatchEvent(event);
  }

  /** Begin/stop synthesizing yaw for a held turn direction. */
  turn(direction: -1 | 1, down: boolean): void {
    this.#turn += down ? direction : -direction;
    if (this.#turn !== 0) this.#startTurnLoop();
    else this.#stopTurnLoop();
  }

  #startTurnLoop(): void {
    const win = this.#window();
    if (this.#rafId !== null || !win) return;
    const step = () => {
      if (this.#turn === 0) {
        this.#rafId = null;
        return;
      }
      const dx = Math.sign(this.#turn) * CUBE2_TURN_PIXELS_PER_FRAME;
      this.#emitMouseMove(dx);
      this.#rafId = win.requestAnimationFrame(step);
    };
    this.#rafId = win.requestAnimationFrame(step);
  }

  #stopTurnLoop(): void {
    const win = this.#window();
    if (this.#rafId !== null && win) win.cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
  }

  /** Dispatch one relative-motion event, covering both movementX and clientX deltas. */
  #emitMouseMove(dx: number): void {
    const win = this.#window();
    const canvas = this.#canvas();
    if (!win || !canvas) return;
    this.#cursorX += dx;
    const event = new win.MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: this.#cursorX,
      clientY: 300,
    });
    Object.defineProperty(event, "movementX", { get: () => dx });
    Object.defineProperty(event, "movementY", { get: () => 0 });
    canvas.dispatchEvent(event);
  }

  dispose(): void {
    this.#stopTurnLoop();
    this.#turn = 0;
  }
}

export function Cube2Player({ cart, onExit }: { cart: PlayingCart; onExit: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const inputRef = useRef<IframeInput | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const src = withBasePath("/cube2/cartbox-boot.html");

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string } | null;
      if (data?.source !== "cartbox-cube2") return;
      if (data.type === "runtime-initialized") setStatus("ready");
      else if (data.type === "error") setStatus("error");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const route = (code: string, down: boolean): void => {
      const control = CONTROL_FOR_CODE[code];
      const input = inputRef.current;
      if (!control || !input) return;
      const action = cube2ActionForControl(control);
      if (!action) return;
      if (action.kind === "key") input.key(action.code, action.keyCode, down);
      else input.turn(action.direction, down);
    };
    const onKeyDown = (event: KeyboardEvent) => route(event.code, true);
    const onKeyUp = (event: KeyboardEvent) => route(event.code, false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      inputRef.current?.dispose();
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
          className="os-cube2-frame"
          src={src}
          title={cart.title}
          onLoad={onFrameLoad}
          style={{ width: "100%", height: "100%", border: 0, display: "block", background: "#000" }}
          sandbox="allow-scripts allow-same-origin allow-pointer-lock"
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
