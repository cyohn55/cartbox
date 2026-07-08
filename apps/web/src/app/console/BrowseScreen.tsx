"use client";

/**
 * Browse tab: the full archive of published cartridges. Free carts launch
 * straight into the console; paid ones link to their store page.
 */

import { useEffect, useState } from "react";

import { isStaticExport } from "@/lib/staticSite";
import { DEMO_CARTS, demoCartUrl } from "@/lib/demoCatalog";
import { ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
import type { PlayingCart } from "./consoleOs";
import { CartGrid, type GridCart } from "./CartGrid";

interface ApiCart {
  id: string;
  title: string;
  price_cents: number;
  console_model: string;
  plays: number;
  thumbUrl: string | null;
  cartUrl: string | null;
}

function demoGridCarts(): GridCart[] {
  return DEMO_CARTS.map((cart) => ({
    id: cart.id,
    title: cart.title,
    priceCents: cart.priceCents,
    modelId: cart.consoleModel,
    thumbUrl: null,
    cartUrl: demoCartUrl(cart.id),
    engineUrl: ENGINE_URL_BY_MODEL[cart.consoleModel],
    plays: cart.plays,
  }));
}

export function BrowseScreen({ onPlayCart }: { onPlayCart: (cart: PlayingCart) => void }) {
  const [carts, setCarts] = useState<GridCart[] | null>(isStaticExport ? demoGridCarts() : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isStaticExport) {
      return;
    }
    let cancelled = false;
    fetch("/api/carts?limit=100")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`carts request failed: ${response.status}`);
        }
        const body = (await response.json()) as { carts: ApiCart[] };
        if (!cancelled) {
          setCarts(
            body.carts.map((cart) => ({
              id: cart.id,
              title: cart.title,
              priceCents: cart.price_cents,
              modelId: cart.console_model,
              thumbUrl: cart.thumbUrl,
              cartUrl: cart.cartUrl,
              engineUrl: cart.cartUrl ? ENGINE_URL_BY_MODEL[cart.console_model as "classic" | "pro"] : null,
              plays: cart.plays,
            })),
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="os-page" data-testid="browse-screen">
      <h2>BROWSE CARTRIDGES</h2>
      {failed && <div className="os-empty">The archive could not be reached.</div>}
      {!failed && carts === null && <div className="os-loading">OPENING THE ARCHIVE…</div>}
      {carts !== null && carts.length === 0 && <div className="os-empty">No cartridges published yet.</div>}
      {carts !== null && carts.length > 0 && <CartGrid carts={carts} onPlayCart={onPlayCart} />}
    </div>
  );
}
