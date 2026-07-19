"use client";

/**
 * Full-screen session for a ported catalog title inside the handheld.
 *
 * The cartridge counterpart is GameScreen, which mounts the player package for a
 * .tic. This runs the Cartbox Game ABI instead (games/README.md), but presents
 * identically: same stage, same loading and error copy, same SELECT = EJECT hint,
 * so the two kinds of game feel like one console.
 *
 * Input arrives as synthetic key events from the shell's input bus, so the
 * console binding table is used rather than the desktop one — the shell sends
 * KeyA/KeyS for its X/Y buttons, which the desktop table reads as WASD.
 */

import { useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/staticSite";
import { ButtonState, CONSOLE_KEY_BINDINGS, buttonForKey } from "@/lib/gameInput";
import {
  GameSession,
  clampDelta,
  paintFrame,
  type GameModuleFactory,
} from "@/lib/wasmGameRuntime";
import type { PlayingCart } from "./consoleOs";

async function loadGameFactory(bundleName: string): Promise<GameModuleFactory> {
  const scriptUrl = withBasePath(`/games/${bundleName}/game.js`);
  const imported = (await import(/* webpackIgnore: true */ scriptUrl)) as {
    default: GameModuleFactory;
  };
  return imported.default;
}

export function PortedGameScreen({ cart, onExit }: { cart: PlayingCart; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const buttonsRef = useRef(new ButtonState());
  const frameRef = useRef<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const game = cart.game;

  useEffect(() => {
    if (!game) {
      return;
    }
    let cancelled = false;
    const { bundleName, width, height } = game;

    (async () => {
      try {
        const factory = await loadGameFactory(bundleName);
        const session = await GameSession.start(
          factory,
          { width, height },
          { locateFile: (file: string) => withBasePath(`/games/${bundleName}/${file}`) },
        );
        if (cancelled) {
          return;
        }
        sessionRef.current = session;
        setStatus("ready");

        // Unlike the cart player, this starts playing immediately: the shell
        // already ran its insert animation, so a further "press play" would be
        // a dead end with no on-screen control to press.
        let last = performance.now();
        const step = (now: number) => {
          const active = sessionRef.current;
          const context = canvasRef.current?.getContext("2d");
          if (!active || !context) {
            return;
          }
          active.setInput(buttonsRef.current.mask());
          active.tick(clampDelta((now - last) / 1000));
          last = now;
          paintFrame(context, active.frame(), { width, height });
          frameRef.current = requestAnimationFrame(step);
        };
        frameRef.current = requestAnimationFrame(step);
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      sessionRef.current = null;
    };
  }, [game]);

  // The shell forwards its buttons as synthetic key events on window, so the
  // same listener serves physical keyboards and on-screen controls alike.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const button = buttonForKey(event.code, CONSOLE_KEY_BINDINGS);
      if (button) {
        buttonsRef.current.press(button);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const button = buttonForKey(event.code, CONSOLE_KEY_BINDINGS);
      if (button) {
        buttonsRef.current.release(button);
      }
    };
    const onBlur = () => buttonsRef.current.releaseAll();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return (
    <div className="os-stage os-game" data-testid="game-screen">
      <div className="os-game-stage">
        <canvas
          ref={canvasRef}
          width={game?.width ?? 320}
          height={game?.height ?? 180}
          style={{ width: "100%", height: "100%", objectFit: "contain", imageRendering: "pixelated" }}
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
