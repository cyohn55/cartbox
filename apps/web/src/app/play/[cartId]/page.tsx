/**
 * /play/[cartId] — catalog detail page.
 *
 * Server component: loads the cart, resolves the buyer's entitlement, and
 * renders either the playable cartridge (free or owned) or a buy prompt.
 * The interactive player itself is the CartridgePlayer client leaf.
 *
 * The same route also serves catalog titles (open-source games, freeware, and
 * user-supplied-asset source ports). Carts are resolved first so the existing
 * path is untouched; an id that is not a cart falls through to `titles` and
 * dispatches through the runtime registry (src/lib/titleRuntime.ts).
 */

import { notFound } from "next/navigation";

import { serviceClient } from "@/lib/supabase";
import { publicUrl } from "@/lib/storage";
import { getServerUserId } from "@/lib/supabase-server";
import { ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
import { isStaticExport } from "@/lib/staticSite";
import { DEMO_CARTS, demoCartUrl, findDemoCart } from "@/lib/demoCatalog";
import { DEMO_TITLES, findDemoTitle } from "@/lib/demoTitles";
import { requiresUserAssets, resolveRuntime, type AssetSource } from "@/lib/titleRuntime";
import { requiresSourceOffer } from "@/lib/licensing";
import { parsePostFxSettings, type ModelId } from "@cartbox/player";
import { CartridgePlayer } from "./CartridgePlayer";
import { AssetSupply } from "./AssetSupply";
import { WasmGamePlayer } from "./WasmGamePlayer";
import { BuyButton } from "@/app/play/[cartId]/BuyButton";

/**
 * Per-model WASM engine URL (served from apps/web/public/engine). Each console
 * model runs its own core — the side-by-side compatibility architecture — so the
 * engine must be selected by the cart's console_model, not hard-coded to Classic.
 * The shared map already carries the deploy base path for static hosting.
 */
function engineUrlForModel(model: string): string {
  return ENGINE_URL_BY_MODEL[model as keyof typeof ENGINE_URL_BY_MODEL] ?? ENGINE_URL_BY_MODEL.classic;
}

interface PageProps {
  params: { cartId: string };
}

/** Fallback resolution for a bundled game whose title row omits one. */
const DEFAULT_GAME_WIDTH = 320;
const DEFAULT_GAME_HEIGHT = 180;

// The static demo build prerenders one page per baked-in cart; the server
// build resolves carts (and purchase entitlements) per request.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

export function generateStaticParams(): { cartId: string }[] {
  if (!isStaticExport) {
    return [];
  }
  return [
    ...DEMO_CARTS.map((cart) => ({ cartId: cart.id })),
    ...DEMO_TITLES.map((title) => ({ cartId: title.id })),
  ];
}

/**
 * Detail panel for a catalog title.
 *
 * Phase 1 ships the registry and the dispatch, not the players: every non-Cartbox
 * runtime is declared but unimplemented, so this reports what the title needs
 * rather than booting an engine that does not exist yet. Phases 2 and 3 replace
 * the two placeholder branches with the bundled player and the asset-supply flow.
 */
function TitleDetail({
  id,
  name,
  description,
  runtimeId,
  assetSource,
  license,
  sourceUrl,
  bundleName,
  width,
  height,
}: {
  id: string;
  name: string;
  description: string;
  runtimeId: string;
  assetSource: AssetSource;
  license: string;
  sourceUrl: string | null;
  bundleName?: string;
  width?: number;
  height?: number;
}) {
  const runtime = resolveRuntime(runtimeId);
  // A title is runnable only once its runtime exists *and* a compiled bundle has
  // been published for it — the catalog lists titles ahead of their ports.
  const playable = runtime?.implemented === true && Boolean(bundleName) && assetSource === "bundled";

  return (
    <main>
      <h1>{name}</h1>
      <p>{description}</p>

      {!runtime ? (
        // An unknown runtime must read as "cannot play this" rather than
        // silently falling back to a Cartbox engine that would fail obscurely.
        <p>This title is not playable on this console.</p>
      ) : playable ? (
        <WasmGamePlayer
          titleId={id}
          bundleName={bundleName as string}
          width={width ?? DEFAULT_GAME_WIDTH}
          height={height ?? DEFAULT_GAME_HEIGHT}
        />
      ) : requiresUserAssets(assetSource) ? null : (
        <p>{name} has not been ported to this console yet.</p>
      )}

      {/*
        Tier C ships the engine only, so the asset-supply flow is shown whatever
        the runtime's state: a player can stage their game data now and have it
        ready when the runtime lands.
      */}
      {requiresUserAssets(assetSource) && <AssetSupply titleId={id} titleName={name} />}

      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        License: {license}
        {/* Copyleft obliges a corresponding-source offer; the link is that offer. */}
        {sourceUrl && requiresSourceOffer(license) && (
          <>
            {" · "}
            <a href={sourceUrl} rel="noreferrer">
              Source
            </a>
          </>
        )}
      </p>
    </main>
  );
}

/** Build-time cart page over the baked-in demo catalog (static build only). */
function StaticCartridgePage({ cartId }: { cartId: string }) {
  const cart = findDemoCart(cartId);
  if (!cart) {
    const title = findDemoTitle(cartId);
    if (!title) {
      notFound();
    }
    return (
      <TitleDetail
        id={title.id}
        name={title.name}
        description={title.description}
        runtimeId={title.runtime}
        assetSource={title.assetSource}
        license={title.license}
        sourceUrl={title.sourceUrl}
        bundleName={title.bundleName}
        width={title.width}
        height={title.height}
      />
    );
  }
  return (
    <main>
      <h1>{cart.title}</h1>
      <CartridgePlayer
        cartId={cart.id}
        cartUrl={demoCartUrl(cart.id)}
        engineUrl={engineUrlForModel(cart.consoleModel)}
        modelId={cart.consoleModel as ModelId}
        postFx={null}
      />
      <p>{cart.description}</p>
    </main>
  );
}

export default async function CartridgePage({ params }: PageProps) {
  if (isStaticExport) {
    return <StaticCartridgePage cartId={params.cartId} />;
  }

  const db = serviceClient();
  const { data: cart } = await db
    .from("carts")
    .select("id, title, description, price_cents, r2_key, owner_id, console_model, fx")
    .eq("id", params.cartId)
    .eq("published", true)
    .single();

  if (!cart) {
    return await CatalogTitlePage(params.cartId);
  }

  const isFree = cart.price_cents === 0;
  const owned = isFree ? true : await hasEntitlement(cart.id);
  const cartUrl = publicUrl(cart.r2_key);

  return (
    <main>
      <h1>{cart.title}</h1>
      {owned ? (
        <CartridgePlayer
          cartId={cart.id}
          cartUrl={cartUrl}
          engineUrl={engineUrlForModel(cart.console_model)}
          modelId={cart.console_model as ModelId}
          postFx={parsePostFxSettings(cart.fx)}
        />
      ) : (
        <section>
          <p>{cart.description}</p>
          <BuyButton cartId={cart.id} priceCents={cart.price_cents} />
        </section>
      )}
    </main>
  );
}

/**
 * Resolves an id that is not a cart against the catalog `titles` table. Called
 * only after the cart lookup misses, so the cart path costs no extra query.
 */
async function CatalogTitlePage(titleId: string) {
  const db = serviceClient();
  const { data: title } = await db
    .from("titles")
    .select("id, name, description, runtime, asset_source, license, source_url, bundle_key")
    .eq("id", titleId)
    .eq("published", true)
    .single();

  if (!title) {
    notFound();
  }

  return (
    <TitleDetail
      id={title.id}
      name={title.name}
      description={title.description}
      runtimeId={title.runtime}
      assetSource={title.asset_source as AssetSource}
      license={title.license}
      sourceUrl={title.source_url}
      bundleName={title.bundle_key ?? undefined}
    />
  );
}

/** True when the current signed-in user has already purchased the cart. */
async function hasEntitlement(cartId: string): Promise<boolean> {
  const userId = await getServerUserId();
  if (!userId) {
    return false;
  }
  const db = serviceClient();
  const { data } = await db
    .from("purchases")
    .select("id")
    .eq("buyer_id", userId)
    .eq("cart_id", cartId)
    .maybeSingle();
  return data !== null;
}
