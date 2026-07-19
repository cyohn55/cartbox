/**
 * Fetches the Freedoom IWAD that the Doom title is built against.
 *
 *   node scripts/fetch-freedoom.mjs
 *
 * Freedoom is BSD-3-Clause and redistributable, so shipping it to players is
 * exactly what makes Doom a Tier A title rather than a bring-your-own-assets
 * one. It is fetched rather than committed because a ~29MB binary does not
 * belong in git history, and because pinning the release here keeps the asset
 * version auditable next to the build.
 *
 * The download is verified against a known digest: an asset payload that
 * silently changed would otherwise surface as a corrupt game rather than as a
 * failed build.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetDirectory = join(repoRoot, "games", "doom", "assets");

const RELEASE = {
  version: "0.13.0",
  url: "https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip",
  /** SHA-256 of freedoom1.wad inside the release archive, hashed from the real download. */
  wadSha256: "7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d",
  entry: "freedoom-0.13.0/freedoom1.wad",
  licenceEntry: "freedoom-0.13.0/COPYING.txt",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reads one entry out of a zip archive.
 *
 * Node ships no zip reader, and pulling a dependency in for a single stored
 * entry is not worth it — this walks the central directory and inflates the
 * one file we need with the built-in zlib.
 */
async function extractEntry(archive, entryName) {
  const { inflateRawSync } = await import("node:zlib");

  // End-of-central-directory record, scanned backwards past any comment.
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== 0x06054b50) {
    end--;
  }
  if (end < 0) {
    throw new Error("Not a zip archive: no end-of-central-directory record");
  }

  const entryCount = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);

  for (let index = 0; index < entryCount; index++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Corrupt zip central directory");
    }
    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    if (name === entryName) {
      // The local header repeats the name/extra lengths, and its extra field
      // may differ from the central directory's — so read them from there.
      const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const data = archive.subarray(dataStart, dataStart + compressedSize);
      return compressionMethod === 0 ? Buffer.from(data) : inflateRawSync(data);
    }

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`Zip archive has no entry named ${entryName}`);
}

async function main() {
  mkdirSync(assetDirectory, { recursive: true });
  const wadPath = join(assetDirectory, "freedoom1.wad");

  if (existsSync(wadPath)) {
    const digest = sha256(readFileSync(wadPath));
    console.log(`freedoom1.wad already present (sha256 ${digest})`);
    return;
  }

  console.log(`Fetching Freedoom ${RELEASE.version}…`);
  const response = await fetch(RELEASE.url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());

  const wad = await extractEntry(archive, RELEASE.entry);
  const licence = await extractEntry(archive, RELEASE.licenceEntry);

  const digest = sha256(wad);
  if (digest !== RELEASE.wadSha256) {
    throw new Error(
      `freedoom1.wad digest mismatch.\n  expected ${RELEASE.wadSha256}\n  got      ${digest}\n` +
        "Refusing to write: the pinned release changed, or the download was tampered with.",
    );
  }

  writeFileSync(wadPath, wad);
  // The BSD licence obliges us to carry this text to anyone we redistribute to.
  writeFileSync(join(assetDirectory, "COPYING.txt"), licence);

  console.log(`Wrote freedoom1.wad (${(wad.length / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  sha256 ${sha256(wad)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
