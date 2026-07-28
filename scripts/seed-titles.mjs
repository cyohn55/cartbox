// Seeds the catalog titles — the ported open-source and freeware games — into
// the `titles` table.
//
// Why this exists: the curated catalog was only ever written down in
// apps/web/src/lib/demoTitles.ts, which the *static* build reads directly. A
// server build (local dev, Vercel) reads `titles` instead, and nothing ever
// populated it — so Browse on a real backend showed carts and no games at all.
//
// The list here is not re-typed: it is imported from demoTitles.ts, which stays
// the single source of truth. Seeding is an upsert on the stable slug, so
// re-running after adding a title is safe and updates existing rows in place.
//
//   node --env-file=apps/web/.env.local scripts/seed-titles.mjs

import { createClient } from "@supabase/supabase-js";

import { loadTsModule } from "./lib/loadTs.mjs";

const { DEMO_TITLES } = await loadTsModule(
  new URL("../apps/web/src/lib/demoTitles.ts", import.meta.url),
);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

/**
 * The launch target for a shared-engine runtime.
 *
 * DOSBox and ScummVM each host many games from one bundle, so the row needs to
 * name which one; every other runtime's bundle *is* the game.
 */
function launchTarget(title) {
  return title.dosTarget ?? title.scummvmTarget ?? null;
}

/** A DEMO_TITLES entry as a `titles` row. */
function titleRow(title) {
  return {
    id: title.id,
    slug: title.slug,
    name: title.name,
    description: title.description,
    runtime: title.runtime,
    asset_source: title.assetSource,
    tier: title.tier,
    license: title.license,
    source_url: title.sourceUrl,
    bundle_key: title.bundleName ?? null,
    launch_target: launchTarget(title),
    width: title.width ?? 320,
    height: title.height ?? 180,
    // Catalog titles are free: pricing requires a verified rightsholder claim.
    price_cents: 0,
    // Only a title that can actually boot is listed. Tier C entries ship the
    // engine and expect the player's own data, and a catalogued-but-unported
    // title has no bundle — both are better absent from the console than
    // present and dead.
    published: Boolean(title.bundleName) && title.assetSource === "bundled",
    created_at: title.releasedAt,
  };
}

const rows = DEMO_TITLES.map(titleRow);

const { data, error } = await supabase
  .from("titles")
  .upsert(rows, { onConflict: "slug" })
  .select("slug, published");

if (error) {
  console.error(`Seeding titles failed: ${error.message}`);
  process.exit(1);
}

const published = data.filter((row) => row.published);
console.log(
  `Seeded ${data.length} catalog titles — ${published.length} playable in Browse: ` +
    published.map((row) => row.slug).join(", "),
);
