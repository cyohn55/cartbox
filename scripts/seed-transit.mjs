// Seeds the TRANSIT cart — a REPLACED-style rain-soaked neon street canyon at
// night — as a real, playable Pro cartridge. It exercises every editor tab: the
// sprite art (Assets), the wet-street layout (Map), a two-layer parallax city with
// aerial haze (Scene), host-played ambient motion (Anim), rain/fog/embers
// (Weather), and the full cinematic post-FX stack (FX). Uploads the .tic and
// upserts a published `carts` row with its scene/anim/particles/fx sidecars.
// Idempotent (fixed id). Mirrors scripts/seed-overlook.mjs.
//
// NOTE — light-less by design: the live play route runs `lighting.autoDetect`, and
// a cart that emits no lights is drawn UNLIT (its art passes through untouched), so
// the hazed parallax city keeps its brightness instead of being relit to a dark
// ambient floor. The cinematic look therefore rides entirely on the post-FX stack
// (the OVERLOOK model). The lamp reads as a glow because its albedo is a hot amber
// the bloom pyramid picks up.
//
// Run with the app env (prod has no R2_* vars, so the .tic lands in Supabase
// Storage as an absolute public URL — the correct home for cart binaries):
//   node --env-file=apps/web/.env.production.local scripts/seed-transit.mjs
// Defensive: strip any R2_* that leak from the shell so storage never picks R2.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { flicker, drift, pulse, sway } from "@cartbox/player";
import { putCartObject } from "./lib/seedStorage.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

const TRANSIT_CART_ID = "00000000-0000-4000-8000-000000000032";
const CART_PATH = new URL("../packages/player/examples/transit.tic", import.meta.url);

// Scene tab — two tall parallax layers pointing at the cart's own sprite strips:
// a far distant plane that hazes into the sky glow, and a near dark neon canyon
// whose gaps reveal the far plane. Chroma-keyed under the cart's foreground.
const SCENE = {
  layers: [
    { source: { page: 0, tile: 0, tilesW: 16, tilesH: 6 }, depth: 0.88, parallax: 0.16, offsetY: 150, wrapX: true },
    { source: { page: 0, tile: 96, tilesW: 16, tilesH: 7 }, depth: 0.34, parallax: 0.42, offsetY: 174, wrapX: true },
  ],
  atmosphere: { fog: [78, 100, 124], density: 0.74, desaturate: 0.35, lift: 0.46 },
  camera: { autoScrollX: 0 },
  keyColor: 0,
};

// Anim tab — host-played ambient motion: the neon canyon buzzes (emissive flicker),
// the far plane drifts, a steam plume rises off a grate, and the bloom/god-ray glow
// breathes. Built from the player's own generators so it matches Anim-tab authoring.
const ANIM = {
  clips: [
    { name: "steam", frames: [
      { page: 0, tile: 235, tilesW: 1, tilesH: 1 },
      { page: 0, tile: 236, tilesW: 1, tilesH: 1 },
    ], durations: [16, 16], mode: "loop" },
  ],
  placements: [
    { clip: "steam", x: 250, y: 250, opacity: 0.7, scale: 3, depth: 0 },
  ],
  tracks: [
    { target: { kind: "sceneLayer", index: 1, channel: "emissive" }, ...flicker(52, 0.5, 1.05, 10, 7) },
    { target: { kind: "sceneLayer", index: 0, channel: "offsetX" }, ...drift(360, 20) },
    { target: { kind: "placement", index: 0, channel: "y" }, ...sway(48, 10, 244) },
    { target: { kind: "placement", index: 0, channel: "opacity" }, ...pulse(48, 0.35, 0.8) },
    { target: { kind: "postfx", key: "bloom.strength" }, ...pulse(150, 0.42, 0.6) },
    { target: { kind: "postfx", key: "godrays.strength" }, ...pulse(200, 0.35, 0.55) },
  ],
};

// Weather tab — rain driven slantwise by wind, a low rolling fog, and a few embers.
const PARTICLES = {
  emitters: [
    { kind: "rain", count: 340, color: [150, 180, 210], opacity: 0.30, size: 1, speed: 10, wind: -2.2, seed: 3 },
    { kind: "fog", count: 16, color: [40, 66, 84], opacity: 0.10, size: 8, speed: 0.2, wind: 0.5, seed: 11 },
    { kind: "embers", count: 22, color: [255, 150, 70], opacity: 0.8, size: 1, speed: 0.6, wind: 0.6, seed: 5 },
  ],
};

// FX tab — the cinematic finish, tuned for the live route's unlit-passthrough frame:
// teal shadows / amber highlights, wide bloom + ACES tonemap so the neon keeps its
// colour, god rays + streaks off the lamp, a wet-floor reflection of the city, a
// tilt-shift band on the figure, chromatic aberration, vignette and fine grain.
const FX = {
  enabled: {
    grade: true, fog: true, bloom: true, tonemap: true, crt: false, chroma: true,
    vignette: true, posterize: false, dither: false, halftone: false, godrays: true,
    streaks: true, splittone: true, reflection: true, tiltshift: true, kaleidoscope: false, grain: true,
  },
  values: {
    "grade.brightness": 1.0, "grade.contrast": 1.2, "grade.saturation": 1.18,
    "fog.density": 0.14, "fog.horizon": 0.5,
    "bloom.strength": 0.62, "bloom.threshold": 0.62, "bloom.radius": 0.76,
    "tonemap.exposure": 1.12,
    "chroma.amount": 0.7,
    "vignette.strength": 0.5,
    "godrays.strength": 0.4, "godrays.density": 0.5, "godrays.decay": 0.95, "godrays.x": 0.38, "godrays.y": 0.56,
    "streaks.strength": 0.5, "streaks.length": 0.4,
    "splittone.strength": 0.66, "splittone.balance": 0.46,
    "reflection.strength": 0.32, "reflection.horizon": 0.69, "reflection.falloff": 0.6, "reflection.wobble": 0.45,
    "tiltshift.strength": 0.6, "tiltshift.focus": 0.64, "tiltshift.range": 0.12,
    "grain.amount": 0.06, "grain.size": 1,
  },
  colors: {
    "fog.tint": "#1a2c3a",
    "splittone.shadows": "#1e3448",
    "splittone.highlights": "#ffcf94",
  },
};

for (const name of ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
  delete process.env[name]; // cart binaries belong in Supabase Storage, not R2
}

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
  const storedKey = await putCartObject(`carts/${TRANSIT_CART_ID}.tic`, bytes);

  const { error } = await supabase.from("carts").upsert({
    id: TRANSIT_CART_ID,
    owner_id: profile.id,
    title: "Transit",
    slug: "transit",
    description:
      "A cinematic REPLACED-style scene on the Pro core: a lone figure on a rain-soaked " +
      "neon street canyon at night, the retro-future city receding into teal haze above a " +
      "mirror-slick road. Uses every editor tab — parallax scene, ambient animation, weather, " +
      "and a full post-FX finish (bloom, tonemap, god rays, wet-floor reflection, tilt-shift).",
    tags: ["cinematic", "pixel-art", "pro", "demo"],
    console_model: "pro",
    price_cents: 0,
    r2_key: storedKey,
    scene: SCENE,
    anim: ANIM,
    particles: PARTICLES,
    fx: FX,
    published: true,
  });
  if (error) throw new Error(`seeding carts failed: ${error.message}`);

  console.log(`Seeded TRANSIT (${bytes.byteLength} bytes) — play it at /play/${TRANSIT_CART_ID}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
