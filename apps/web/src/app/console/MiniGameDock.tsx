"use client";

/**
 * The mini-game living behind the handheld's controls (arcade theme).
 *
 * Idle, it runs in attract mode — the game plays itself dimly under the
 * buttons. Entering the Konami code (handled by the shell) makes it live:
 * the D-pad and face buttons drive the background game instead of the top
 * screen, until SELECT hands them back.
 *
 * Canvas games step/draw at ~60Hz from bus-fed input; the cart entry mounts
 * a real cartridge through @cartbox/player (driven via key forwarding).
 */

import { useEffect, useRef, useState } from "react";
import { mount, type ModelId, type PlayerHandle } from "@cartbox/player";

import { isStaticExport } from "@/lib/staticSite";
import { demoCartUrl, findDemoCart } from "@/lib/demoCatalog";
import { ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
import type { ConsoleInputBus } from "./consoleInput";
import { useConsoleInput } from "./ConsoleInputContext";
import { IDLE_INPUT, type MiniGame, type MiniGameInput } from "./minigames/types";

interface MiniGameDockProps {
  bus: ConsoleInputBus;
  game: MiniGame;
  /** True while the Konami code has given the controls to this game. */
  active: boolean;
  onExit: () => void;
}

/** Finds a playable URL for the cart-based mini-game in either build. */
async function resolveCartSource(cartId: string): Promise<{ cartUrl: string; modelId: string } | null> {
  if (isStaticExport) {
    const cart = findDemoCart(cartId);
    return cart ? { cartUrl: demoCartUrl(cartId), modelId: cart.consoleModel } : null;
  }
  try {
    const response = await fetch("/api/carts?limit=100");
    const body = (await response.json()) as {
      carts?: Array<{ id: string; cartUrl: string | null; console_model: string }>;
    };
    const cart = body.carts?.find((row) => row.id === cartId);
    return cart?.cartUrl ? { cartUrl: cart.cartUrl, modelId: cart.console_model } : null;
  } catch {
    return null;
  }
}

function CanvasMiniGameView({ bus, game, active }: { bus: ConsoleInputBus; game: Extract<MiniGame, { kind: "canvas" }>; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<MiniGameInput>({ ...IDLE_INPUT });
  const activeRef = useRef(active);
  activeRef.current = active;

  // Live input state, fed from the bus while this game holds the controls.
  useConsoleInput((event) => {
    const control = event.control;
    if (control === "up" || control === "down" || control === "left" || control === "right" || control === "a" || control === "b") {
      inputRef.current[control] = event.phase === "press";
    }
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) {
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    canvas.width = Math.max(160, host.clientWidth);
    canvas.height = Math.max(120, host.clientHeight);
    const session = game.create(canvas.width, canvas.height);

    let raf = 0;
    const loop = () => {
      const live = activeRef.current;
      session.step(live ? inputRef.current : IDLE_INPUT, !live);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.globalAlpha = live ? 1 : 0.45; // attract mode stays subtle
      session.draw(context, canvas.width, canvas.height);
      context.globalAlpha = 1;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(raf);
  }, [game]);

  return <canvas ref={canvasRef} className="hh-minigame-canvas" />;
}

function CartMiniGameView({ game, active }: { game: Extract<MiniGame, { kind: "cart" }>; active: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<{ cartUrl: string; modelId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    resolveCartSource(game.cartId).then((resolved) => {
      if (!cancelled) {
        setSource(resolved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [game.cartId]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !source) {
      return;
    }
    let handle: PlayerHandle | null = null;
    handle = mount(stage, {
      cartUrl: source.cartUrl,
      engineUrl:
        ENGINE_URL_BY_MODEL[source.modelId as keyof typeof ENGINE_URL_BY_MODEL] ?? ENGINE_URL_BY_MODEL.classic,
      modelId: source.modelId as ModelId,
      controls: "keyboard",
      scale: "fit",
      onReady: () => void handle?.resume(),
    });
    return () => handle?.destroy();
  }, [source]);

  return (
    <div ref={stageRef} className="hh-minigame-cart" data-live={active || undefined}>
      {!source && <span className="hh-minigame-note">CART MISSING</span>}
    </div>
  );
}

export function MiniGameDock({ bus, game, active, onExit }: MiniGameDockProps) {
  // The dock owns the controls while active; SELECT hands them back.
  useConsoleInput((event) => {
    if (active && event.phase === "press" && event.control === "select") {
      onExit();
    }
  });

  useEffect(() => {
    bus.setMinigameMode(active ? (game.kind === "cart" ? "cart" : "canvas") : "off");
    return () => bus.setMinigameMode("off");
  }, [bus, active, game.kind]);

  return (
    <div className="hh-minigame" data-live={active || undefined} aria-hidden={!active}>
      {game.kind === "canvas" ? (
        <CanvasMiniGameView bus={bus} game={game} active={active} />
      ) : (
        <CartMiniGameView game={game} active={active} />
      )}
      {active && <div className="hh-minigame-banner">▲ {game.title} · SELECT RETURNS THE CONTROLS</div>}
    </div>
  );
}
