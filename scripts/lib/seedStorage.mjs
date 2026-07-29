/**
 * Where a seed script puts cartridge binaries.
 *
 * Seeds normally upload to the same object store the app serves from (R2 in a
 * deployment, MinIO locally), and record a bucket-relative key. But R2 secrets
 * are frequently not to hand for a deployment — a hosting provider that stores
 * them write-only will happily run the site and never show you the values again
 * — and that is not a good enough reason to leave a deployment with no content.
 *
 * So the backend is chosen from whatever credentials are present:
 *
 *   R2_* set        -> upload to the object store, return a bucket-relative key
 *   otherwise       -> upload to the project's own Supabase Storage, return the
 *                      absolute public URL of the object
 *
 * Both are valid values for a `r2_key` column: `publicUrl()` resolves a relative
 * key against the CDN base and passes an absolute URL through untouched.
 *
 * The choice is by credentials rather than by a flag on purpose — a seed run
 * against a stack that has an object store should always use it, and no caller
 * has to know which case it is in.
 */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const R2_VARS = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];

/** Supabase Storage bucket used when there is no object store configured. */
const FALLBACK_BUCKET = "cartbox-carts";

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function hasR2() {
  return R2_VARS.every((name) => Boolean(process.env[name]));
}

let cachedS3;
function s3() {
  cachedS3 ??= new S3Client({
    region: "auto",
    endpoint: env("R2_ENDPOINT"),
    credentials: {
      accessKeyId: env("R2_ACCESS_KEY_ID"),
      secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
    },
  });
  return cachedS3;
}

/** Creates the fallback bucket if absent. Public: cart binaries are fetched by the browser. */
async function ensureSupabaseBucket() {
  const base = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  const existing = await fetch(`${base}/storage/v1/bucket/${FALLBACK_BUCKET}`, { headers });
  if (existing.ok) return;

  const created = await fetch(`${base}/storage/v1/bucket`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: FALLBACK_BUCKET, name: FALLBACK_BUCKET, public: true }),
  });
  if (!created.ok) {
    throw new Error(`could not create storage bucket: ${created.status} ${await created.text()}`);
  }
}

/**
 * Stores a cartridge binary and returns the value to write to `r2_key`.
 *
 * @param {string} key Object key, e.g. `carts/<uuid>.tic`.
 * @param {Uint8Array} body Raw bytes.
 * @param {string} [contentType]
 * @returns {Promise<string>} A bucket-relative key (R2) or an absolute URL (Supabase Storage).
 */
export async function putCartObject(key, body, contentType = "application/octet-stream") {
  if (hasR2()) {
    await s3().send(
      new PutObjectCommand({
        Bucket: env("R2_BUCKET"),
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return key;
  }

  await ensureSupabaseBucket();
  const base = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${base}/storage/v1/object/${FALLBACK_BUCKET}/${key}`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": contentType,
      // Seeds are re-run routinely; without this the second run 409s.
      "x-upsert": "true",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`upload failed: ${response.status} ${await response.text()}`);
  }
  return `${base}/storage/v1/object/public/${FALLBACK_BUCKET}/${key}`;
}

/** Names the backend in use, for a seed script's log line. */
export function storageBackend() {
  return hasR2() ? `R2 (${process.env.R2_BUCKET})` : `Supabase Storage (${FALLBACK_BUCKET})`;
}
