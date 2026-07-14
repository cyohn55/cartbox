"use client";

/**
 * Library tab: the player's own shelf — carts they published plus carts they
 * bought. Guests get a sign-in prompt; the static demo build treats the baked
 * catalog as everyone's library.
 */

import { useEffect, useState } from "react";

import { authHeaders } from "@/lib/supabase-browser";
import { isStaticExport } from "@/lib/staticSite";
import { DEMO_CARTS, demoCartUrl, demoThumbUrl } from "@/lib/demoCatalog";
import { ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
import type { PlayingCart } from "./consoleOs";
import { CartGrid, type GridCart } from "./CartGrid";

interface LibraryScreenProps {
  guest: boolean;
  onPlayCart: (cart: PlayingCart) => void;
}

function demoLibrary(): GridCart[] {
  return DEMO_CARTS.map((cart) => ({
    id: cart.id,
    title: cart.title,
    priceCents: cart.priceCents,
    modelId: cart.consoleModel,
    thumbUrl: demoThumbUrl(cart.id),
    cartUrl: demoCartUrl(cart.id),
    engineUrl: ENGINE_URL_BY_MODEL[cart.consoleModel],
  }));
}

export function LibraryScreen({ guest, onPlayCart }: LibraryScreenProps) {
  const [carts, setCarts] = useState<GridCart[] | null>(isStaticExport ? demoLibrary() : null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isStaticExport || guest) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/console/me", { headers: await authHeaders() });
        if (!response.ok) {
          throw new Error(`library request failed: ${response.status}`);
        }
        const body = (await response.json()) as { library: GridCart[] };
        if (!cancelled) {
          setCarts(body.library);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [guest]);

  if (guest && !isStaticExport) {
    return (
      <div className="os-page" data-console-nav data-testid="library-screen">
        <h2>LIBRARY</h2>
        <div className="os-empty">
          Your library lives on your account.
          <br />
          Sign in to shelve cartridges you make and buy.
        </div>
      </div>
    );
  }

  return (
    <div className="os-page" data-console-nav data-testid="library-screen">
      <h2>LIBRARY</h2>
      {failed && <div className="os-empty">Your library could not be reached.</div>}
      {!failed && carts === null && <div className="os-loading">DUSTING THE SHELVES…</div>}
      {carts !== null && carts.length === 0 && (
        <div className="os-empty">
          No cartridges yet — play something free
          <br />
          from the feed, or make your own.
        </div>
      )}
      {carts !== null && carts.length > 0 && <CartGrid carts={carts} onPlayCart={onPlayCart} />}
    </div>
  );
}
