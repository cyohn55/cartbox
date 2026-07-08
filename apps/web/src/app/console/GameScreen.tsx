"use client";

/**
 * Full-screen game session inside the handheld's display. Mounts the player
 * with keyboard controls so the shell's D-pad / face buttons (forwarded as
 * synthetic key events by the input bus) drive the cartridge. SELECT exits —
 * the OS handles that; this screen just shows the hint.
 */

import { useEffect, useRef, useState } from "react";
import { mount, type ModelId, type PlayerHandle } from "@cartbox/player";

import type { PlayingCart } from "./consoleOs";
import { useConsoleInput } from "./ConsoleInputContext";

export function GameScreen({ cart, onExit }: { cart: PlayingCart; onExit: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<PlayerHandle | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }

    const handle: PlayerHandle = mount(stage, {
      cartUrl: cart.cartUrl,
      engineUrl: cart.engineUrl,
      modelId: cart.modelId as ModelId,
      // Keyboard (not touch): the shell's physical buttons are the gamepad.
      controls: "keyboard",
      scale: "fit",
      lighting: { autoDetect: true },
      onReady: () => {
        setStatus("ready");
        // Loading is async, so resume() must wait for it — calling it right
        // after mount() no-ops and leaves the game frozen on frame 0.
        void handleRef.current?.resume();
      },
      onError: () => setStatus("error"),
    });
    handleRef.current = handle;

    return () => {
      handleRef.current = null;
      handle.destroy();
    };
  }, [cart]);

  // Every shell-button press is a real user gesture; nudging resume() lets a
  // browser-suspended AudioContext start the moment the player touches a
  // control (playback itself is already running).
  useConsoleInput((event) => {
    if (event.phase === "press") {
      void handleRef.current?.resume();
    }
  });

  return (
    <div className="os-stage os-game" data-testid="game-screen">
      <div ref={stageRef} className="os-game-stage" />
      {status === "loading" && <div className="os-loading">INSERTING CARTRIDGE…</div>}
      {status === "error" && (
        <div className="os-loading" role="alert">
          CARTRIDGE ERROR —{" "}
          <button type="button" className="os-auth-switch" onClick={onExit}>
            EJECT
          </button>
        </div>
      )}
      <div className="os-game-hint">{cart.title} · SELECT = EJECT</div>
    </div>
  );
}
