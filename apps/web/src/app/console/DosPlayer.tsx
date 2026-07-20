"use client";

/**
 * Full-screen session for a DOS catalog title inside the handheld.
 *
 * A DOS title is a real-mode program running in DOSBox compiled to WebAssembly
 * (js-dos 6.22). Like ScummVM and SuperTux it owns its canvas, main loop, audio
 * and (via the browser) its saves, so it runs in a same-origin iframe
 * (public/dosbox/cartbox-boot.html) and presents identically to the other
 * players — same stage, loading copy and SELECT = EJECT hint — so the handheld
 * feels like one console.
 *
 * The shell forwards each console button as a synthetic KeyboardEvent on
 * `window`; this component re-dispatches the mapped DOS key (see the pure
 * dosRuntime map) into the iframe. The subtlety is DOSBox's SDL 1.2 backend
 * reads the legacy numeric `keyCode`, which the KeyboardEvent constructor
 * refuses to set from its init dict — so the event is built and then `keyCode`
 * and `which` are defined on it explicitly. Without that override every
 * forwarded key arrives as keyCode 0 and DOSBox ignores it.
 */

import { useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/staticSite";
import { CONTROL_KEY_CODES } from "./consoleInput";
import type { ConsoleControl } from "./consoleInput";
import { dosKeyForControl, type DosKey } from "@/lib/dosRuntime";
import type { PlayingCart } from "./consoleOs";

/** Reverse of CONTROL_KEY_CODES: the shell forwards buttons as these key codes. */
const CONTROL_FOR_CODE: Readonly<Record<string, ConsoleControl>> = Object.fromEntries(
  Object.entries(CONTROL_KEY_CODES)
    .filter(([, code]) => code !== null)
    .map(([control, code]) => [code as string, control as ConsoleControl]),
);

/** Dispatches synthetic keyboard events into the DOSBox iframe. */
class IframeKeyboard {
  constructor(private readonly frame: HTMLIFrameElement) {}

  #window(): (Window & typeof globalThis) | null {
    return (this.frame.contentWindow as (Window & typeof globalThis) | null) ?? null;
  }

  key(dosKey: DosKey, down: boolean): void {
    const win = this.#window();
    const doc = win?.document;
    if (!win || !doc) return;

    const event = new win.KeyboardEvent(down ? "keydown" : "keyup", {
      code: dosKey.code,
      bubbles: true,
      cancelable: true,
    });
    // keyCode/which are legacy and read-only, so the constructor's init dict
    // cannot set them; DOSBox's SDL 1.2 backend keys off exactly these, so force
    // them onto the event.
    Object.defineProperty(event, "keyCode", { get: () => dosKey.keyCode });
    Object.defineProperty(event, "which", { get: () => dosKey.keyCode });

    // Emscripten's SDL registers its keyboard handler on the document.
    doc.dispatchEvent(event);
  }
}

export function DosPlayer({ cart, onExit }: { cart: PlayingCart; onExit: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const inputRef = useRef<IframeKeyboard | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  // The launch target ("<bundle>:<exe>") selects the game zip and its exe.
  const target = cart.game?.target ?? "";
  const src = withBasePath(`/dosbox/cartbox-boot.html${target ? `#${encodeURIComponent(target)}` : ""}`);

  // The engine reports readiness and hard failures by postMessage — the same
  // contract the ScummVM and SuperTux boot pages use. (js-dos 6.22 has no numeric
  // load progress, so the loader stays indeterminate until runtime-initialized.)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string } | null;
      if (data?.source !== "cartbox-dos") return;
      if (data.type === "runtime-initialized") setStatus("ready");
      else if (data.type === "error") setStatus("error");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Translate the shell's forwarded buttons into DOS keys and dispatch them into
  // the iframe. Real taps/keys inside the canvas pass through untouched.
  useEffect(() => {
    const route = (code: string, down: boolean): void => {
      const control = CONTROL_FOR_CODE[code];
      const input = inputRef.current;
      if (!control || !input) return;
      const dosKey = dosKeyForControl(control);
      if (dosKey) input.key(dosKey, down);
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
          className="os-dos-frame"
          src={src}
          title={cart.title}
          onLoad={onFrameLoad}
          style={{ width: "100%", height: "100%", border: 0, display: "block", background: "#000" }}
          // The game wants the pointer for mouse-driven menus; the sandbox still
          // blocks top navigation and popups from the embedded engine.
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
