// Seeds the "Gotta Catch 'Em All" cart (Classic) into the local stack: uploads
// the .tic to storage and upserts a published carts row owned by the demo
// profile. Idempotent. Run: node --env-file=apps/web/.env.local scripts/seed-game.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const CART_ID = "00000000-0000-4000-8000-000000000011";
const CART_PATH = new URL("../../gotta-catch-em-all/game.tic", import.meta.url);

const supabase = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
const s3 = new S3Client({
  region: "auto",
  endpoint: required("R2_ENDPOINT"),
  credentials: { accessKeyId: required("R2_ACCESS_KEY_ID"), secretAccessKey: required("R2_SECRET_ACCESS_KEY") },
});

async function main() {
  const { data: profile, error: pe } = await supabase.from("profiles").select("id").eq("handle", "demo").single();
  if (pe || !profile) throw new Error(`no demo profile: ${pe?.message ?? "not found"}`);

  const bytes = new Uint8Array(readFileSync(CART_PATH));
  const r2Key = `carts/${CART_ID}.tic`;
  await s3.send(new PutObjectCommand({
    Bucket: required("R2_BUCKET"), Key: r2Key, Body: bytes, ContentType: "application/octet-stream",
  }));

  const { error } = await supabase.from("carts").upsert({
    id: CART_ID,
    owner_id: profile.id,
    title: "Gotta Catch 'Em All",
    slug: "gotta-catch-em-all",
    description: "A monster-catching overworld — explore, find creatures in the tall grass, and catch all three. Art, map and sound made in the Cartbox editor.",
    tags: ["rpg", "classic", "demo"],
    console_model: "classic",
    price_cents: 0,
    r2_key: r2Key,
    published: true,
  });
  if (error) throw new Error(`seeding carts failed: ${error.message}`);
  console.log(`Seeded Gotta Catch 'Em All (${bytes.byteLength} bytes) — /play/${CART_ID} , /edit/${CART_ID}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
