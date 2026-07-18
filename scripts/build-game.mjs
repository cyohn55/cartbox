/**
 * Builds a Cartbox Game ABI title to WebAssembly.
 *
 *   source ~/emsdk/emsdk_env.sh
 *   node scripts/build-game.mjs reference
 *
 * Output lands in apps/web/public/games/<name>/ as game.js + game.wasm, which is
 * what wasmGameRuntime.ts loads. Ported games with their own build systems will
 * want their own script; this covers the single-translation-unit case and
 * documents the link flags the ABI requires.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Functions the host calls. Emscripten strips anything it cannot see is used,
 * so the ABI has to be named explicitly even though the sources mark it
 * EMSCRIPTEN_KEEPALIVE.
 */
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
 * Module options the host may pass in. Emscripten drops any incoming option not
 * named here, so this list is what makes them work at all.
 *
 * - `wasmBinary` lets the host supply bytes it already holds, rather than the
 *   glue re-fetching them: needed for offline play from local cache, and for
 *   driving a game outside a browser (the runtime tests do exactly this).
 * - `locateFile` lets the host resolve game.wasm under a deploy base path,
 *   which a project-path static host such as GitHub Pages requires.
 */
const INCOMING_MODULE_API = ["wasmBinary", "locateFile", "print", "printErr"];

function build(gameName) {
  const sourceDirectory = join(repoRoot, "games", gameName);
  if (!existsSync(sourceDirectory)) {
    throw new Error(`No game source at ${sourceDirectory}`);
  }

  const sources = readdirSync(sourceDirectory)
    .filter((file) => file.endsWith(".c"))
    .map((file) => join(sourceDirectory, file));
  if (sources.length === 0) {
    throw new Error(`No C sources in ${sourceDirectory}`);
  }

  const outputDirectory = join(repoRoot, "apps", "web", "public", "games", gameName);
  mkdirSync(outputDirectory, { recursive: true });

  const args = [
    ...sources,
    "-O2",
    "-o",
    join(outputDirectory, "game.js"),
    // A single self-describing module the host can instantiate more than once,
    // rather than a script with global side effects.
    "-s",
    "MODULARIZE=1",
    "-s",
    "EXPORT_NAME=createGame",
    // A real ES module. MODULARIZE alone emits CommonJS-style glue, which a
    // browser's dynamic import() cannot consume — Node's interop masks this, so
    // it fails only in the browser.
    "-s",
    "EXPORT_ES6=1",
    // The host owns the loop, so the module must not exit after main().
    "-s",
    "EXIT_RUNTIME=0",
    // Game data can be large; letting the heap grow beats guessing a ceiling.
    "-s",
    "ALLOW_MEMORY_GROWTH=1",
    "-s",
    `EXPORTED_FUNCTIONS=${JSON.stringify(ABI_EXPORTS)}`,
    "-s",
    `EXPORTED_RUNTIME_METHODS=${JSON.stringify(RUNTIME_EXPORTS)}`,
    "-s",
    `INCOMING_MODULE_JS_API=${JSON.stringify(INCOMING_MODULE_API)}`,
    // Plain WASM + JS glue, no HTML shell: the host supplies the canvas.
    "-s",
    "ENVIRONMENT=web",
  ];

  execFileSync("emcc", args, { stdio: "inherit" });
  return outputDirectory;
}

const gameName = process.argv[2];
if (!gameName) {
  console.error("usage: node scripts/build-game.mjs <game-name>");
  process.exit(1);
}

const output = build(gameName);
console.log(`Built ${gameName} → ${output}`);
