/**
 * /play/[cartId] — cartridge detail page.
 *
 * Server component: loads the cart, resolves the buyer's entitlement, and
 * renders either the playable cartridge (free or owned) or a buy prompt.
 * The interactive player itself is the CartridgePlayer client leaf.
 */

import { notFound } from "next/navigation";

import { serviceClient } from "@/lib/supabase";
import { publicUrl } from "@/lib/storage";
import { getServerUserId } from "@/lib/supabase-server";
import { ENGINE_URL_BY_MODEL } from "@/lib/consoleModel";
import { isStaticExport } from "@/lib/staticSite";
import { DEMO_CARTS, demoCartUrl, findDemoCart } from "@/lib/demoCatalog";
import { parsePostFxSettings, type ModelId } from "@cartbox/player";
import { CartridgePlayer } from "./CartridgePlayer";
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

// The static demo build prerenders one page per baked-in cart; the server
// build resolves carts (and purchase entitlements) per request.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

export function generateStaticParams(): { cartId: string }[] {
  return isStaticExport ? DEMO_CARTS.map((cart) => ({ cartId: cart.id })) : [];
}

/** Build-time cart page over the baked-in demo catalog (static build only). */
function StaticCartridgePage({ cartId }: { cartId: string }) {
  const cart = findDemoCart(cartId);
  if (!cart) {
    notFound();
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
    notFound();
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
