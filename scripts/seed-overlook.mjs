// Seeds the OVERLOOK cart — the cinematic 2.5D art-style canvas (REPLACED /
// THE LAST NIGHT look) — as a real, playable Pro cartridge: uploads the .tic to
// object storage and upserts a published `carts` row (with its post-FX stack)
// owned by the demo profile. Idempotent (fixed id). Mirrors scripts/seed-neon-city.mjs.
//
// Run with the app env, e.g.:
//   node --env-file=apps/web/.env.local scripts/seed-overlook.mjs           (local)
//   node --env-file=apps/web/.env.production.local scripts/seed-overlook.mjs (prod)

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { flicker, pulse } from "@cartbox/player";
import { putCartObject } from "./lib/seedStorage.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

const OVERLOOK_CART_ID = "00000000-0000-4000-8000-000000000020";
const CART_PATH = new URL("../packages/player/examples/overlook.tic", import.meta.url);

// The cinematic finish, applied by the player at runtime. A PostFxSettings
// object: bloom the neon/moon through the multi-scale pyramid (gap #4) and roll
// the hot highlights off the HDR tonemap so they keep their colour, split-tone
// shadows teal and highlights amber, hold the frame with vignette + grain.
// God-ray source aims at the moon disc. Kept in step with fx-preset.json.
const FX = {
  enabled: {
    grade: true, fog: true, bloom: true, tonemap: true, crt: false, chroma: true,
    vignette: true, posterize: false, dither: false, halftone: false,
    godrays: true, streaks: true, splittone: true, kaleidoscope: false, grain: true,
  },
  values: {
    "grade.brightness": 0.98, "grade.contrast": 1.12, "grade.saturation": 1.14,
    "fog.density": 0.14, "fog.horizon": 0.52,
    "bloom.strength": 0.9, "bloom.threshold": 0.55, "bloom.radius": 0.78,
    "tonemap.exposure": 1.15,
    "chroma.amount": 0.6, "vignette.strength": 0.42,
    "godrays.strength": 0.9, "godrays.density": 0.6, "godrays.decay": 0.96,
    "godrays.x": 0.73, "godrays.y": 0.49,
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

// Ambient motion (cinematic gap #1), played host-side over the painted frame. As a
// painted cart OVERLOOK has no scene layers or sprite clips to animate, so the
// motion rides on the post-FX finish: the candle/neon bloom gutters like a live
// flame, and the moon's god rays breathe. Built from the player's own generators so
// it matches the Anim-tab authoring. Both keys already exist in FX above; the tracks
// override them per frame around their base values.
const ANIM = {
  tracks: [
    { target: { kind: "postfx", key: "bloom.strength" }, ...flicker(34, 0.72, 1.0, 10, 7) },
    { target: { kind: "postfx", key: "godrays.strength" }, ...pulse(200, 0.78, 0.98) },
  ],
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
  const storedKey = await putCartObject(`carts/${OVERLOOK_CART_ID}.tic`, bytes);

  const { error } = await supabase.from("carts").upsert({
    id: OVERLOOK_CART_ID,
    owner_id: profile.id,
    title: "Overlook",
    slug: "overlook",
    description:
      "A cinematic 2.5D art-style canvas on the Pro core: a lone rim-lit figure on a " +
      "rain-slick overlook at dusk, a hazy neon city, wet reflections, and a full post-FX " +
      "finish (bloom, split tone, god rays, grain). In the vein of Replaced and The Last Night.",
    tags: ["cinematic", "pixel-art", "pro", "demo"],
    console_model: "pro",
    price_cents: 0,
    r2_key: storedKey,
    fx: FX,
    anim: ANIM,
    published: true,
  });
  if (error) throw new Error(`seeding carts failed: ${error.message}`);

  console.log(`Seeded OVERLOOK (${bytes.byteLength} bytes) — play it at /play/${OVERLOOK_CART_ID}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
