// Imports TIC-80 cartridges into the Cartbox catalog so they appear in the
// console's Browse tab (and the home feed) as free, playable Classic carts —
// the Classic core is a true TIC-80 fork, so carts from tic80.com run as-is.
//
// Accepts, in any mix:
//   - a tic80.com play URL:   https://tic80.com/play?cart=3
//     (scrapes the cart binary, title, and author from the page)
//   - a direct .tic URL:      https://tic80.com/cart/<hash>/game.tic
//   - a local file:           ./downloads/game.tic
//
// Usage:
//   node --env-file=apps/web/.env.local scripts/import-tic.mjs <source...> \
//        [--title "Name"] [--author "Maker"] [--tags tag1,tag2]
//   (--title/--author apply when a source has no scrapeable metadata.)
//
// Please respect each cart's license — import carts you made or that their
// authors shared for redistribution.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

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

/** All imports are published under one archive profile, credited per-cart. */
const ARCHIVE_AUTHOR = {
  email: "arcade@cartbox.dev",
  handle: "tic80_arcade",
  displayName: "TIC-80 Arcade",
};

/** A .tic cart is small; anything huge is not a cart. */
const MAX_CART_BYTES = 2 * 1024 * 1024;

function parseArgs(argv) {
  const sources = [];
  const options = { title: null, author: null, tags: ["tic-80", "import"] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--title") options.title = argv[++i] ?? null;
    else if (arg === "--author") options.author = argv[++i] ?? null;
    else if (arg === "--tags") options.tags = (argv[++i] ?? "").split(",").filter(Boolean);
    else sources.push(arg);
  }
  if (sources.length === 0) {
    throw new Error("No sources given. Pass tic80.com play URLs, .tic URLs, or local .tic files.");
  }
  return { sources, options };
}

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { "User-Agent": "cartbox-import" } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_CART_BYTES) {
    throw new Error(`${url}: implausible cart size ${bytes.length} bytes`);
  }
  return bytes;
}

/** Scrapes a tic80.com play page for the cart binary URL, title, and author. */
async function resolvePlayPage(url) {
  const response = await fetch(url, { headers: { "User-Agent": "cartbox-import" } });
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  const html = await response.text();

  const cartPath = html.match(/cart\/[0-9a-f]+\/[^"']+\.tic/i)?.[0];
  if (!cartPath) throw new Error(`${url}: no cart binary found on the page`);

  const title = html.match(/<title>Play ([^<]+?) \/ TIC-80<\/title>/i)?.[1]?.trim() ?? null;
  const author = html.match(/name="author" content="by ([^"]+)"/i)?.[1]?.trim() ?? null;
  return { cartUrl: new URL(`/${cartPath}`, url).href, title, author };
}

/** Loads one source into { bytes, title, author }. */
async function loadSource(source, options) {
  if (/^https?:\/\//i.test(source)) {
    if (/\/play\b/.test(source)) {
      const { cartUrl, title, author } = await resolvePlayPage(source);
      return {
        bytes: await fetchBytes(cartUrl),
        title: options.title ?? title ?? "Imported cart",
        author: options.author ?? author ?? null,
      };
    }
    const name = basename(new URL(source).pathname).replace(/\.tic$/i, "");
    return {
      bytes: await fetchBytes(source),
      title: options.title ?? name ?? "Imported cart",
      author: options.author ?? null,
    };
  }
  return {
    bytes: new Uint8Array(await readFile(source)),
    title: options.title ?? basename(source).replace(/\.tic$/i, ""),
    author: options.author ?? null,
  };
}

function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "imported-cart"
  );
}

async function ensureArchiveAuthor() {
  const { data: created, error } = await supabase.auth.admin.createUser({
    email: ARCHIVE_AUTHOR.email,
    password: randomUUID(),
    email_confirm: true,
  });
  if (error && !/already/i.test(error.message)) throw error;

  let userId = created?.user?.id;
  if (!userId) {
    const { data: list } = await supabase.auth.admin.listUsers();
    userId = list.users.find((user) => user.email === ARCHIVE_AUTHOR.email)?.id;
  }
  if (!userId) throw new Error("could not resolve the archive author");

  const { error: profileError } = await supabase.from("profiles").upsert({
    id: userId,
    handle: ARCHIVE_AUTHOR.handle,
    display_name: ARCHIVE_AUTHOR.displayName,
    bio: "Curated imports from the TIC-80 community archive.",
  });
  if (profileError) throw new Error(`archive profile failed: ${profileError.message}`);
  return userId;
}

async function importOne(source, options, ownerId) {
  const { bytes, title, author } = await loadSource(source, options);

  const slug = slugify(title);
  // Idempotent per (owner, slug): re-importing updates the same cart row.
  const { data: existing } = await supabase
    .from("carts")
    .select("id")
    .eq("owner_id", ownerId)
    .eq("slug", slug)
    .maybeSingle();
  const cartId = existing?.id ?? randomUUID();
  const r2Key = `carts/${cartId}.tic`;

  await s3.send(
    new PutObjectCommand({
      Bucket: required("R2_BUCKET"),
      Key: r2Key,
      Body: bytes,
      ContentType: "application/octet-stream",
    }),
  );

  const { error } = await supabase.from("carts").upsert({
    id: cartId,
    owner_id: ownerId,
    title,
    slug,
    description: author ? `By ${author}. Imported from the TIC-80 archive.` : "Imported from the TIC-80 archive.",
    tags: options.tags,
    console_model: "classic",
    price_cents: 0,
    r2_key: r2Key,
    published: true,
  });
  if (error) throw new Error(`cart row failed for "${title}": ${error.message}`);

  console.log(`Imported "${title}"${author ? ` by ${author}` : ""} (${bytes.length} bytes) -> /play/${cartId}`);
}

async function main() {
  const { sources, options } = parseArgs(process.argv.slice(2));
  const ownerId = await ensureArchiveAuthor();
  for (const source of sources) {
    await importOne(source, options, ownerId);
  }
  console.log(`Done — ${sources.length} cart(s) now in Browse.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
