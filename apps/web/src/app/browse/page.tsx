/**
 * /browse — the unified catalog gallery.
 *
 * Shows two kinds of playable thing in one grid: user-authored Cartbox carts and
 * curated catalog titles (open-source games, publisher freeware, and open-source
 * engines whose data the player supplies). Both are normalised to a
 * `CatalogEntry` (src/lib/catalog.ts) and interleaved newest-first, so the page
 * reads as one library rather than two stacked lists.
 *
 * Server component; ?tag= narrows by tag and ?runtime= narrows the grid to one
 * player implementation. The static demo build has no server to read those
 * params, so it delegates to a client-filtered browser instead.
 */

import Link from "next/link";

import { serviceClient } from "@/lib/supabase";
import { publicUrl } from "@/lib/storage";
import { isStaticExport } from "@/lib/staticSite";
import {
  cartToEntry,
  filterByRuntime,
  mergeCatalog,
  titleToEntry,
  type CartRow,
  type TitleRow,
} from "@/lib/catalog";
import { runtimeDescriptors } from "@/lib/titleRuntime";
import { CatalogGrid } from "./CatalogGrid";
import { StaticCatalogBrowser } from "./StaticCatalogBrowser";

interface BrowseProps {
  searchParams: { tag?: string; runtime?: string };
}

const CATALOG_LIMIT = 60;

// The static demo build renders the baked-in catalog at build time; the server
// build must stay dynamic so a just-published cart appears immediately.
export const dynamic = isStaticExport ? "auto" : "force-dynamic";

/** URL-driven filter chips, plus an "all" reset. Server build only. */
function RuntimeFilter({ active, tag }: { active?: string; tag?: string }) {
  const buildHref = (runtime?: string): string => {
    const params = new URLSearchParams();
    if (tag) {
      params.set("tag", tag);
    }
    if (runtime) {
      params.set("runtime", runtime);
    }
    const query = params.toString();
    return query ? `/browse?${query}` : "/browse";
  };

  return (
    <nav style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0 20px" }}>
      <Link href={buildHref()} aria-current={active ? undefined : "page"}>
        All
      </Link>
      {runtimeDescriptors().map((runtime) => (
        <Link
          key={runtime.id}
          href={buildHref(runtime.id)}
          aria-current={active === runtime.id ? "page" : undefined}
        >
          {runtime.label}
        </Link>
      ))}
    </nav>
  );
}

export default async function BrowsePage({ searchParams }: BrowseProps) {
  // Must not touch `searchParams` on this path: reading them forces the page
  // out of static rendering and fails the export build.
  if (isStaticExport) {
    return (
      <main>
        <h1>Browse</h1>
        <StaticCatalogBrowser />
      </main>
    );
  }

  const db = serviceClient();

  let cartQuery = db
    .from("carts")
    .select("id, title, description, console_model, price_cents, thumb_key, plays, created_at")
    .eq("published", true)
    .order("created_at", { ascending: false })
    .limit(CATALOG_LIMIT);

  let titleQuery = db
    .from("titles")
    .select("id, name, description, runtime, asset_source, tier, price_cents, thumb_key, plays, created_at")
    .eq("published", true)
    .order("created_at", { ascending: false })
    .limit(CATALOG_LIMIT);

  if (searchParams.tag) {
    cartQuery = cartQuery.contains("tags", [searchParams.tag]);
    titleQuery = titleQuery.contains("tags", [searchParams.tag]);
  }

  const [carts, titles] = await Promise.all([cartQuery, titleQuery]);

  // Thumbnails live in R2 for both kinds; a missing key renders without art.
  const resolveThumb = (key: string | null | undefined): string | null =>
    key ? publicUrl(key) : null;

  // Each query is limited independently, so the merged grid is re-trimmed to
  // keep one page's worth after interleaving.
  const entries = filterByRuntime(
    mergeCatalog([
      ((carts.data ?? []) as CartRow[]).map((cart) => cartToEntry(cart, resolveThumb)),
      ((titles.data ?? []) as TitleRow[]).map((title) => titleToEntry(title, resolveThumb)),
    ]),
    searchParams.runtime,
  ).slice(0, CATALOG_LIMIT);

  return (
    <main>
      <h1>Browse{searchParams.tag ? ` · #${searchParams.tag}` : ""}</h1>
      <RuntimeFilter active={searchParams.runtime} tag={searchParams.tag} />
      <CatalogGrid entries={entries} />
    </main>
  );
}
