// Seeds the NIGHTWALL cart — the first NORMAL-MAPPED Pro demo: mid-tone albedo
// with authored per-pixel normals/height/specular/emissive, relit at runtime by
// the cart's own cartbox.sun (moon key) + cartbox.spot (streetlamp). Unlike
// OVERLOOK (painted, post-FX only), this exercises the runtime lighting layer —
// a directional key and a cone spot sculpting real normals. Uploads the .tic and
// upserts a published `carts` row (with its post-FX finish) owned by the demo
// profile. Idempotent (fixed id). Mirrors scripts/seed-overlook.mjs.
//
// Run with the app env, e.g.:
//   node --env-file=apps/web/.env.local scripts/seed-nightwall.mjs           (local)
//   node --env-file=apps/web/.env.production.local scripts/seed-nightwall.mjs (prod)

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { putCartObject } from "./lib/seedStorage.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

const NIGHTWALL_CART_ID = "00000000-0000-4000-8000-000000000021";
const CART_PATH = new URL("../packages/player/examples/nightwall.tic", import.meta.url);

// The cinematic finish (a @cartbox/player PostFxSettings), applied by the player
// at runtime on top of the dynamic lighting. Matches the tuned NIGHTWALL preview:
// bloom the neon/spec, split-tone shadows teal + highlights amber, soft god rays
// aimed at the streetlamp pool, held with vignette + fine grain.
const FX = {
  enabled: {
    grade: true, fog: true, bloom: true, crt: false, chroma: true,
    vignette: true, posterize: false, dither: false, halftone: false,
    godrays: true, streaks: true, splittone: true, kaleidoscope: false, grain: true,
  },
  values: {
    "grade.brightness": 0.98, "grade.contrast": 1.12, "grade.saturation": 1.14,
    "fog.density": 0.14, "fog.horizon": 0.52,
    "bloom.strength": 1.0, "bloom.threshold": 0.55,
    "chroma.amount": 0.6, "vignette.strength": 0.42,
    "godrays.strength": 0.8, "godrays.density": 0.6, "godrays.decay": 0.96,
    "godrays.x": 0.66, "godrays.y": 0.57,
    "streaks.strength": 0.45, "streaks.length": 0.35,
    "splittone.strength": 0.55, "splittone.balance": 0.5,
    "grain.amount": 0.06, "grain.size": 1,
  },
  colors: {
    "fog.tint": "#2a2f45",
    "splittone.shadows": "#24304f",
    "splittone.highlights": "#ffcf9a",
  },
};

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

async function main() {
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id")
    .eq("handle", "demo")
    .single();
  if (profileError || !profile) {
    throw new Error(
      `no demo profile to own the cart: ${profileError?.message ?? "not found"}. ` +
        `Run scripts/seed.mjs first to create the demo user.`,
    );
  }

  const bytes = new Uint8Array(readFileSync(CART_PATH));
  const storedKey = await putCartObject(`carts/${NIGHTWALL_CART_ID}.tic`, bytes);

  const { error } = await supabase.from("carts").upsert({
    id: NIGHTWALL_CART_ID,
    owner_id: profile.id,
    title: "Nightwall",
    slug: "nightwall",
    description:
      "A normal-mapped night alley on the Pro core: mid-tone brick, wet cobbles, a lone " +
      "figure and a neon sign, all relit in real time by a cool moon key (directional) and " +
      "a warm streetlamp cone (spot) sculpting authored per-pixel normals — with specular " +
      "glints on the wet stone, an emissive sign, and a full post-FX finish. The runtime " +
      "'3D-lit 2D' look, in the vein of Replaced and The Last Night.",
    tags: ["cinematic", "pixel-art", "lighting", "pro", "demo"],
    console_model: "pro",
    price_cents: 0,
    r2_key: storedKey,
    fx: FX,
    published: true,
  });
  if (error) throw new Error(`seeding carts failed: ${error.message}`);

  console.log(`Seeded NIGHTWALL (${bytes.byteLength} bytes) — play it at /play/${NIGHTWALL_CART_ID}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
