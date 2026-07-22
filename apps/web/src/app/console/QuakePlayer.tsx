"use client";

/**
 * Full-screen session for the Quake catalog title inside the handheld.
 *
 * Quake runs on WebQuake — a pure-JavaScript WebGL reimplementation of the id
 * engine — so, like ScummVM / SuperTux / DOS, it runs in a same-origin iframe
 * (public/quake/cartbox-boot.html) that owns its canvas, main loop, audio and
 * (via localStorage) its saves. It presents identically to the other players —
 * same stage, loading copy and SELECT = EJECT hint — so the handheld feels like
 * one console.
 *
 * The shell forwards each console button as a synthetic KeyboardEvent on
 * `window`; this component re-dispatches the mapped Quake key (see the pure
 * quakeRuntime map) into the iframe. Two subtleties:
 *   - WebQuake reads the legacy numeric `keyCode`, which the KeyboardEvent
 *     constructor refuses to set from its init dict, so it is defined explicitly
 *     (the same fix DosPlayer needs). Without it every key arrives as keyCode 0.
 *   - WebQuake registers its keyboard handlers on `window`, not the canvas, so
 *     events are dispatched onto the iframe's window.
 */

import { useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/staticSite";
import { CONTROL_KEY_CODES } from "./consoleInput";
import type { ConsoleControl } from "./consoleInput";
import { quakeKeyForControl, type QuakeKey } from "@/lib/quakeRuntime";
import type { PlayingCart } from "./consoleOs";

/** Reverse of CONTROL_KEY_CODES: the shell forwards buttons as these key codes. */
const CONTROL_FOR_CODE: Readonly<Record<string, ConsoleControl>> = Object.fromEntries(
  Object.entries(CONTROL_KEY_CODES)
    .filter(([, code]) => code !== null)
    .map(([control, code]) => [code as string, control as ConsoleControl]),
);

/** Dispatches synthetic keyboard events into the WebQuake iframe. */
class IframeKeyboard {
  constructor(private readonly frame: HTMLIFrameElement) {}

  #window(): (Window & typeof globalThis) | null {
    return (this.frame.contentWindow as (Window & typeof globalThis) | null) ?? null;
  }

  key(quakeKey: QuakeKey, down: boolean): void {
    const win = this.#window();
    if (!win) return;

    const event = new win.KeyboardEvent(down ? "keydown" : "keyup", {
      code: quakeKey.code,
      bubbles: true,
      cancelable: true,
    });
    // keyCode/which are legacy and read-only, so the constructor's init dict
    // cannot set them; WebQuake's Sys.scantokey keys off exactly these, so force
    // them onto the event.
    Object.defineProperty(event, "keyCode", { get: () => quakeKey.keyCode });
    Object.defineProperty(event, "which", { get: () => quakeKey.keyCode });

    // WebQuake assigns its handlers to window.onkeydown / window.onkeyup.
    win.dispatchEvent(event);
  }
}

export function QuakePlayer({ cart, onExit }: { cart: PlayingCart; onExit: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const inputRef = useRef<IframeKeyboard | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const src = withBasePath("/quake/cartbox-boot.html");

  // The engine reports readiness and hard failures by postMessage — the same
  // contract the ScummVM / SuperTux / DOS boot pages use. WebQuake loads the pak
  // with blocking range requests and reports no numeric progress, so the loader
  // stays indeterminate until runtime-initialized.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string } | null;
      if (data?.source !== "cartbox-quake") return;
      if (data.type === "runtime-initialized") setStatus("ready");
      else if (data.type === "error") setStatus("error");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Translate the shell's forwarded buttons into Quake keys and dispatch them
  // into the iframe. Real taps/keys inside the canvas pass through untouched.
  useEffect(() => {
    const route = (code: string, down: boolean): void => {
      const control = CONTROL_FOR_CODE[code];
      const input = inputRef.current;
      if (!control || !input) return;
      const quakeKey = quakeKeyForControl(control);
      if (quakeKey) input.key(quakeKey, down);
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
          className="os-quake-frame"
          src={src}
          title={cart.title}
          onLoad={onFrameLoad}
          style={{ width: "100%", height: "100%", border: 0, display: "block", background: "#000" }}
          // The shooter wants the pointer for touch aiming; the sandbox still
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
