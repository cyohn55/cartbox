"use client";

/**
 * Cartridge grid shared by the Browse and Library screens. Tapping a playable
 * cart launches it full-screen in the console; paid, un-owned carts link out
 * to their store page.
 */

import { withBasePath } from "@/lib/staticSite";
import type { PlayingCart } from "./consoleOs";

/** Pre-rendered shot of the cartridge shell; the cover art sits on its label. */
const CARTRIDGE_SHELL_URL = withBasePath("/console/cartridge.png");

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

export function CartGrid({ carts, onPlayCart }: CartGridProps) {
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
        const thumb = (
          <span className="os-cart-shell">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="os-cart-shell-img" src={CARTRIDGE_SHELL_URL} alt="" loading="lazy" />
            {label}
          </span>
        );
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
            onClick={() =>
              onPlayCart({
                cartId: cart.id,
                title: cart.title,
                cartUrl: cart.cartUrl!,
                engineUrl: cart.engineUrl!,
                modelId: cart.modelId,
              })
            }
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
