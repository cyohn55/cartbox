// Seeds a playable cartridge on the 360x640 portrait model.
//
// The cart draws to the full portrait frame — a column of rings down the long
// axis and text near the bottom — so a run of it proves the tall framebuffer is
// really being produced and blitted, rather than a landscape frame letterboxed
// into a portrait box. Idempotent: fixed id, upserted.
//
//   node --env-file=apps/web/.env.local scripts/seed-portrait.mjs

import { createClient } from "@supabase/supabase-js";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Resolve sibling packages against this module's URL directly; going through
// URL.pathname would percent-encode the spaces in the repo path.
const { buildLuaCart } = await import(
  new URL("../packages/engine/examples/sample-cart.mjs", import.meta.url).href
);
const { injectSdk } = await import(
  new URL("../packages/player/dist/index.js", import.meta.url).href
);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

const s3 = new S3Client({
  region: "auto",
  endpoint: required("R2_ENDPOINT"),
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
});

const PORTRAIT_CART_ID = "00000000-0000-4000-8000-000000000013";

// Coordinates are deliberately spread down the full 640 lines: a cart that only
// drew in the top 360 would look identical whether or not the tall frame works.
//
// The clear colour is deliberately NOT black. An overscan buffer too short for
// the screen leaves the rows past its end untouched — which reads as black — so
// clearing to black would make a broken frame indistinguishable from a working
// one in a screenshot.
const cartSource = [
  "t=0",
  "function TIC()",
  " cls(8)",
  " t=t+1",
  " for i=0,7 do",
  "  local y=40+i*80",
  "  circ(180,y,18+((t+i*8)%20),(i+2)%15+1)",
  " end",
  ' print("PORTRAIT",128,16,12)',
  ' print("360 x 640",132,300,11)',
  ' print("BOTTOM EDGE",120,616,14)',
  "end",
].join("\n");

const { data: profile } = await supabase.from("profiles").select("id").eq("handle", "demo").maybeSingle();
if (!profile) {
  console.error("No 'demo' profile found — run scripts/seed.mjs first.");
  process.exit(1);
}

const r2Key = `carts/${PORTRAIT_CART_ID}.tic`;
const cartBytes = injectSdk(buildLuaCart(cartSource));

await s3.send(
  new PutObjectCommand({
    Bucket: required("R2_BUCKET"),
    Key: r2Key,
    Body: cartBytes,
    ContentType: "application/octet-stream",
  }),
);

const { error } = await supabase.from("carts").upsert({
  id: PORTRAIT_CART_ID,
  owner_id: profile.id,
  title: "Tall Order (portrait demo)",
  slug: "tall-order-portrait-demo",
  console_model: "portrait",
  price_cents: 0,
  r2_key: r2Key,
  published: true,
});

if (error) {
  console.error(`Seeding the portrait cart failed: ${error.message}`);
  process.exit(1);
}

console.log(
  `Seeded portrait cart ${PORTRAIT_CART_ID} (${cartBytes.length} bytes) — play it at /play/${PORTRAIT_CART_ID}`,
);
