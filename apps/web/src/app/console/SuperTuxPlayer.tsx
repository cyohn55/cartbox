"use client";

/**
 * Full-screen session for the SuperTux catalog title inside the handheld.
 *
 * SuperTux is a whole SDL3/GLES2 application, not a Cartbox Game ABI module, so
 * — like ScummVM — it runs in a same-origin iframe (public/supertux/cartbox-boot.html)
 * that owns its canvas, main loop, audio and (via IDBFS) its saves. It presents
 * identically to GameScreen / PortedGameScreen / ScummVmPlayer (same stage,
 * loading copy, SELECT = EJECT hint) so the handheld feels like one console.
 *
 * Because SuperTux is keyboard-driven, the integration is simpler than ScummVM's
 * virtual cursor: the shell forwards each button as a synthetic KeyboardEvent
 * on `window`, and this component re-dispatches the SuperTux key (see the pure
 * supertuxRuntime map) into the iframe canvas. Real taps still pass through.
 */

import { useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/staticSite";
import { CONTROL_KEY_CODES } from "./consoleInput";
import type { ConsoleControl } from "./consoleInput";
import { supertuxKeyForControl } from "@/lib/supertuxRuntime";
import type { PlayingCart } from "./consoleOs";

/** Reverse of CONTROL_KEY_CODES: the shell forwards buttons as these key codes. */
const CONTROL_FOR_CODE: Readonly<Record<string, ConsoleControl>> = Object.fromEntries(
  Object.entries(CONTROL_KEY_CODES)
    .filter(([, code]) => code !== null)
    .map(([control, code]) => [code as string, control as ConsoleControl]),
);

/** Dispatches synthetic keyboard events into the SuperTux iframe canvas. */
class IframeKeyboard {
  constructor(private readonly frame: HTMLIFrameElement) {}

  #window(): (Window & typeof globalThis) | null {
    return (this.frame.contentWindow as (Window & typeof globalThis) | null) ?? null;
  }

  #canvas(): HTMLCanvasElement | null {
    return (this.#window()?.document.getElementById("canvas") as HTMLCanvasElement | null) ?? null;
  }

  key(code: string, down: boolean): void {
    const win = this.#window();
    const canvas = this.#canvas();
    if (!win || !canvas) return;
    // SDL3's Emscripten backend keys off `code`; `key`/`keyCode` are filled so
    // handlers that read them still see a coherent event.
    canvas.dispatchEvent(new win.KeyboardEvent(down ? "keydown" : "keyup", { code, bubbles: true }));
  }
}

export function SuperTuxPlayer({ cart, onExit }: { cart: PlayingCart; onExit: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const inputRef = useRef<IframeKeyboard | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [progress, setProgress] = useState<number | null>(null);

  const target = cart.game?.target ?? "";
  const src = withBasePath(`/supertux/cartbox-boot.html${target ? `#${encodeURIComponent(target)}` : ""}`);

  // The engine reports load progress, readiness and hard failures by postMessage.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string; loaded?: number; total?: number } | null;
      if (data?.source !== "cartbox-supertux") return;
      if (data.type === "runtime-initialized") setStatus("ready");
      else if (data.type === "error") setStatus("error");
      else if (data.type === "progress" && data.total) {
        setProgress(Math.min(100, Math.round((100 * (data.loaded ?? 0)) / data.total)));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Translate the shell's forwarded buttons into SuperTux keys and dispatch them
  // into the iframe. Real taps on the canvas pass through untouched.
  useEffect(() => {
    const route = (code: string, down: boolean): void => {
      const control = CONTROL_FOR_CODE[code];
      const input = inputRef.current;
      if (!control || !input) return;
      const key = supertuxKeyForControl(control);
      if (key) input.key(key, down);
    };
    const onKeyDown = (event: KeyboardEvent) => route(event.code, true);
    const onKeyUp = (event: KeyboardEvent) => route(event.code, false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const onFrameLoad = () => {
    if (frameRef.current) {
      inputRef.current = new IframeKeyboard(frameRef.current);
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
          // The platformer wants the pointer for touch play; the sandbox still
          // blocks top navigation and popups from the embedded engine.
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
      <div className="os-game-hint">{cart.title} · SELECT = EJECT</div>
    </div>
  );
}
