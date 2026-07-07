/**
 * R2 object access for the worker: download a cartridge, upload its thumbnail.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { requiredEnv } from "./config.js";

let cachedClient: S3Client | undefined;

function client(): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: requiredEnv("R2_ENDPOINT"),
      credentials: {
        accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
        secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
      },
    });
  }
  return cachedClient;
}

/** Downloads an object's bytes by key. */
export async function getObject(key: string): Promise<Uint8Array> {
  const response = await client().send(
    new GetObjectCommand({ Bucket: requiredEnv("R2_BUCKET"), Key: key }),
  );
  if (!response.Body) {
    throw new Error(`Object ${key} has no body`);
  }
  return response.Body.transformToByteArray();
}

/** Uploads bytes under a key with the given content type. */
export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: requiredEnv("R2_BUCKET"),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}
