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
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "apps", "web", "public");
const dryRun = process.argv.includes("--dry-run");

/** Re-upload objects that are already present and the right size. */
const force = process.argv.includes("--force");

/**
 * Parallel uploads. The payload is ~670MB across ~700 objects, so serial PUTs
 * spend most of their time waiting on round-trips; a handful in flight cuts the
 * wall time several-fold without putting the connection under pressure.
 */
const DEFAULT_CONCURRENCY = 6;
const concurrency =
  Number(process.argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1]) ||
  DEFAULT_CONCURRENCY;

/** Bundle roots served from public/ that mirror next.config's GAME_BUNDLE_ROOTS. */
const BUNDLE_ROOTS = [
  "quake",
  "cube2",
  "scummvm",
  "supertux",
  "dosbox",
  "games",
  "opentyrian",
  "openttd",
  "cavestory",
];

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

export const contentType = (path) =>
  CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

/** Bundle data is stable per build but the path is not versioned, so cache modestly. */
const CACHE_CONTROL = "public, max-age=3600";

/**
 * Bundle roots that must not be cached at the edge.
 *
 * Vercel's CDN keys its cache on the URL and ignores the `Range` request header,
 * and it caches what the *origin* sends — so a cacheable range-capable object
 * poisons its own entry: WebQuake reads pak0.pak's 12-byte header with
 * `Range: bytes=0-11`, that partial is stored for the whole URL, and the next
 * range (the pak directory, ~18MB in) is answered with the same 12 bytes and
 * `content-range: bytes 0-11`. The engine cannot find gfx.wad inside the pak and
 * dies on `W.LoadWadFile: couldn't load gfx.wad`.
 *
 * Setting no-store here rather than in next.config is deliberate: a Next
 * `headers()` rule decorates the response handed to the client, but the edge
 * still stores the upstream object with the upstream Cache-Control, so the
 * poisoning resumes on the very next request. Only the origin can prevent the
 * entry from existing.
 *
 * Scoped to the roots that actually stream by range — no-store costs edge
 * caching, and the whole-file runtimes (Cube 2, SuperTux, DOSBox, ScummVM, Doom)
 * are unaffected by the bug and should stay cacheable.
 */
const RANGE_STREAMED_ROOTS = new Set(["quake"]);

/** Cache-Control for an object, by the bundle root its key falls under. */
export function cacheControlForKey(key) {
  const root = key.split("/")[0];
  return RANGE_STREAMED_ROOTS.has(root) ? "no-store" : CACHE_CONTROL;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`publish-bundles-r2: missing env ${name}`);
  return value;
}

/**
 * Whether an object still needs uploading, given what the bucket already holds.
 *
 * A run over ~670MB can be interrupted — a dropped connection, a cancelled job,
 * a token that expired mid-flight. Re-running then used to re-send every byte
 * from the start. Comparing against the object already in the bucket makes the
 * script resumable: a second run costs one HEAD per file and uploads only the
 * remainder.
 *
 * Size is the comparison because these files are build outputs identified by
 * path — a bundle rebuild that changes a file changes its length in practice,
 * and the alternative (checksumming 670MB locally on every run) costs more than
 * the re-upload it would save. `--force` exists for the case it misses.
 *
 * @param {{size: number}} file
 * @param {{size: number} | null} remote  null when the object is absent
 */
export function shouldUpload(file, remote, { force: forced = false } = {}) {
  if (forced) return true;
  if (!remote) return true;
  return remote.size !== file.size;
}

/**
 * Runs `worker` over `items` with at most `limit` in flight.
 *
 * Workers pull from a shared cursor rather than being handed fixed slices, so
 * one 162MB file cannot leave five idle workers waiting on it.
 */
export async function mapWithConcurrency(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

/** All files under a directory, as { key, absolute, size } with POSIX keys. */
export function listBundle(root) {
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

  const { S3Client, PutObjectCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");
  const bucket = required("R2_BUCKET");
  const client = new S3Client({
    region: "auto",
    endpoint: required("R2_ENDPOINT"),
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    },
    // A little more patience than the default 3: the long tail here is a 162MB
    // PUT, and losing the whole object to one blip is expensive.
    maxAttempts: 5,
  });

  /** The object already in the bucket, or null when it is not there yet. */
  const head = async (key) => {
    try {
      const found = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { size: found.ContentLength };
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") return null;
      throw error;
    }
  };

  let uploaded = 0;
  let skipped = 0;
  let uploadedBytes = 0;
  const failures = [];

  await mapWithConcurrency(files, concurrency, async (f) => {
    try {
      if (!shouldUpload(f, await head(f.key), { force })) {
        skipped += 1;
        return;
      }

      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: f.key,
          Body: createReadStream(f.absolute),
          ContentLength: f.size,
          ContentType: contentType(f.absolute),
          CacheControl: cacheControlForKey(f.key),
        }),
      );

      uploaded += 1;
      uploadedBytes += f.size;
    } catch (error) {
      // Keep going: one bad object should not strand the other 700. They are
      // listed at the end and a re-run retries exactly those.
      failures.push({ key: f.key, message: error.message });
    }

    const seen = uploaded + skipped + failures.length;
    if (seen % 50 === 0 || seen === files.length) {
      console.log(
        `  ${seen}/${files.length}  (${uploaded} uploaded, ${skipped} already present` +
          `${failures.length ? `, ${failures.length} failed` : ""}, ${(uploadedBytes / 1e6).toFixed(0)} MB sent)`,
      );
    }
  });

  console.log(
    `publish-bundles-r2: ${uploaded} uploaded, ${skipped} already present -> r2://${bucket}`,
  );

  if (failures.length) {
    console.error(`publish-bundles-r2: ${failures.length} object(s) failed:`);
    for (const f of failures.slice(0, 20)) console.error(`  ${f.key}: ${f.message}`);
    if (failures.length > 20) console.error(`  … and ${failures.length - 20} more`);
    console.error("Re-run to retry only these — objects already uploaded are skipped.");
    process.exitCode = 1;
  }
}

// Importable for tests; only runs the upload when invoked as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
