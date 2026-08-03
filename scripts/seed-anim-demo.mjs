// Seeds the gap-#1 ANIM DEMO cart — a Phase C end-to-end check that the stored
// `anim` sidecar reaches the player through the play route. Uploads the demo .tic
// (authored by Working/cinematic-artstyle/anim-cart-build.mjs, whose FOREGROUND IS
// STATIC) and upserts a published Pro `carts` row carrying scene + anim + fx JSON.
// Because the cart draws nothing that moves on its own, any motion at /play/<id> is
// the animation system running from the DB column. Idempotent (fixed id).
//
// Run with the app env:
//   node --env-file=apps/web/.env.local scripts/seed-anim-demo.mjs   (local)

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { flicker, drift, pulse, sway } from "@cartbox/player";
import { putCartObject } from "./lib/seedStorage.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

const CART_ID = "00000000-0000-4000-8000-000000000031";
const CART_PATH = new URL("../../cinematic-artstyle/anim-preview/anim-cart.tic", import.meta.url);

// Parallax backdrop pointing at the demo cart's own sprite strips (same as the
// verified browser preview): far skyline, mid skyline, neon strip.
const SCENE = {
  layers: [
    { source: { page: 0, tile: 0, tilesW: 16, tilesH: 6 }, depth: 0.9, offsetY: 150 },
    { source: { page: 0, tile: 96, tilesW: 16, tilesH: 7 }, depth: 0.5, offsetY: 210 },
    { source: { page: 0, tile: 208, tilesW: 16, tilesH: 3 }, depth: 0.3, offsetY: 250 },
  ],
  atmosphere: { fog: [90, 110, 165], density: 0.9, desaturate: 0.75, lift: 0.5 },
  camera: { autoScrollX: 0 },
  keyColor: 0,
};

// Ambient motion: neon emissive flicker (scene-layer channel), mid-skyline drift
// (scene-layer channel), a candle-flame clip placement with a y-sway, and a bloom
// breath (post-FX value). Built from the player's own generators so it is byte-for-
// byte the browser-verified spec.
const ANIM = {
  clips: [
    { name: "flame", frames: [
      { page: 0, tile: 240, tilesW: 1, tilesH: 1 },
      { page: 0, tile: 241, tilesW: 1, tilesH: 1 },
    ], durations: [10, 10], mode: "loop" },
  ],
  placements: [{ clip: "flame", x: 366, y: 288, opacity: 1, scale: 2, depth: 0 }],
  tracks: [
    { target: { kind: "sceneLayer", index: 2, channel: "emissive" }, ...flicker(46, 0.25, 1.3, 12, 5) },
    { target: { kind: "sceneLayer", index: 1, channel: "offsetX" }, ...drift(300, 48) },
    { target: { kind: "placement", index: 0, channel: "y" }, ...sway(38, 4, 288) },
    { target: { kind: "postfx", key: "bloom.strength" }, ...pulse(120, 0.28, 0.5) },
  ],
};

// Modest cinematic finish; grain OFF (the only other time-animated FX) so the
// motion that appears is unambiguously the animation system.
const FX = {
  enabled: { grade: true, bloom: true, tonemap: true, vignette: true, splittone: true, grain: false },
  values: {
    "grade.brightness": 1.0, "grade.contrast": 1.14, "grade.saturation": 1.18,
    "bloom.strength": 0.4, "bloom.threshold": 0.72, "bloom.radius": 0.42,
    "tonemap.exposure": 1.05, "vignette.strength": 0.42,
    "splittone.strength": 0.5, "splittone.balance": 0.5,
  },
  colors: { "splittone.shadows": "#24304f", "splittone.highlights": "#ffcf9a" },
};

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

async function main() {
  const { data: profile, error: profileError } = await supabase
    .from("profiles").select("id").eq("handle", "demo").single();
  if (profileError || !profile) {
    throw new Error(`no demo profile to own the cart: ${profileError?.message ?? "not found"}. Run scripts/seed.mjs first.`);
  }

  const bytes = new Uint8Array(readFileSync(CART_PATH));
  const storedKey = await putCartObject(`carts/${CART_ID}.tic`, bytes);

  const { error } = await supabase.from("carts").upsert({
    id: CART_ID,
    owner_id: profile.id,
    title: "Anim Demo",
    slug: "anim-demo",
    description: "Gap #1 Phase C check: a static-foreground cart whose scene backdrop, neon flicker, drifting skyline, candle flame, and breathing bloom are all driven by the stored anim sidecar.",
    tags: ["demo", "pro", "animation"],
    console_model: "pro",
    price_cents: 0,
    r2_key: storedKey,
    fx: FX,
    scene: SCENE,
    anim: ANIM,
    published: true,
  });
  if (error) throw new Error(`seeding carts failed: ${error.message}`);

  console.log(`Seeded ANIM DEMO (${bytes.byteLength} bytes) — play it at /play/${CART_ID}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
