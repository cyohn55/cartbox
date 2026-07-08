"use client";

/**
 * Cartridge grid shared by the Browse and Library screens. Each cart is a
 * true 3D box (front/back/side faces rendered from Cartridge.glb) with the
 * cover art on its label. Tapping a playable cart plays the launch
 * animation — three spins, then a flight to the screen center — and the
 * cart boots when the animation reports it finished; paid, un-owned carts
 * link out to their store page.
 */

import { useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/staticSite";
import type { PlayingCart } from "./consoleOs";

/** Pre-rendered faces of the cartridge shell; the cover art sits on the front. */
const CARTRIDGE_FACE_URLS = {
  front: withBasePath("/console/cartridge.png"),
  back: withBasePath("/console/cartridge-back.png"),
  side: withBasePath("/console/cartridge-side.png"),
};

/**
 * The boot normally fires on the os-cart-launch animationend event. This is
 * the safety net for the cases where that event never comes (an interrupted
 * animation, an odd browser): roughly double the 1.44s the keyframes run.
 */
const LAUNCH_FALLBACK_MS = 2900;

export interface GridCart {
  id: string;
  title: string;
  priceCents: number;
  modelId: string;
  thumbUrl: string | null;
  /** Playable when present; null means the store still holds the keys. */
  cartUrl: string | null;
  engineUrl: string | null;
  plays?: number;
}

interface CartGridProps {
  carts: GridCart[];
  onPlayCart: (cart: PlayingCart) => void;
}

function formatPrice(cents: number): string {
  return cents === 0 ? "FREE" : `$${(cents / 100).toFixed(2)}`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function CartGrid({ carts, onPlayCart }: CartGridProps) {
  const [launchingCartId, setLaunchingCartId] = useState<string | null>(null);
  const pendingLaunchRef = useRef<PlayingCart | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (fallbackTimerRef.current !== null) {
        clearTimeout(fallbackTimerRef.current);
      }
    };
  }, []);

  function bootPendingLaunch() {
    const playing = pendingLaunchRef.current;
    if (playing === null) {
      return; // Already booted (animationend and the fallback can both land).
    }
    pendingLaunchRef.current = null;
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    setLaunchingCartId(null);
    onPlayCart(playing);
  }

  function launchCart(cart: GridCart, cardElement: HTMLElement) {
    if (launchingCartId !== null) {
      return; // A launch is already in flight; ignore further taps.
    }
    const playing: PlayingCart = {
      cartId: cart.id,
      title: cart.title,
      cartUrl: cart.cartUrl!,
      engineUrl: cart.engineUrl!,
      modelId: cart.modelId,
    };
    if (prefersReducedMotion()) {
      onPlayCart(playing);
      return;
    }
    // Aim the flight at the middle of the console screen: the os-cart-launch
    // keyframes translate the cartridge by this vector while it grows.
    const shell = cardElement.querySelector<HTMLElement>(".os-cart-shell");
    const stage = cardElement.closest<HTMLElement>(".os-stage");
    if (shell && stage) {
      const shellRect = shell.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const deltaX = stageRect.left + stageRect.width / 2 - (shellRect.left + shellRect.width / 2);
      const deltaY = stageRect.top + stageRect.height / 2 - (shellRect.top + shellRect.height / 2);
      cardElement.style.setProperty("--launch-dx", `${deltaX.toFixed(1)}px`);
      cardElement.style.setProperty("--launch-dy", `${deltaY.toFixed(1)}px`);
    }
    pendingLaunchRef.current = playing;
    setLaunchingCartId(cart.id);
    fallbackTimerRef.current = setTimeout(bootPendingLaunch, LAUNCH_FALLBACK_MS);
  }

  return (
    <div className="os-grid">
      {carts.map((cart) => {
        const playable = cart.cartUrl !== null && cart.engineUrl !== null;
        const label = cart.thumbUrl ? (
          // Lazy: the arcade lists a thousand-plus covers in one grid.
          // eslint-disable-next-line @next/next/no-img-element
          <img className="os-cart-label" src={cart.thumbUrl} alt="" loading="lazy" />
        ) : (
          <span className="os-cart-label os-cart-label-empty" aria-hidden>
            ▦
          </span>
        );
        /* eslint-disable @next/next/no-img-element */
        const thumb = (
          <span className="os-cart-shell">
            <span className="os-cart-3d">
              <span className="os-cart-face os-cart-face-front">
                <img className="os-cart-shell-img" src={CARTRIDGE_FACE_URLS.front} alt="" />
                {label}
              </span>
              <span className="os-cart-face os-cart-face-back">
                <img className="os-cart-face-img" src={CARTRIDGE_FACE_URLS.back} alt="" />
              </span>
              <span className="os-cart-face os-cart-face-side os-cart-face-left">
                <img className="os-cart-face-img" src={CARTRIDGE_FACE_URLS.side} alt="" />
              </span>
              <span className="os-cart-face os-cart-face-side os-cart-face-right">
                <img className="os-cart-face-img" src={CARTRIDGE_FACE_URLS.side} alt="" />
              </span>
            </span>
          </span>
        );
        /* eslint-enable @next/next/no-img-element */
        const meta = (
          <span className="os-grid-meta">
            <span className="os-grid-title">{cart.title}</span>
            <span className="os-grid-sub">
              {formatPrice(cart.priceCents)} · {cart.modelId === "pro" ? "PRO" : "CLASSIC"}
              {cart.plays !== undefined ? ` · ${cart.plays} plays` : ""}
            </span>
          </span>
        );

        return playable ? (
          <button
            key={cart.id}
            type="button"
            className="os-grid-card os-cart-card"
            data-launching={cart.id === launchingCartId ? "true" : undefined}
            onClick={(event) => launchCart(cart, event.currentTarget)}
            onAnimationEnd={(event) => {
              if (event.animationName === "os-cart-launch" && cart.id === launchingCartId) {
                bootPendingLaunch();
              }
            }}
          >
            {thumb}
            {meta}
          </button>
        ) : (
          <a key={cart.id} className="os-grid-card os-cart-card" href={`/play/${cart.id}`}>
            {thumb}
            {meta}
          </a>
        );
      })}
    </div>
  );
}
