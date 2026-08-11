/**
 * Ingestion pipeline for the in-editor asset library.
 *
 *   npx tsx scripts/build-library.mts --local     # write payloads + thumbnails
 *                                                  # + manifest under public/library
 *   npx tsx scripts/build-library.mts --r2         # upload everything to R2 and
 *                                                  # point the manifest at it
 *   npx tsx scripts/build-library.mts --dry-run    # print the plan, touch nothing
 *
 * For each entry in {@link LIBRARY_SOURCES} the pipeline resolves the payload
 * bytes (a staged local file, a CC0 download, or a Blender-MCP mesh export),
 * generates a thumbnail, and then assembles a manifest whose URLs point either at
 * same-origin paths (local mode) or the R2 public base (R2 mode). Assembly runs
 * through the runtime's own validator, so the pipeline can only emit a catalogue
 * the editor will accept.
 *
 * R2 is S3-compatible, so uploads reuse the same @aws-sdk/client-s3 the app and
 * `publish-bundles-r2.mts` already use (R2_* env). The Blender path is a thin
 * adapter over the MCP bridge; when the bridge is offline those entries are
 * skipped with a clear message rather than failing the whole build.
 */

import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LIBRARY_SOURCES, type RegistrySource } from "./library-sources.mts";
import {
  assembleManifest,
  payloadDirForKind,
  type LibrarySource,
} from "../apps/web/src/lib/libraryBuild.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const libraryDir = join(repoRoot, "apps", "web", "public", "library");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const toR2 = args.has("--r2");
const mode = dryRun ? "dry-run" : toR2 ? "r2" : "local";

/** Read a required environment variable or abort with a precise message. */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. R2 upload needs the R2_* environment set.`);
  return value;
}

// --- Thumbnail generation ---------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]!)! & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}
/** Encode a square RGB pixel buffer (row-major, 3 bytes/pixel) as a PNG. */
function encodePng(size: number, rgb: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y += 1) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = rgb(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A stable hue-ish base colour derived from an id, so a swatch is recognisable. */
function baseColorFor(id: string): [number, number, number] {
  const hash = createHash("sha256").update(id).digest();
  // Bias towards mid-tones so the two-tone pattern stays legible.
  return [80 + (hash[0]! % 120), 80 + (hash[1]! % 120), 80 + (hash[2]! % 120)];
}

/**
 * A placeholder thumbnail for a payload that cannot be previewed cheaply (a mesh
 * or voxel). It is a recognisable two-tone swatch — diagonal for meshes, a block
 * grid for voxels — coloured from the id, so cards read as intentional rather
 * than broken until real rendered thumbnails replace them.
 */
function swatchThumbnail(source: RegistrySource): Buffer {
  const size = 96;
  const [r, g, b] = baseColorFor(source.id);
  const light: [number, number, number] = [Math.min(255, r + 45), Math.min(255, g + 45), Math.min(255, b + 45)];
  const dark: [number, number, number] = [r, g, b];
  const isVoxel = source.kind === "voxel";
  return encodePng(size, (x, y) => {
    const on = isVoxel ? (Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0 : Math.floor((x + y) / 10) % 2 === 0;
    return on ? light : dark;
  });
}

// --- Payload + thumbnail resolution -----------------------------------------

/** The Blender MCP bridge is not reachable from a plain script run. */
function fetchViaBlender(origin: { query: string; as: string }): never {
  throw new Error(
    `Blender source "${origin.query}" needs the Blender MCP bridge running (export to ${origin.as}); ` +
      `run it under the bridge or stage the .glb locally.`,
  );
}

interface ResolvedAsset {
  readonly source: LibrarySource;
  /** Payload bytes and their target key, present unless skipped. */
  readonly payload: { readonly bytes: Buffer; readonly file: string };
  readonly thumbnail: { readonly bytes: Buffer; readonly file: string };
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Resolve one registry entry to payload + thumbnail bytes, or null if skipped. */
async function resolve(entry: RegistrySource): Promise<ResolvedAsset | null> {
  let payloadBytes: Buffer;
  let payloadFile: string;
  try {
    if (entry.origin.kind === "local") {
      payloadFile = basename(entry.origin.path);
      payloadBytes = readFileSync(join(libraryDir, entry.origin.path));
    } else if (entry.origin.kind === "http") {
      payloadFile = basename(entry.origin.as);
      payloadBytes = await download(entry.origin.url);
    } else {
      fetchViaBlender(entry.origin);
    }
  } catch (error) {
    console.warn(`  skip ${entry.id}: ${(error as Error).message}`);
    return null;
  }

  // Sprites and tiles are their own thumbnail; meshes and voxels get a swatch.
  const thumbnailFile = `${entry.id}.png`;
  const thumbnailBytes =
    entry.kind === "sprite" || entry.kind === "tile" ? payloadBytes : swatchThumbnail(entry);

  const source: LibrarySource = {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    category: entry.category,
    tags: entry.tags,
    payloadFile,
    thumbnailFile,
    sizeBytes: payloadBytes.length,
    provenance: entry.provenance,
  };
  return { source, payload: { bytes: payloadBytes, file: payloadFile }, thumbnail: { bytes: thumbnailBytes, file: thumbnailFile } };
}

// --- Outputs ----------------------------------------------------------------

function writeLocal(resolved: ResolvedAsset[]): void {
  for (const asset of resolved) {
    const payloadPath = join(libraryDir, payloadDirForKind(asset.source.kind), asset.payload.file);
    mkdirSync(dirname(payloadPath), { recursive: true });
    writeFileSync(payloadPath, asset.payload.bytes);
    const thumbPath = join(libraryDir, "thumbs", asset.thumbnail.file);
    mkdirSync(dirname(thumbPath), { recursive: true });
    writeFileSync(thumbPath, asset.thumbnail.bytes);
  }
  const manifest = assembleManifest(resolved.map((asset) => asset.source), "");
  writeFileSync(join(libraryDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nWrote ${resolved.length} assets + thumbnails and manifest.json under public/library.`);
}

