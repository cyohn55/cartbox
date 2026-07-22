/**
 * Uploads the built emulated-game bundles to Cloudflare R2.
 *
 *   node scripts/publish-bundles-r2.mjs           # upload (needs R2_* env)
 *   node scripts/publish-bundles-r2.mjs --dry-run # list what would upload
 *
 * Step 2 of the hosting migration (see apps/web/DEPLOY-VERCEL.md): the engine
 * builds (the fetch and build scripts) produce large bundles under
 * apps/web/public that blow past GitHub Pages' limits and can't be rebuilt in
 * Vercel's env (Emscripten).
 * The CI builds them, this uploads them to R2, and next.config.mjs rewrites the
 * same-origin bundle paths to R2 at request time (GAME_CDN_URL). R2 keeps the
 * storage; the browser still sees same-origin URLs so the iframe input bridges
 * keep working.
 *
 * R2 is S3-compatible, so this uses the same @aws-sdk/client-s3 the app already
 * depends on (storage.ts). Objects keep their bundle-relative key (e.g.
 * `cube2/bb.wasm`), matching the rewrite destinations.
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "apps", "web", "public");
const dryRun = process.argv.includes("--dry-run");

/** Bundle roots served from public/ that mirror next.config's GAME_BUNDLE_ROOTS. */
const BUNDLE_ROOTS = ["quake", "cube2", "scummvm", "supertux", "dosbox", "games"];

/** Content types the bundles use; default to octet-stream for opaque data. */
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
  ".data": "application/octet-stream",
  ".pak": "application/octet-stream",
  ".wad": "application/octet-stream",
  ".zip": "application/zip",
};

const contentType = (path) => CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

/** Bundle data is stable per build but the path is not versioned, so cache modestly. */
const CACHE_CONTROL = "public, max-age=3600";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`publish-bundles-r2: missing env ${name}`);
  return value;
}

/** All files under a directory, as { key, absolute, size } with POSIX keys. */
function listBundle(root) {
  const base = join(publicDir, root);
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.push({ key: relative(publicDir, abs).split("\\").join("/"), absolute: abs, size: statSync(abs).size });
    }
  };
  walk(base);
  return out;
}

async function main() {
  const files = BUNDLE_ROOTS.flatMap(listBundle);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const present = BUNDLE_ROOTS.filter((r) => existsSync(join(publicDir, r)));
  console.log(`publish-bundles-r2: ${files.length} files, ${(totalBytes / 1e6).toFixed(1)} MB across [${present.join(", ") || "none"}]`);

  if (files.length === 0) {
    console.log("publish-bundles-r2: nothing to upload — run the fetch-*/build-* scripts first.");
    return;
  }

  if (dryRun) {
    for (const f of files.slice(0, 12)) console.log(`  would put  ${f.key}  (${contentType(f.absolute)}, ${(f.size / 1e3).toFixed(0)} KB)`);
    if (files.length > 12) console.log(`  … and ${files.length - 12} more`);
    console.log("publish-bundles-r2: --dry-run, nothing uploaded.");
    return;
  }

  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const bucket = required("R2_BUCKET");
  const client = new S3Client({
    region: "auto",
    endpoint: required("R2_ENDPOINT"),
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    },
  });

  let done = 0;
  for (const f of files) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: f.key,
        Body: createReadStream(f.absolute),
        ContentLength: f.size,
        ContentType: contentType(f.absolute),
        CacheControl: CACHE_CONTROL,
      }),
    );
    done += 1;
    if (done % 50 === 0 || done === files.length) console.log(`  uploaded ${done}/${files.length}`);
  }
  console.log(`publish-bundles-r2: uploaded ${done} objects to r2://${bucket}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
