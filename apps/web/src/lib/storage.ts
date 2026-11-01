/**
 * Object storage (Cloudflare R2, S3-compatible). Stores cartridge binaries and
 * rendered thumbnails. Server-only — uses secret credentials.
 */

import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

let cachedClient: S3Client | undefined;

function client(): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: required("R2_ENDPOINT"),
      credentials: {
        accessKeyId: required("R2_ACCESS_KEY_ID"),
        secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  return cachedClient;
}

/**
 * Uploads bytes to R2 under the given key.
 *
 * @param key Object key (e.g. `carts/<uuid>.tic`).
 * @param body Raw bytes to store.
 * @param contentType MIME type recorded on the object.
 */
export async function putObject(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: required("R2_BUCKET"),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/**
 * Reads an object's bytes, or null when it is not there.
 *
 * A missing key is null rather than a throw: callers here are resolving content
 * a cart references, and a reference that has gone away has to degrade to
 * "missing" rather than take down the read that found it.
 */
export async function getObject(key: string): Promise<Uint8Array | null> {
  try {
    const result = await client().send(
      new GetObjectCommand({ Bucket: required("R2_BUCKET"), Key: key }),
    );
    const body = result.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) return null;
    return await body.transformToByteArray();
  } catch {
    return null;
  }
}

/**
 * Deletes an object by key. A missing key is not an error (S3/R2 delete is
 * idempotent), so callers can use this to clean up an object that may or may not
 * exist without checking first.
 *
 * @param key Object key to remove.
 */
export async function deleteObject(key: string): Promise<void> {
  await client().send(
    new DeleteObjectCommand({
      Bucket: required("R2_BUCKET"),
      Key: key,
    }),
  );
}

/**
 * Builds the public CDN URL for an object key.
 *
 * A key that is already an absolute URL is returned unchanged. Objects are
 * normally bucket-relative keys resolved against the R2 CDN, but some content
 * legitimately lives elsewhere — assets mirrored from another store, or content
 * seeded into a deployment whose R2 credentials are not to hand — and it should
 * be addressable without a schema change or a parallel column. Concatenating in
 * that case yields a mangled `https://cdn/https://elsewhere/...`, so the check
 * is what makes the mixed case work at all rather than an optimisation.
 */
export function publicUrl(key: string): string {
  if (/^https?:\/\//i.test(key)) {
    return key;
  }
  return `${required("R2_PUBLIC_BASE_URL")}/${key}`;
}

/**
 * A presigned PUT for `key` (AAA_FIDELITY_ROADMAP.md F9e): a browser sends the
 * bytes straight to R2, past the API's body limit. The URL is good for one
 * object of exactly `bytes` bytes of `contentType` whose SHA-256 is
 * `checksumBase64`: storage itself refuses bytes that don't match, so the key
 * (the content hash) can't be filled with anything else.
 */
export async function presignPut(
  key: string,
  contentType: string,
  bytes: number,
  checksumBase64: string,
  expiresSeconds = 600,
): Promise<{ url: string; headers: Record<string, string> }> {
  const command = new PutObjectCommand({
    Bucket: required("R2_BUCKET"),
    Key: key,
    ContentType: contentType,
    ContentLength: bytes,
    ChecksumSHA256: checksumBase64,
  });
  const url = await getSignedUrl(client(), command, {
    expiresIn: expiresSeconds,
    // The checksum and type travel as headers the signature covers.
    signableHeaders: new Set(["content-type", "x-amz-checksum-sha256"]),
  });
  return { url, headers: { "Content-Type": contentType, "x-amz-checksum-sha256": checksumBase64 } };
}

/** An object's stored size, or null when it is not there. */
export async function headObject(key: string): Promise<{ bytes: number } | null> {
  try {
    const result = await client().send(new HeadObjectCommand({ Bucket: required("R2_BUCKET"), Key: key }));
    return { bytes: result.ContentLength ?? 0 };
  } catch {
    return null;
  }
}
