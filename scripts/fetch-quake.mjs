/**
 * Assembles the `quake` runtime into apps/web/public/quake for the site build.
 *
 *   node scripts/fetch-quake.mjs
 *
 * Unlike the Doom/ScummVM/SuperTux runtimes, the Quake runtime compiles nothing:
 * the engine is WebQuake, a pure-JavaScript WebGL reimplementation vendored under
 * games/webquake (see games/webquake/UPSTREAM.md). This script:
 *
 *   1. copies the vendored engine into public/quake/WebQuake/,
 *   2. transforms the vendored launcher (index.htm) into cartbox-boot.html — the
 *      same page, plus the Cartbox console bridge and an iframe-filling canvas,
 *   3. fetches id Software's freely redistributable Quake *shareware* (episode 1)
 *      and extracts id1/pak0.pak from it, verifying it against a pinned digest.
 *
 * The shareware zip is a DOS DEICE self-extractor: the outer container is a plain
 * ZIP (Node's zlib inflates it), and pak0.pak lives inside an embedded LHA
 * archive, which scripts/lib/lzh.mjs decodes in pure JS. So the whole bundle is
 * reproducible with no external archiver — the same "gitignored, regenerated on
 * deploy" posture as the other game runtimes.
 *
 * Legality: id's Quake shareware license (id1/slicnse.txt, written next to the
 * data) grants Providers the right to distribute the shareware free of charge by
 * electronic means, with the agreement accompanying it. That is the Tier B basis
 * recorded on the catalog row; the engine's own GPL is satisfied by the vendored
 * corresponding source under games/webquake.
 */

import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { lh5Decode, readLhaEntries } from "./lib/lzh.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(repoRoot, "games", "webquake");
const outputDir = join(repoRoot, "apps", "web", "public", "quake");

/**
 * id's Quake shareware, pinned. The gamers.org idgames mirror serves the
 * canonical quake106.zip. Digests are verified end to end: the downloaded zip,
 * and the extracted pak0.pak (episode-1 data — it contains no gfx/pop.lmp, so
 * WebQuake correctly runs as shareware, not the registered game).
 */
const SHAREWARE = {
  url: "https://www.gamers.org/pub/idgames/idstuff/quake/quake106.zip",
  zipSha256: "ec6c9d34b1ae0252ac0066045b6611a7919c2a0d78a3a66d9387a8f597553239",
  pakSha256: "35a9c55e5e5a284a159ad2a62e0e8def23d829561fe2f54eb402dbc0a9a946af",
  pakSize: 18689235,
};

/** Text files extracted from the shareware and written beside the data. */
const LICENSE_FILES = ["SLICNSE.TXT", "LICINFO.TXT", "README.TXT", "READV106.TXT"];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** Read one entry from a ZIP archive by name, inflating deflate entries. */
function readZipEntry(zip, name) {
  // Locate the End Of Central Directory record (scan backwards for its magic).
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i > zip.length - 22 - 65536; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("fetch-quake: not a ZIP archive (no EOCD)");
  const entryCount = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16); // central directory offset

  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error("fetch-quake: bad central directory");
    const method = zip.readUInt16LE(pos + 10);
    const compSize = zip.readUInt32LE(pos + 20);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const entryName = zip.toString("latin1", pos + 46, pos + 46 + nameLen);
    if (entryName === name) {
      // Jump to the local header to find where the data actually starts.
      if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("fetch-quake: bad local header");
      const localNameLen = zip.readUInt16LE(localOffset + 26);
      const localExtraLen = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const raw = zip.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`fetch-quake: unsupported ZIP method ${method} for ${name}`);
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`fetch-quake: ${name} not found in ZIP`);
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch-quake: ${url} -> HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Turn the vendored WebQuake launcher into the console boot page. */
function buildBootPage(indexHtml) {
  const injected = [
    '<style id="cartbox-quake">',
    "  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }",
    "  /* WebQuake sizes its canvas from documentElement.clientWidth/Height every",
    "     frame, so filling the iframe is all the autofit it needs. */",
    "  #mainwindow { position: fixed; inset: 0; width: 100%; height: 100%; outline: none; }",
    "  #progress { position: fixed; inset: 0; display: flex; align-items: center;",
    "    justify-content: center; color: #d7d7d7; font: 600 13px arial; background: #06040c; }",
    "</style>",
    // Loaded first so its alert/error overrides beat any WebQuake code.
    '<script src="cartbox-bridge.js"></script>',
    "</head>",
  ].join("\n");

  if (!indexHtml.includes("</head>")) throw new Error("fetch-quake: index.htm has no </head>");
  return indexHtml
    .replace("<title>Quake</title>", "<title>Quake (Cartbox)</title>")
    .replace("</head>", injected);
}

async function main() {
  // 1. Fresh output tree (keep it deterministic across reruns).
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(join(outputDir, "WebQuake"), { recursive: true });
  mkdirSync(join(outputDir, "id1"), { recursive: true });

  // 2. Vendored engine + bridge.
  for (const file of readdirSync(join(vendorDir, "WebQuake"))) {
    cpSync(join(vendorDir, "WebQuake", file), join(outputDir, "WebQuake", file));
  }
  cpSync(join(vendorDir, "cartbox-bridge.js"), join(outputDir, "cartbox-bridge.js"));
  cpSync(join(vendorDir, "GNU.md"), join(outputDir, "GNU.md"));

  const indexHtml = readFileSync(join(vendorDir, "index.htm"), "utf8");
  writeFileSync(join(outputDir, "cartbox-boot.html"), buildBootPage(indexHtml));
  console.log("quake: engine + boot page written");

  // 3. Shareware data (skip the download if a verified copy is already present).
  const pakPath = join(outputDir, "id1", "pak0.pak");
  let pak = null;
  const zip = await fetchBuffer(SHAREWARE.url);
  if (sha256(zip) !== SHAREWARE.zipSha256) {
    throw new Error(`quake: shareware zip digest mismatch (got ${sha256(zip)})`);
  }
  const resource = readZipEntry(zip, "resource.1");
  const entries = readLhaEntries(resource);

  const pakEntry = entries.find((e) => e.name.toUpperCase().endsWith("PAK0.PAK"));
  if (pakEntry == null) throw new Error("quake: PAK0.PAK not found in shareware");
  pak = Buffer.from(lh5Decode(resource.subarray(pakEntry.dataStart, pakEntry.dataStart + pakEntry.compSize), pakEntry.origSize));
  if (pak.length !== SHAREWARE.pakSize || sha256(pak) !== SHAREWARE.pakSha256) {
    throw new Error(`quake: pak0.pak digest mismatch (got ${sha256(pak)}, ${pak.length} bytes)`);
  }
  writeFileSync(pakPath, pak);

  // The shareware license must accompany the data; write the agreement + readmes.
  for (const name of LICENSE_FILES) {
    const entry = entries.find((e) => e.name.toUpperCase().endsWith(name));
    if (entry == null) continue;
    const text = Buffer.from(lh5Decode(resource.subarray(entry.dataStart, entry.dataStart + entry.compSize), entry.origSize));
    writeFileSync(join(outputDir, "id1", name.toLowerCase()), text);
  }

  console.log(`quake: id1/pak0.pak (${pak.length} bytes) verified + shareware license written`);
  console.log("quake: bundle ready at apps/web/public/quake");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
