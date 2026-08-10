// Seeds the OCTOPATH — CARTBOX HD-2D cart: a live demo of the HD-2D world
// runtime (see [[hd2d-world-runtime]]). The world is a true 3D height-mapped
// tile terrain; the characters are 2D sprites (billboards) standing in it,
// sharing ONE depth buffer so raised terrain occludes a character behind it and
// the character draws over terrain in front. The cart drives the camera with
// cartbox.worldcam and places its two characters with cartbox.billboard.
//
// The cart binary (.tic, with the hand-painted grass tile + hero sprite + code)
// and its world sidecar are committed fixtures under scripts/fixtures/, authored
// through the editor itself — so this seed reproduces the exact demo without a
// running local stack.
//
// Run against a stack's app env:
//   node --env-file=apps/web/.env.local scripts/seed-hd2d.mjs
// Swap .env.local for .env.production.local to seed prod.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { putCartObject } from "./lib/seedStorage.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

const CART_ID = "00000000-0000-4000-8000-000000000041";
const fixture = (rel) => new URL(`./fixtures/${rel}`, import.meta.url);

// The cart bytes (sprites + code) and the world sidecar, authored in the editor.
const bytes = readFileSync(fixture("hd2d-octopath.tic"));
const WORLD_SIDECAR = readFileSync(fixture("hd2d-octopath.world.json"), "utf8").trim();

// Cart binaries belong in Supabase Storage (publicly served); strip any R2 vars
// so putCartObject never routes the .tic to the object store, whose prod public
// base URL is a broken localhost value (see [[seeding-a-deployment]]).
for (const name of ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[name];

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
    throw new Error(`no demo profile to own the cart: ${profileError?.message ?? "not found"}. Run scripts/seed.mjs first.`);
  }

  const storedKey = await putCartObject(`carts/${CART_ID}.tic`, bytes);

  const { error } = await supabase.from("carts").upsert({
    id: CART_ID,
    owner_id: profile.id,
    title: "Octopath — Cartbox HD-2D",
    slug: "octopath-cartbox-hd-2d",
    description:
      "A true HD-2D vertical slice built entirely in the Cartbox editor. The world is real 3D — a " +
      "height-mapped tile terrain rendered by the runtime — and the characters are 2D sprites " +
      "(billboards) standing in it, sharing ONE depth buffer so raised terrain occludes a hero " +
      "behind it and he draws over terrain in front. Authored with the World tab; the cart only " +
      "drives cartbox.worldcam and cartbox.billboard. Arrows to move.",
    tags: ["hd-2d", "octopath", "isometric", "3d-world", "demo"],
    console_model: "classic",
    price_cents: 0,
    r2_key: storedKey,
    world: WORLD_SIDECAR,
    published: true,
  });
  if (error) throw new Error(`seeding carts failed: ${error.message}`);

  console.log(
    `Seeded OCTOPATH — CARTBOX HD-2D — .tic ${bytes.byteLength} bytes, world sidecar ` +
      `${(WORLD_SIDECAR.length / 1024).toFixed(1)} KB. Play at /play/${CART_ID}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
