/**
 * /edit/[cartId] — the custom Cartbox editor. Server component: resolves the
 * cart's name, its marketplace details, the URL of its stored .tic, and every
 * sidecar it carries (best-effort), then hands off to the client workbench,
 * which loads those bytes into the WASM engine. A cart with no stored bytes
 * opens on the demo seed.
 *
 * The sidecars come back as one bundle from the registry (lib/sidecars.ts)
 * rather than being listed here payload by payload — which is what used to let
 * a new sidecar reach the database and never reach the editor.
 */

import { serviceClient } from "@/lib/supabase";
import { publicUrl } from "@/lib/storage";
import { loadSidecars } from "@/lib/sidecarStorage";
import { parseCartAssets } from "@/lib/cartAssetStore";
import { emptySidecars, type Sidecars } from "@/lib/sidecars";
import { resolveModelId } from "@/lib/consoleModel";
import { resolveStarterId } from "@/lib/starter";
import { isStaticExport } from "@/lib/staticSite";
import { DEMO_CARTS, DEMO_DRAFT_CART_ID } from "@/lib/demoCatalog";
import { EditorWorkbench } from "./EditorWorkbench";
import { StaticCartEditor } from "./StaticCartEditor";

// The static demo build prerenders an editor page per demo cart plus the local
// draft slot; the server build resolves carts per request.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

export function generateStaticParams(): { cartId: string }[] {
  if (!isStaticExport) {
    return [];
  }
  return [{ cartId: DEMO_DRAFT_CART_ID }, ...DEMO_CARTS.map((cart) => ({ cartId: cart.id }))];
}

interface EditorPageProps {
  params: { cartId: string };
  searchParams: { model?: string; starter?: string };
}

interface CartTarget {
  name: string;
  cartUrl: string | null;
  /** Persisted console model, or null when the cart has no row yet (new cart). */
  storedModel: string | null;
  /** Every sidecar the cart carries, each null when it has none. */
  sidecars: Sidecars;
  /** Persisted marketplace description, or empty when none. */
  description: string;
  /** Persisted marketplace tags, or empty when none. */
  tags: string[];
  /**
   * Whether the cart references any uploaded assets.
   *
   * Answered here rather than by the Files panel, because the panel only mounts
   * when its tab is open and that tab is what this answer decides. A cart whose
   * model has no asset budget shows the tab only when it is already storing
   * something, so asking the panel would be circular and the tab would never
   * appear for exactly the carts that need it.
   */
  hasAssets: boolean;
}

/** A cart that has no row yet, or whose row could not be read. */
function blankCart(): CartTarget {
  return {
    name: "Untitled cartridge",
    cartUrl: null,
    storedModel: null,
    sidecars: emptySidecars(),
    description: "",
    tags: [],
    hasAssets: false,
  };
}

/**
 * Whether this cart references any stored asset.
 *
 * Its own query, deliberately: `assets` arrived in migration 0024, and folding
 * it into the main select would make an environment without that migration fail
 * the whole read and open every cart blank. This is the same per-column
 * tolerance `loadSidecars` applies, for the same reason — a missing column
 * costs one answer, not the page.
 */
async function loadHasAssets(cartId: string): Promise<boolean> {
  try {
    const { data } = await serviceClient()
      .from("carts")
      .select("assets")
      .eq("id", cartId)
      .maybeSingle();
    const parsed = parseCartAssets(data?.assets);
    return parsed !== null && Object.keys(parsed.entries).length > 0;
  } catch {
    return false;
  }
}

async function resolveCart(cartId: string): Promise<CartTarget> {
  try {
    const [{ data }, sidecars, hasAssets] = await Promise.all([
      serviceClient()
        .from("carts")
        .select("title, description, tags, r2_key, console_model")
        .eq("id", cartId)
        .maybeSingle(),
      loadSidecars(cartId),
      loadHasAssets(cartId),
    ]);
    return {
      name: data?.title ?? "Untitled cartridge",
      cartUrl: data?.r2_key ? publicUrl(data.r2_key) : null,
      storedModel: data?.console_model ?? null,
      sidecars,
      description: typeof data?.description === "string" ? data.description : "",
      tags: Array.isArray(data?.tags) ? (data.tags as string[]) : [],
      hasAssets,
    };
  } catch {
    // An unreachable database opens the editor on a fresh cart rather than
    // failing the page. (A missing sidecar column is already handled inside
    // loadSidecars, one column at a time.)
    return blankCart();
  }
}

export default async function EditorPage({ params, searchParams }: EditorPageProps) {
  if (isStaticExport) {
    // No database at build time — the client leaf resolves local drafts, baked
    // demo carts, and URL params (searchParams are unavailable in an export).
    return <StaticCartEditor cartId={params.cartId} />;
  }

  const { name, cartUrl, storedModel, sidecars, description, tags, hasAssets } = await resolveCart(
    params.cartId,
  );
  // A saved cart's persisted model is authoritative; a brand-new cart (no row)
  // takes the model from the ?model= param carried in from /edit/new.
  const modelId = resolveModelId(storedModel ?? searchParams.model);
  // The starter only seeds a brand-new cart (one with no stored bytes); the
  // workbench ignores it once real cart bytes load.
  const starterId = resolveStarterId(searchParams.starter);
  return (
    <EditorWorkbench
      cartId={params.cartId}
      cartName={name}
      cartUrl={cartUrl}
      modelId={modelId}
      starterId={starterId}
      initialSidecars={sidecars}
      initialDescription={description}
      initialTags={tags}
      initialHasAssets={hasAssets}
    />
  );
}
