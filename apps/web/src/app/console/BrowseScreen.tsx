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
import { DEMO_CARTS, demoCartUrl, demoThumbUrl } from "@/lib/demoCatalog";
import { DEMO_TITLES } from "@/lib/demoTitles";
import { ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
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

interface ApiTitle {
  id: string;
  name: string;
  price_cents: number;
  plays: number;
  thumbUrl: string | null;
  bundleName: string | null;
  runtime?: string | null;
  width: number;
  height: number;
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
        // The iframe-hosted engines (ScummVM, SuperTux, DOS) name themselves; a
        // ScummVM target is honoured for older rows that predate the runtime
        // column; everything else is a Cartbox Game ABI module.
        runtime:
          title.runtime === "supertux"
            ? ("supertux" as const)
            : title.runtime === "dos"
              ? ("dos" as const)
              : title.runtime === "scummvm" || title.scummvmTarget
                ? ("scummvm" as const)
                : ("wasm-app" as const),
        bundleName: title.bundleName as string,
        width: title.width ?? 320,
        height: title.height ?? 180,
        target: title.dosTarget ?? title.scummvmTarget ?? undefined,
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
  const [cartboxCarts, setCartboxCarts] = useState<GridCart[] | null>(
    isStaticExport ? [...titleGridCarts(DEMO_TITLES), ...demoGridCarts()] : null,
  );
  const [cartboxFailed, setCartboxFailed] = useState(false);

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
    Promise.all([
      fetch("/api/carts?limit=100"),
      // A missing titles route must not blank the cart grid, so this failure is
      // absorbed rather than rejecting the pair.
      fetch("/api/titles?limit=100").catch(() => null),
    ])
      .then(async ([cartsResponse, titlesResponse]) => {
        if (!cartsResponse.ok) {
          throw new Error(`carts request failed: ${cartsResponse.status}`);
        }
        const body = (await cartsResponse.json()) as { carts: ApiCart[] };
        const titles: ApiTitle[] =
          titlesResponse && titlesResponse.ok
            ? ((await titlesResponse.json()) as { titles: ApiTitle[] }).titles
            : [];
        if (!cancelled) {
          setCartboxCarts([
            ...titleGridCarts(titles.map((title) => ({ ...title, bundleName: title.bundleName }))),
            ...body.carts.map<GridCart>((cart) => ({
              id: cart.id,
              title: cart.title,
              priceCents: cart.price_cents,
              modelId: cart.console_model,
              thumbUrl: cart.thumbUrl,
              cartUrl: cart.cartUrl,
              engineUrl: cart.cartUrl
                ? ENGINE_URL_BY_MODEL[cart.console_model as "classic" | "pro"]
                : null,
              plays: cart.plays,
            })),
          ]);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCartboxFailed(true);
        }
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
          {cartboxFailed && <div className="os-empty">The archive could not be reached.</div>}
          {!cartboxFailed && cartboxCarts === null && <div className="os-loading">OPENING THE ARCHIVE…</div>}
          {cartboxCarts !== null && cartboxCarts.length === 0 && (
            <div className="os-empty">No cartridges published yet.</div>
          )}
          {cartboxCarts !== null && cartboxCarts.length > 0 && (
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
