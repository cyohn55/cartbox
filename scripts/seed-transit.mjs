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
import { flicker, drift, pulse } from "@cartbox/player";
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
// whose gaps reveal the far plane. Chroma-keyed under the cart's foreground, which
// scrolls the whole backdrop by publishing cartbox.camera() as the player walks.
// (Kept in sync with Working/cinematic-artstyle/transit2-preview-entry.mjs.)
const SCENE = {
  layers: [
    { source: { page: 0, tile: 0, tilesW: 16, tilesH: 5 }, depth: 0.86, parallax: 0.16, offsetY: 200, wrapX: true },
    { source: { page: 0, tile: 80, tilesW: 16, tilesH: 10 }, depth: 0.40, parallax: 0.42, offsetY: 170, wrapX: true },
  ],
  atmosphere: { fog: [80, 104, 132], density: 0.72, desaturate: 0.34, lift: 0.46 },
  camera: { autoScrollX: 0 }, // scroll is driven by the cart's cartbox.camera()
  keyColor: 0,
};

// Anim tab — host-played ambient life on the backdrop (the foreground motion — the
// walk cycle and scrolling street — is the interactive cart itself): the neon canyon
// buzzes (emissive flicker), the far plane drifts, and the bloom/god-ray glow breathes.
const ANIM = {
  clips: [],
  placements: [],
  tracks: [
    { target: { kind: "sceneLayer", index: 1, channel: "emissive" }, ...flicker(52, 0.5, 1.06, 10, 7) },
    { target: { kind: "sceneLayer", index: 0, channel: "offsetX" }, ...drift(360, 16) },
    { target: { kind: "postfx", key: "bloom.strength" }, ...pulse(150, 0.44, 0.6) },
    { target: { kind: "postfx", key: "godrays.strength" }, ...pulse(200, 0.34, 0.52) },
  ],
};

// Weather tab — rain driven slantwise by wind, a low rolling fog, and a few embers.
const PARTICLES = {
  emitters: [
    { kind: "rain", count: 360, color: [150, 180, 210], opacity: 0.30, size: 1, speed: 11, wind: -2.4, seed: 3 },
    { kind: "fog", count: 16, color: [40, 66, 84], opacity: 0.10, size: 8, speed: 0.2, wind: 0.5, seed: 11 },
    { kind: "embers", count: 20, color: [255, 150, 70], opacity: 0.8, size: 1, speed: 0.6, wind: 0.6, seed: 5 },
  ],
};

// FX tab — the cinematic finish, tuned for the live route's unlit-passthrough frame:
// teal shadows / amber highlights, wide bloom + ACES tonemap so the neon keeps its
// colour, god rays from the moon, streaks, a wet-floor reflection of the city, a
// tilt-shift band, chromatic aberration, vignette and fine grain.
const FX = {
  enabled: {
    grade: true, fog: true, bloom: true, tonemap: true, crt: false, chroma: true,
    vignette: true, posterize: false, dither: false, halftone: false, godrays: true,
    streaks: true, splittone: true, reflection: true, tiltshift: true, kaleidoscope: false, grain: true,
  },
  values: {
    "grade.brightness": 1.02, "grade.contrast": 1.18, "grade.saturation": 1.2,
    "fog.density": 0.12, "fog.horizon": 0.52,
    "bloom.strength": 0.6, "bloom.threshold": 0.62, "bloom.radius": 0.78,
    "tonemap.exposure": 1.14,
    "chroma.amount": 0.6,
    "vignette.strength": 0.5,
    "godrays.strength": 0.38, "godrays.density": 0.5, "godrays.decay": 0.95, "godrays.x": 0.5, "godrays.y": 0.22,
    "streaks.strength": 0.5, "streaks.length": 0.42,
    "splittone.strength": 0.64, "splittone.balance": 0.46,
    "reflection.strength": 0.34, "reflection.horizon": 0.69, "reflection.falloff": 0.6, "reflection.wobble": 0.45,
    "tiltshift.strength": 0.5, "tiltshift.focus": 0.7, "tiltshift.range": 0.16,
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
      "A playable, cinematic REPLACED-style side-scroller on the Pro core: WALK a lone " +
      "augmented figure (arrow keys / d-pad) through an endless rain-soaked neon street " +
      "canyon at night. The retro-future city scrolls in parallax behind you, streetlamps " +
      "and neon signs pass by, and the whole scene rides a full post-FX finish (bloom, " +
      "tonemap, god rays, wet-floor reflection, tilt-shift).",
    tags: ["cinematic", "pixel-art", "pro", "playable", "demo"],
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
