// Seeds the NEON CITY cart into the local stack as a real, playable Pro cartridge:
// uploads the .tic to object storage and upserts a published `carts` row owned by
// the demo profile. Idempotent (fixed id). Mirrors scripts/seed.mjs.
//
// Run with the app env, e.g.:
//   node --env-file=apps/web/.env.local scripts/seed-neon-city.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { putCartObject, storageBackend } from "./lib/seedStorage.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

const NEON_CART_ID = "00000000-0000-4000-8000-000000000010";
const CART_PATH = new URL("../packages/player/examples/neon-city.tic", import.meta.url);

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});


async function main() {
  // Own it with the existing demo profile so the row satisfies the FK.
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id")
    .eq("handle", "demo")
    .single();
  if (profileError || !profile) {
    throw new Error(`no demo profile to own the cart: ${profileError?.message ?? "not found"}`);
  }

  const bytes = new Uint8Array(readFileSync(CART_PATH));
  const r2Key = `carts/${NEON_CART_ID}.tic`;
  const storedKey = await putCartObject(r2Key, bytes);

  const { error } = await supabase.from("carts").upsert({
    id: NEON_CART_ID,
    owner_id: profile.id,
    title: "Neon City",
    slug: "neon-city",
    description:
      "A cyberpunk side-scroller on the Pro core: parallax skyline, emissive neon, wet-street light pools, and a screen-space puddle reflection.",
    tags: ["cyberpunk", "pro", "demo"],
    console_model: "pro",
    price_cents: 0,
    r2_key: storedKey,
    published: true,
  });
  if (error) throw new Error(`seeding carts failed: ${error.message}`);

  console.log(`Seeded NEON CITY (${bytes.byteLength} bytes) — play it at /play/${NEON_CART_ID}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
