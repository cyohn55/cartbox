/**
 * Assembles the `cube2` runtime into apps/web/public/cube2 for the site build.
 *
 *   node scripts/fetch-cube2.mjs
 *
 * Cube 2: Sauerbraten runs on BananaBread — Mozilla's Emscripten (WASM+WebGL)
 * port of the Cube 2 engine — vendored under games/bananabread (see its
 * UPSTREAM.md). Nothing compiles here: this copies the vendored engine + its data
 * packages + the Cartbox boot page/bridge into public/cube2/, which the deploy
 * gitignores and regenerates rather than committing built artefacts (same posture
 * as the other game runtimes).
 *
 * The vendored set is digest-checked on the way out so a silently changed engine
 * or data package fails the build instead of surfacing as a broken title.
 * Cube 2 is zlib-licensed (engine + Sauerbraten assets), Tier A.
 */

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(repoRoot, "games", "bananabread");
const engineDir = join(vendorDir, "cube2");
const outputDir = join(repoRoot, "apps", "web", "public", "cube2");

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * Digests of the vendored engine set (BananaBread gh-pages @ 2d72c7f). A changed
 * artefact means the pinned engine drifted; fail loudly rather than ship it.
 */
const EXPECTED = {
  "bb.wasm": "cf2774a85b534b45",
  "bb.js": "c5a25a98568fdf11",
  "base.data": "3ea381d4dcab55f2",
  "character.data": "6c266871ecf7ce15",
  "low.data": "c4b515edb58002c7",
};

/** Recursively list files under a directory, relative to it. */
function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full).map((p) => join(entry, p)));
    else out.push(entry);
  }
  return out;
}

function main() {
  // Fresh, deterministic output tree.
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  // Copy the vendored engine (preserving game/ and js/ subdirs).
  cpSync(engineDir, outputDir, { recursive: true });

  // Verify the large binaries against their pinned digests.
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const digest = sha256(readFileSync(join(outputDir, name))).slice(0, 16);
    if (digest !== expected) {
      throw new Error(`cube2: ${name} digest mismatch (got ${digest}, expected ${expected})`);
    }
  }

  // Cartbox boot page + console bridge (the handheld host loads cartbox-boot.html).
  cpSync(join(vendorDir, "cartbox-boot.html"), join(outputDir, "cartbox-boot.html"));
  cpSync(join(vendorDir, "cartbox-bridge.js"), join(outputDir, "cartbox-bridge.js"));

  const files = listFiles(outputDir);
  const bytes = files.reduce((sum, f) => sum + statSync(join(outputDir, f)).size, 0);
  console.log(`cube2: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB, engine digests verified`);
  console.log(`cube2: bundle ready at ${relative(repoRoot, outputDir)}`);
}

main();
