"use client";

/**
 * Browse tab — the comprehensive cartridge archive, from two sources:
 *
 *  - CARTBOX: carts published on this platform (free ones launch in-console,
 *    paid ones link to their store page), plus catalog titles — ported
 *    open-source and freeware games that run on the Cartbox Game ABI runtime.
 *    Both appear in one grid; a title carries `game` instead of a cart binary.
 *  - TIC-80 ARCADE: the entire tic80.com community archive, listed live from
 *    the site's own SURF API and played directly from its CORS-open cart
 *    binaries — every category, nothing rehosted or hand-picked. This works
 *    in the static demo build too, since the archive is fetched client-side.
 */

import { useEffect, useMemo, useState } from "react";

import { isStaticExport } from "@/lib/staticSite";
import { gamePlayerRuntime } from "@/lib/titleRuntime";
import { DEMO_CARTS, demoCartUrl, demoThumbUrl } from "@/lib/demoCatalog";
import { DEMO_TITLES } from "@/lib/demoTitles";
import { ENGINE_URL_BY_MODEL, resolveModelId } from "@/lib/consoleModel";
import {
  TIC_ARCADE_CATEGORIES,
  fetchTicArcadeCategory,
  ticArcadeCartUrl,
  ticArcadeCoverUrl,
  type TicArcadeCategory,
  type TicArcadeEntry,
} from "@/lib/ticArcade";
import type { PlayingCart } from "./consoleOs";
import { CartGrid, type GridCart } from "./CartGrid";

type CatalogSource = "cartbox" | "arcade";

interface ApiCart {
  id: string;
  title: string;
  price_cents: number;
  console_model: string;
  plays: number;
  thumbUrl: string | null;
  cartUrl: string | null;
}

/**
 * Catalog titles as grid entries.
 *
 * Only titles with a published bundle are listed: the catalog deliberately
 * carries games ahead of their ports, and a cartridge that cannot boot is worse
 * on a console than one that is simply absent.
 */
function titleGridCarts(
  titles: readonly {
    id: string;
    name: string;
    bundleName?: string | null;
    width?: number;
    height?: number;
    /** The catalog runtime id; disambiguates the iframe players from wasm-app. */
    runtime?: string | null;
    /** Present for ScummVM titles: the engine directory and launch target. */
    scummvmTarget?: string | null;
    /** Present for DOS titles: "<bundle>:<exe>", the game zip and its executable. */
    dosTarget?: string | null;
    /** The server catalog's single launch-target column, whatever the runtime. */
    target?: string | null;
  }[],
): GridCart[] {
  return titles
    .filter((title) => Boolean(title.bundleName))
    .map((title) => ({
      id: title.id,
      title: title.name,
      priceCents: 0,
      modelId: "classic",
      thumbUrl: null,
      cartUrl: null,
      engineUrl: null,
      game: {
        // Shared with /play so the two surfaces cannot disagree about which
        // engine a title runs on.
        runtime: gamePlayerRuntime(title),
        bundleName: title.bundleName as string,
        width: title.width ?? 320,
        height: title.height ?? 180,
        target: title.dosTarget ?? title.scummvmTarget ?? title.target ?? undefined,
      },
    }));
}

function demoGridCarts(): GridCart[] {
  return DEMO_CARTS.map<GridCart>((cart) => ({
    id: cart.id,
    title: cart.title,
    priceCents: cart.priceCents,
    modelId: cart.consoleModel,
    thumbUrl: demoThumbUrl(cart.id),
    cartUrl: demoCartUrl(cart.id),
    engineUrl: ENGINE_URL_BY_MODEL[cart.consoleModel],
    plays: cart.plays,
  }));
}

/** The whole archive runs on the Classic core — it IS TIC-80. */
function arcadeGridCarts(entries: TicArcadeEntry[]): GridCart[] {
  return entries.map((entry) => ({
    id: `tic80-${entry.id}`,
    title: entry.title,
    priceCents: 0,
    modelId: "classic",
    thumbUrl: ticArcadeCoverUrl(entry),
    cartUrl: ticArcadeCartUrl(entry),
    engineUrl: ENGINE_URL_BY_MODEL.classic,
  }));
}

