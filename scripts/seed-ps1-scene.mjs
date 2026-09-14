// Seeds the PS1 TEST SCENE cart — the era-fidelity demo — as a real, playable
// cartridge on the PS1 model: uploads the .tic and upserts a published `carts`
// row carrying the scene's mesh sidecar. Idempotent (fixed id).
//
// Why this exists rather than just publishing from the editor: publishing binds
// a cart to whoever clicked the button. This is a curated catalog entry, owned
// by the demo profile like every other shipped demo, so Browse shows the era
// model to a signed-out visitor.
//
// The cart is not re-typed here. Its code and geometry are imported from
// packages/editor/src/model/ps1Seed.ts — the same starter `/edit/new?model=ps1`
// opens — so the Browse entry and the editor starter can never drift.
//
// Run against a stack's app env. Importing editor TS needs both the transform
// loader AND the resolve hook: ps1Seed.ts imports "./base64" without a file
// extension, which Node's ESM resolver will not find on its own (verified — it
// fails with ERR_MODULE_NOT_FOUND without the --import). Same invocation as
// scripts/seed-mesh-showcase.mjs.
//
//   node --env-file=apps/web/.env.local \
//        --experimental-transform-types \
//        --import "./Unit Tests/registerLightingHooks.mjs" \
//        scripts/seed-ps1-scene.mjs
//
// Swap .env.local for .env.production.local to seed prod.

import { createClient } from "@supabase/supabase-js";
import { putCartObject } from "./lib/seedStorage.mjs";

const load = (rel) => import(new URL(rel, import.meta.url).href);
const { PS1_CODE, PS1_MESH_SIDECAR, PS1_SCENE_TRIANGLES } = await load(
  "../packages/editor/src/model/ps1Seed.ts",
);
const { buildLuaCart } = await load("../packages/engine/examples/sample-cart.mjs");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

const CART_ID = "00000000-0000-4000-8000-000000000041";

// Cart binaries belong in Supabase Storage (publicly served); strip any R2 vars
// so putCartObject never routes the .tic to the object store. The mesh sidecar
// rides inline in the carts.mesh column, as it does for the mesh showcase.
for (const name of ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
  delete process.env[name];
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
      `no demo profile to own the cart: ${profileError?.message ?? "not found"}. Run scripts/seed.mjs first.`,
    );
  }

  // Raw cart bytes: the player injects the cartbox SDK at load (player.ts), so
  // cartbox.meshcam resolves at runtime without baking the SDK into the stored
  // cartridge.
  const bytes = buildLuaCart(PS1_CODE);
  const storedKey = await putCartObject(`carts/${CART_ID}.tic`, bytes);

  const { error } = await supabase.from("carts").upsert({
    id: CART_ID,
    owner_id: profile.id,
    title: "PS1 Test Scene",
    slug: "ps1-test-scene",
    description:
      "The PlayStation-era console model, shown doing the things that make the era " +
      "recognisable. A tiled floor whose painted stripes bend at every cell edge — " +
      "affine texture mapping, the generation's signature. Pillars whose outlines jitter " +
      "as the camera turns, because vertices snap to whole pixels. Crates that vanish " +
      "under the floor from some angles, because there is no depth buffer and whole " +
      "triangles sort back to front. 320x240, 256 colours, one 64x64 texture page.",
    tags: ["3d", "ps1", "era", "demo", "tech"],
    // The row property that selects the 320x240 8bpp core and its era render
    // caps. `carts.console_model` carries no whitelist constraint, so this needs
    // no migration — unlike titles.runtime, which did (see 0025).
    console_model: "ps1",
    price_cents: 0,
    r2_key: storedKey,
    mesh: PS1_MESH_SIDECAR,
    published: true,
  });
  if (error) throw new Error(`seeding carts failed: ${error.message}`);

  console.log(
    `Seeded PS1 TEST SCENE — ${PS1_SCENE_TRIANGLES} tris, sidecar ` +
      `${(PS1_MESH_SIDECAR.length / 1024).toFixed(1)} KB, .tic ${bytes.byteLength} bytes. ` +
      `Play at /play/${CART_ID}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
