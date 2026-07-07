// Seeds a demo user, a published cartridge (with the cartbox SDK), and an
// achievement — so a fresh local stack has something to click through.
// Run via bootstrap-local.sh, which passes env through --env-file.

import { createClient } from "@supabase/supabase-js";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Resolve sibling packages against this module's URL directly. Going through
// URL.pathname would percent-encode spaces in the repo path, which a second
// pathToFileURL pass would then double-encode (%20 -> %2520) and fail to find.
const { buildLuaCart } = await import(
  new URL("../packages/engine/examples/sample-cart.mjs", import.meta.url).href
);
const { injectSdk, hashEventId } = await import(
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

// Stable ids for the demo carts so the seed is idempotent across re-runs.
const DEMO_CART_ID = "00000000-0000-4000-8000-000000000001";
const LIT_CART_ID = "00000000-0000-4000-8000-000000000002";

// A playable demo: hold right to raise the score; unlock "first_blood" at 30.
const cartSource = [
  "s=0",
  "function TIC()",
  " cls(1)",
  " if btn(3) then s=s+1 end",
  " for i=0,40 do circ(120,68,(40-i+s)%44,i%15) end",
  ' print("hold right",70,120,15)',
  " cartbox.score(s)",
  ' if s>=30 then cartbox.unlock("first_blood") end',
  "end",
].join("\n");

// A lit demo: a dark chamber the player carries a warm lantern through. It emits
// one light each frame via cartbox.light(); the player's auto-detect lighting
// relights the frame around it. Move with the arrow keys.
const litCartSource = [
  "x=120 y=68",
  "function TIC()",
  " if btn(2) then x=x-2 end",
  " if btn(3) then x=x+2 end",
  " if btn(0) then y=y-2 end",
  " if btn(1) then y=y+2 end",
  " if x<8 then x=8 end",
  " if x>232 then x=232 end",
  " if y<12 then y=12 end",
  " if y>128 then y=128 end",
  " cls(0)",
  " for j=1,15 do for i=1,29 do pix(i*8,j*8,3) end end",
  " rect(0,0,240,8,2)",
  " rect(0,128,240,8,2)",
  " circ(x,y,4,14)",
  " circ(x,y,2,15)",
  ' print("LANTERN - arrows to move",54,2,13)',
  " cartbox.clearlights()",
  " cartbox.light(x,y,72,255,190,110,12,1.4)",
  "end",
].join("\n");

async function main() {
  // Demo user + profile.
  const email = "demo@cartbox.dev";
  const { data: created, error: userError } = await supabase.auth.admin.createUser({
    email,
    password: "demo1234",
    email_confirm: true,
  });
  if (userError && !/already/i.test(userError.message)) throw userError;

  let userId = created?.user?.id;
  if (!userId) {
    const { data: list } = await supabase.auth.admin.listUsers();
    userId = list.users.find((u) => u.email === email)?.id;
  }
  if (!userId) throw new Error("could not resolve demo user id");

  // Fail loudly on write errors. A silent upsert can look like success while the
  // row never lands (e.g. a missing role grant returns an error, not an
  // exception), leaving the app to 404 on data that was "seeded".
  const insert = async (table, values, options) => {
    const { error } = await supabase.from(table).upsert(values, options);
    if (error) throw new Error(`seeding ${table} failed: ${error.message}`);
  };

  await insert("profiles", { id: userId, handle: "demo", display_name: "Demo" });

  // Published cart (with the SDK injected) uploaded to R2. The id is fixed so
  // re-running the seed updates the same row instead of colliding on the
  // (owner_id, slug) unique constraint — the seed must be idempotent.
  const cartId = DEMO_CART_ID;
  const r2Key = `carts/${cartId}.tic`;
  const cartBytes = injectSdk(buildLuaCart(cartSource));
  await s3.send(
    new PutObjectCommand({
      Bucket: required("R2_BUCKET"),
      Key: r2Key,
      Body: cartBytes,
      ContentType: "application/octet-stream",
    }),
  );
  await insert("carts", {
    id: cartId,
    owner_id: userId,
    title: "Ring Runner (demo)",
    slug: "ring-runner-demo",
    console_model: "classic",
    price_cents: 0,
    r2_key: r2Key,
    published: true,
  });

  // One achievement to earn.
  await insert(
    "achievements",
    {
      cart_id: cartId,
      key: "first_blood",
      hash: hashEventId("first_blood"),
      title: "First Blood",
      description: "Reach a score of 30.",
      points: 10,
    },
    { onConflict: "cart_id,key" },
  );

  // Lit demo cart: same pattern as above (SDK injected, uploaded to R2, row
  // upserted by a fixed id so re-seeding is idempotent).
  const litR2Key = `carts/${LIT_CART_ID}.tic`;
  await s3.send(
    new PutObjectCommand({
      Bucket: required("R2_BUCKET"),
      Key: litR2Key,
      Body: injectSdk(buildLuaCart(litCartSource)),
      ContentType: "application/octet-stream",
    }),
  );
  await insert("carts", {
    id: LIT_CART_ID,
    owner_id: userId,
    title: "Lantern (lit demo)",
    slug: "lantern-lit-demo",
    console_model: "classic",
    price_cents: 0,
    r2_key: litR2Key,
    published: true,
  });

  console.log(`Seeded cart ${cartId} — play it at /play/${cartId}`);
  console.log(`Seeded lit cart ${LIT_CART_ID} — play it at /play/${LIT_CART_ID}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