async function uploadToR2(resolved: ResolvedAsset[]): Promise<void> {
  const base = required("R2_PUBLIC_BASE_URL");
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const bucket = required("R2_BUCKET");
  const client = new S3Client({
    region: "auto",
    endpoint: required("R2_ENDPOINT"),
    credentials: { accessKeyId: required("R2_ACCESS_KEY_ID"), secretAccessKey: required("R2_SECRET_ACCESS_KEY") },
    maxAttempts: 5,
  });
  const put = (key: string, body: Buffer, contentType: string) =>
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: "public, max-age=3600",
      }),
    );

  for (const asset of resolved) {
    const payloadKey = `library/${payloadDirForKind(asset.source.kind)}/${asset.payload.file}`;
    await put(payloadKey, asset.payload.bytes, contentTypeFor(asset.payload.file));
    await put(`library/thumbs/${asset.thumbnail.file}`, asset.thumbnail.bytes, "image/png");
    console.log(`  put ${payloadKey}`);
  }
  const manifest = assembleManifest(resolved.map((asset) => asset.source), base);
  await put("library/manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), "application/json");
  console.log(`\nUploaded ${resolved.length} assets + thumbnails and manifest.json to R2 (${base}/library).`);
}

function contentTypeFor(file: string): string {
  if (file.endsWith(".glb")) return "model/gltf-binary";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".vox")) return "application/octet-stream";
  return "application/octet-stream";
}

// --- Entry point ------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`build-library: ${mode} — ${LIBRARY_SOURCES.length} sources`);
  const resolved: ResolvedAsset[] = [];
  for (const entry of LIBRARY_SOURCES) {
    const asset = await resolve(entry);
    if (asset) resolved.push(asset);
  }
  if (resolved.length === 0) {
    console.error("No assets resolved — nothing to build.");
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    for (const asset of resolved) {
      console.log(
        `  ${asset.source.id}  [${asset.source.kind}]  payload ${asset.payload.bytes.length}B  thumb ${asset.thumbnail.bytes.length}B`,
      );
    }
    // Assemble anyway so a malformed source is still caught in a dry run.
    assembleManifest(resolved.map((asset) => asset.source), toR2 ? "https://example.invalid" : "");
    console.log("\n--dry-run: manifest validates; nothing written.");
    return;
  }

  if (toR2) await uploadToR2(resolved);
  else writeLocal(resolved);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