export function BrowseScreen({ onPlayCart }: { onPlayCart: (cart: PlayingCart) => void }) {
  const [source, setSource] = useState<CatalogSource>("cartbox");
  // The ported-game catalog is identical on every deployment — it lives in
  // DEMO_TITLES, the source the DB seed merely copies — so render it directly in
  // both the static and server builds. This is what keeps the catalog from
  // depending on the `titles` table being seeded (the gap that left the Cartbox
  // tab empty on the server deploy); the server build enriches it with user carts.
  const [cartboxCarts, setCartboxCarts] = useState<GridCart[]>(
    isStaticExport
      ? [...titleGridCarts(DEMO_TITLES), ...demoGridCarts()]
      : titleGridCarts(DEMO_TITLES),
  );

  const [category, setCategory] = useState<TicArcadeCategory>("Games");
  const [arcadeByCategory, setArcadeByCategory] = useState<
    Partial<Record<TicArcadeCategory, GridCart[]>>
  >({});
  const [arcadeFailed, setArcadeFailed] = useState(false);
  const [search, setSearch] = useState("");

  // Cartbox catalog (server build) — the static build ships it baked in.
  useEffect(() => {
    if (isStaticExport) {
      return;
    }
    let cancelled = false;
    // The catalog is already shown from DEMO_TITLES (set above); here we only
    // fetch the user carts to append. A carts failure therefore leaves the
    // catalog intact rather than blanking the Cartbox tab.
    fetch("/api/carts?limit=100")
      .then(async (cartsResponse) => {
        if (!cartsResponse.ok) {
          throw new Error(`carts request failed: ${cartsResponse.status}`);
        }
        const body = (await cartsResponse.json()) as { carts: ApiCart[] };
        if (!cancelled) {
          setCartboxCarts([
            ...titleGridCarts(DEMO_TITLES),
            ...body.carts.map<GridCart>((cart) => ({
              id: cart.id,
              title: cart.title,
              priceCents: cart.price_cents,
              modelId: cart.console_model,
              thumbUrl: cart.thumbUrl,
              cartUrl: cart.cartUrl,
              // resolveModelId, not a cast: console_model is an untrusted text
              // column, and a cast would index the map with an unknown value and
              // hand the player `undefined` for its engine.
              engineUrl: cart.cartUrl ? ENGINE_URL_BY_MODEL[resolveModelId(cart.console_model)] : null,
              plays: cart.plays,
            })),
          ]);
        }
      })
      .catch(() => {
        // The DEMO_TITLES catalog is already displayed; a failed carts fetch just
        // means no user carts are appended, not an empty archive.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Arcade listings load lazily per category and are kept for the session.
  useEffect(() => {
    if (source !== "arcade" || arcadeByCategory[category]) {
      return;
    }
    let cancelled = false;
    setArcadeFailed(false);
    fetchTicArcadeCategory(category)
      .then((entries) => {
        if (!cancelled) {
          setArcadeByCategory((current) => ({ ...current, [category]: arcadeGridCarts(entries) }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setArcadeFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [source, category, arcadeByCategory]);

  const arcadeCarts = arcadeByCategory[category] ?? null;
  const visibleArcade = useMemo(() => {
    if (!arcadeCarts) {
      return null;
    }
    const query = search.trim().toLowerCase();
    return query ? arcadeCarts.filter((cart) => cart.title.toLowerCase().includes(query)) : arcadeCarts;
  }, [arcadeCarts, search]);

  return (
    <div className="os-page" data-console-nav data-testid="browse-screen">
      <h2>BROWSE CARTRIDGES</h2>

      <div className="os-kind-toggle" role="tablist" aria-label="Catalog source">
        <button
          type="button"
          role="tab"
          aria-selected={source === "cartbox"}
          className="os-kind-option"
          data-active={source === "cartbox"}
          onClick={() => setSource("cartbox")}
        >
          CARTBOX
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={source === "arcade"}
          className="os-kind-option"
          data-active={source === "arcade"}
          onClick={() => setSource("arcade")}
        >
          TIC-80 ARCADE
        </button>
      </div>

      {source === "cartbox" && (
        <div style={{ marginTop: 10 }}>
          {cartboxCarts.length === 0 ? (
            <div className="os-empty">No cartridges published yet.</div>
          ) : (
            <CartGrid carts={cartboxCarts} onPlayCart={onPlayCart} />
          )}
        </div>
      )}

      {source === "arcade" && (
        <div style={{ marginTop: 10 }}>
          <div className="os-chip-row" role="tablist" aria-label="Archive category">
            {TIC_ARCADE_CATEGORIES.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={category === name}
                className="os-chip"
                data-active={category === name}
                onClick={() => setCategory(name)}
              >
                {name.toUpperCase()}
              </button>
            ))}
          </div>
          <input
            className="os-input"
            type="search"
            placeholder={`Search ${category.toLowerCase()}…`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            style={{ width: "100%", margin: "8px 0" }}
          />
          {arcadeFailed && (
            <div className="os-empty">
              tic80.com could not be reached —<br />
              check your connection and try again.
            </div>
          )}
          {!arcadeFailed && visibleArcade === null && <div className="os-loading">DIALING THE ARCADE…</div>}
          {visibleArcade !== null && (
            <>
              <div className="os-grid-sub" style={{ margin: "0 0 8px" }}>
                {visibleArcade.length} of {arcadeCarts?.length ?? 0} carts · played live from tic80.com
              </div>
              {visibleArcade.length === 0 && <div className="os-empty">No carts match that search.</div>}
              <CartGrid carts={visibleArcade} onPlayCart={onPlayCart} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
