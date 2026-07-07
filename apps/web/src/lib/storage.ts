/**
 * Object storage (Cloudflare R2, S3-compatible). Stores cartridge binaries and
 * rendered thumbnails. Server-only — uses secret credentials.
 */

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

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

/** Builds the public CDN URL for an object key. */
export function publicUrl(key: string): string {
  return `${required("R2_PUBLIC_BASE_URL")}/${key}`;
}
