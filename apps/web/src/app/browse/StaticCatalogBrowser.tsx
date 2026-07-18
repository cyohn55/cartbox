"use client";

/**
 * Browse for the static demo build.
 *
 * The static export has no server, so the runtime filter cannot be driven by
 * `searchParams` — reading them at all forces the page out of static rendering.
 * The filter therefore lives in client state here, over the baked-in catalog,
 * while the Supabase-backed build keeps its URL-driven server filtering (which
 * is what lets it narrow the query rather than the rendered page).
 */

import { useMemo, useState } from "react";

import { filterByRuntime, mergeCatalog } from "@/lib/catalog";
import { DEMO_CARTS, demoCartToEntry } from "@/lib/demoCatalog";
import { DEMO_TITLES, demoTitleToEntry } from "@/lib/demoTitles";
import { runtimeDescriptors, type RuntimeId } from "@/lib/titleRuntime";
import { CatalogGrid } from "./CatalogGrid";

export function StaticCatalogBrowser() {
  const [activeRuntime, setActiveRuntime] = useState<RuntimeId | null>(null);

  // The demo catalog is fixed at build time, so this only re-runs on filter changes.
  const allEntries = useMemo(
    () => mergeCatalog([DEMO_CARTS.map(demoCartToEntry), DEMO_TITLES.map(demoTitleToEntry)]),
    [],
  );
  const entries = useMemo(
    () => filterByRuntime(allEntries, activeRuntime),
    [allEntries, activeRuntime],
  );

  return (
    <>
      <nav style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0 20px" }}>
        <button
          type="button"
          onClick={() => setActiveRuntime(null)}
          aria-pressed={activeRuntime === null}
        >
          All
        </button>
        {runtimeDescriptors().map((runtime) => (
          <button
            key={runtime.id}
            type="button"
            onClick={() => setActiveRuntime(runtime.id)}
            aria-pressed={activeRuntime === runtime.id}
          >
            {runtime.label}
          </button>
        ))}
      </nav>
      <CatalogGrid entries={entries} />
    </>
  );
}
