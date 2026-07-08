"use client";

/**
 * Cartridge grid shared by the Browse and Library screens. Tapping a playable
 * cart launches it full-screen in the console; paid, un-owned carts link out
 * to their store page.
 */

import type { PlayingCart } from "./consoleOs";

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
        const thumb = cart.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="os-grid-thumb" src={cart.thumbUrl} alt="" />
        ) : (
          <span className="os-grid-thumb-empty" aria-hidden>
            ▦
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
            className="os-grid-card"
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
          <a key={cart.id} className="os-grid-card" href={`/play/${cart.id}`}>
            {thumb}
            {meta}
          </a>
        );
      })}
    </div>
  );
}
