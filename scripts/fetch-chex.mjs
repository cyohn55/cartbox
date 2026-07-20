/**
 * Fetches the Chex Quest IWAD that the Chex Quest title is built against.
 *
 *   node scripts/fetch-chex.mjs
 *
 * Chex Quest (Digital Café, 1996) is a total conversion of Ultimate Doom that
 * shipped free in cereal boxes as a promotion. Its data is a standalone Doom
 * IWAD (chex.wad), so it plays on the same vendored doomgeneric engine as the
 * Doom title — the build just preloads this WAD instead of Freedoom's (see
 * build-doom.mjs). Chex Quest 3's chex3.wad is *not* used: it needs ZDoom
 * features the vanilla engine lacks, whereas the original 1996 chex.wad is
 * vanilla-compatible.
 *
 * Redistribution basis: unlike Freedoom (BSD-3-Clause) this is freeware by the
 * rightsholder's long-standing custom rather than an explicit licence — it was
 * given away for free and its creators have publicly blessed free distribution.
 * It is therefore catalogued as proprietary-freeware, the same bucket as the
 * ScummVM titles, not as a Tier A open-source game.
 *
 * The download is verified against a known digest so a changed or tampered
 * asset fails the build rather than surfacing as a corrupt game.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetDirectory = join(repoRoot, "games", "chex", "assets");

const RELEASE = {
  // The Internet Archive's MS-DOS Chex Quest item; the DOS distribution carries
  // the original vanilla-compatible IWAD.
  url: "https://archive.org/download/msdos_Chex_Quest_1996/Chex_Quest_1996.zip",
  entry: "ChexQ/chex.wad",
  /** SHA-256 of the canonical 12,361,532-byte 1996 chex.wad, hashed from the real download. */
  wadSha256: "d8eb5277918883f490fb1a4be3c9a8588df2dbaee6dc4beb8df4929148bbffb1",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reads one entry out of a zip archive. Node ships no zip reader; this walks the
 * central directory and inflates the one file we need — the same minimal reader
 * fetch-freedoom.mjs uses.
 */
function extractEntry(archive, entryName) {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a zip archive: no end-of-central-directory record");

  const entryCount = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);

  for (let index = 0; index < entryCount; index++) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Corrupt zip central directory");
    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    if (name === entryName) {
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
  const wadPath = join(assetDirectory, "chex.wad");

  if (existsSync(wadPath)) {
    console.log(`chex.wad already present (sha256 ${sha256(readFileSync(wadPath))})`);
    return;
  }

  console.log("Fetching Chex Quest…");
  const response = await fetch(RELEASE.url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  const archive = Buffer.from(await response.arrayBuffer());

  const wad = extractEntry(archive, RELEASE.entry);
  const digest = sha256(wad);
  if (digest !== RELEASE.wadSha256) {
    throw new Error(
      `chex.wad digest mismatch.\n  expected ${RELEASE.wadSha256}\n  got      ${digest}\n` +
        "Refusing to write: the pinned release changed, or the download was tampered with.",
    );
  }

  writeFileSync(wadPath, wad);
  console.log(`Wrote chex.wad (${(wad.length / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  sha256 ${digest}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
