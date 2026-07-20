/**
 * Builds a Doom-engine title to WebAssembly as a Cartbox Game ABI title.
 *
 *   source ~/emsdk/emsdk_env.sh
 *   node scripts/build-doom.mjs [doom|chex]
 *
 * build-game.mjs covers the single-translation-unit case; Doom needs its own
 * script because it is 80 vendored sources plus a ~29MB asset payload. The link
 * flags that the ABI requires are identical and deliberately kept in sync — the
 * differences here are the source list, the preloaded IWAD, and the fixed
 * 320x200 resolution compiled into doomgeneric.
 *
 * The doomgeneric engine and cartbox_doom.c shim are shared: cartbox_doom.c
 * passes a fixed -iwad path, so a variant is nothing more than a different IWAD
 * preloaded at that path and a different output directory. Chex Quest (a vanilla
 * Doom total conversion) reuses the whole engine this way.
 *
 * Output lands in apps/web/public/games/<variant>/ as game.js + game.wasm + game.data.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// The engine, shim and ABI live under games/doom regardless of variant; only the
// IWAD asset and output bundle differ.
const engineDirectory = join(repoRoot, "games", "doom");
const vendorDirectory = join(engineDirectory, "vendor");

/**
 * Path cartbox_doom.c passes to the engine's -iwad. Every variant's IWAD is
 * preloaded here, so the shim needs no per-variant change.
 */
const IWAD_MOUNT_PATH = "/freedoom1.wad";

/**
 * The Doom-engine titles this script can build. Each names the IWAD asset (under
 * its game directory's assets/) and the fetch script that produces it.
 */
const VARIANTS = {
  doom: {
    gameDirectory: join(repoRoot, "games", "doom"),
    iwadName: "freedoom1.wad",
    fetchScript: "fetch-freedoom.mjs",
    outputName: "doom",
  },
  chex: {
    gameDirectory: join(repoRoot, "games", "chex"),
    iwadName: "chex.wad",
    fetchScript: "fetch-chex.mjs",
    outputName: "chex",
  },
};

const variantName = process.argv[2] ?? "doom";
const variant = VARIANTS[variantName];
if (!variant) {
  throw new Error(`Unknown variant '${variantName}'. Known: ${Object.keys(VARIANTS).join(", ")}.`);
}
const outputDirectory = join(repoRoot, "apps", "web", "public", "games", variant.outputName);

/** See games/README.md; identical to build-game.mjs. */
const ABI_EXPORTS = [
  "_cartbox_init",
  "_cartbox_set_input",
  "_cartbox_tick",
  "_cartbox_score",
  "_cartbox_save_size",
  "_cartbox_save",
  "_cartbox_load",
  "_malloc",
  "_free",
];

const RUNTIME_EXPORTS = ["ccall", "cwrap", "HEAPU8"];

/**
 * Note what is deliberately absent: `getPreloadedPackage`, the asset-payload
 * counterpart to `wasmBinary` that lets a caller hand over game.data bytes it
 * already holds rather than having the glue fetch them (a Node test driving the
 * real binary has no fetchable URL for the package). It is not listed because
 * Emscripten rejects it as an unknown option and warns — the file packager glue
 * is emitted separately and checks `Module['getPreloadedPackage']`
 * unconditionally, so the hook works without being declared here.
 */
const INCOMING_MODULE_API = ["wasmBinary", "locateFile", "print", "printErr"];

/**
 * Doom's native resolution. doomgeneric scales its framebuffer by an integer
 * factor of SCREENWIDTH, so pinning these to 320x200 gives a 1:1 blit and lets
 * the host upscale with its own (pixel-preserving) canvas rules instead.
 */
const RESOLUTION = { width: 320, height: 200 };

/** Warnings that are endemic to a 1993 C codebase and not worth failing on. */
const SUPPRESSED_WARNINGS = [
  "-Wno-implicit-function-declaration",
  "-Wno-int-conversion",
  "-Wno-incompatible-pointer-types",
  "-Wno-format",
];

function collectSources() {
  if (!existsSync(vendorDirectory)) {
    throw new Error(
      `Missing vendored doomgeneric at ${vendorDirectory}. See games/doom/README.md for how it is sourced.`,
    );
  }
  const vendored = readdirSync(vendorDirectory)
    .filter((file) => file.endsWith(".c"))
    .map((file) => join(vendorDirectory, file));

  // The shim and engine are shared across variants; only the IWAD differs.
  return [join(engineDirectory, "cartbox_doom.c"), ...vendored];
}

function resolveIwad() {
  const iwad = join(variant.gameDirectory, "assets", variant.iwadName);
  if (!existsSync(iwad)) {
    throw new Error(
      `Missing IWAD at ${iwad}.\n` +
        `Fetch it with: node scripts/${variant.fetchScript}`,
    );
  }
  return iwad;
}

function build() {
  const sources = collectSources();
  const iwad = resolveIwad();
  mkdirSync(outputDirectory, { recursive: true });

  const args = [
    ...sources,
    "-O2",
    "-I",
    vendorDirectory,
    ...SUPPRESSED_WARNINGS,
    `-DDOOMGENERIC_RESX=${RESOLUTION.width}`,
    `-DDOOMGENERIC_RESY=${RESOLUTION.height}`,
    // Mounts the IWAD at the path cartbox_doom.c passes to -iwad. A separate
    // game.data package rather than --embed-file: the assets are ~29MB and
    // change far less often than the code, so bundling them into the wasm
    // would re-download all of it on every engine rebuild.
    "--preload-file",
    `${iwad}@${IWAD_MOUNT_PATH}`,
    "-o",
    join(outputDirectory, "game.js"),
    "-s",
    "MODULARIZE=1",
    "-s",
    "EXPORT_NAME=createGame",
    "-s",
    "EXPORT_ES6=1",
    "-s",
    "EXIT_RUNTIME=0",
    "-s",
    "ALLOW_MEMORY_GROWTH=1",
    // Doom's zone allocator claims a large block up front; starting there
    // avoids a chain of heap growths during boot.
    "-s",
    "INITIAL_MEMORY=134217728",
    "-s",
    `EXPORTED_FUNCTIONS=${JSON.stringify(ABI_EXPORTS)}`,
    "-s",
    `EXPORTED_RUNTIME_METHODS=${JSON.stringify(RUNTIME_EXPORTS)}`,
    "-s",
    `INCOMING_MODULE_JS_API=${JSON.stringify(INCOMING_MODULE_API)}`,
    "-s",
    "ENVIRONMENT=web",
  ];

  execFileSync("emcc", args, { stdio: "inherit", cwd: repoRoot });
}

build();

for (const artefact of ["game.js", "game.wasm", "game.data"]) {
  const path = join(outputDirectory, artefact);
  const megabytes = (statSync(path).size / 1024 / 1024).toFixed(1);
  console.log(`  ${artefact}  ${megabytes} MB`);
}
console.log(`Built ${variant.outputName} → ${outputDirectory}`);
