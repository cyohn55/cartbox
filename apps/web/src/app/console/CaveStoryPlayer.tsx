"use client";

/**
 * Full-screen session for the Cave Story catalog title inside the handheld.
 *
 * Cave Story runs on NXEngine (a GPL clean-room reimplementation of Pixel's
 * engine) compiled to WebAssembly. Like the other engine runtimes it is a whole
 * SDL2 application that owns its canvas, main loop and audio inside a same-origin
 * iframe (public/cavestory/cartbox-boot.html), presenting identically to the
 * other iframe players (same stage, loading copy, SELECT = EJECT hint).
 *
 * NXEngine is keyboard-driven, so the integration mirrors OpenTyrianPlayer: the
 * shell forwards each button as a synthetic KeyboardEvent on `window`, and this
 * component re-dispatches the NXEngine key (see the pure cavestoryRuntime map)
 * into the iframe. SDL2's Emscripten backend registers its keyboard callbacks on
 * the window/document (not the canvas), so events are dispatched on the iframe
 * document; they bubble to window. Real taps still pass through.
 */

import { useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/staticSite";
import { CONTROL_KEY_CODES } from "./consoleInput";
import type { ConsoleControl } from "./consoleInput";
import { cavestoryKeyForControl } from "@/lib/cavestoryRuntime";
import type { PlayingCart } from "./consoleOs";

/** Reverse of CONTROL_KEY_CODES: the shell forwards buttons as these key codes. */
const CONTROL_FOR_CODE: Readonly<Record<string, ConsoleControl>> = Object.fromEntries(
  Object.entries(CONTROL_KEY_CODES)
    .filter(([, code]) => code !== null)
    .map(([control, code]) => [code as string, control as ConsoleControl]),
);

/** Dispatches synthetic keyboard events into the NXEngine iframe. */
class IframeKeyboard {
  constructor(private readonly frame: HTMLIFrameElement) {}

  #window(): (Window & typeof globalThis) | null {
    return (this.frame.contentWindow as (Window & typeof globalThis) | null) ?? null;
  }

  key(code: string, down: boolean): void {
    const win = this.#window();
    if (!win) return;
    const target = win.document.getElementById("canvas") ?? win.document;
    // SDL2's Emscripten backend keys off `code`; dispatched with bubbling so it
    // reaches the window listener SDL2 installs by default.
    target.dispatchEvent(new win.KeyboardEvent(down ? "keydown" : "keyup", { code, bubbles: true }));
  }
}

export function CaveStoryPlayer({ cart, onExit }: { cart: PlayingCart; onExit: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const inputRef = useRef<IframeKeyboard | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [progress, setProgress] = useState<number | null>(null);

  const src = withBasePath("/cavestory/cartbox-boot.html");

  // The engine reports load progress, readiness and hard failures by postMessage.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string; loaded?: number; total?: number } | null;
      if (data?.source !== "cartbox-cavestory") return;
      if (data.type === "runtime-initialized") setStatus("ready");
      else if (data.type === "error") setStatus("error");
      else if (data.type === "progress" && data.total) {
        setProgress(Math.min(100, Math.round((100 * (data.loaded ?? 0)) / data.total)));
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Translate the shell's forwarded buttons into NXEngine keys and dispatch them
  // into the iframe. Real taps on the canvas pass through untouched.
  useEffect(() => {
    const route = (code: string, down: boolean): void => {
      const control = CONTROL_FOR_CODE[code];
      const input = inputRef.current;
      if (!control || !input) return;
      const key = cavestoryKeyForControl(control);
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
      <div className="os-game-hint">{cart.title} · A jump · B fire · X items · Y weapon · SELECT = EJECT</div>
    </div>
  );
}
