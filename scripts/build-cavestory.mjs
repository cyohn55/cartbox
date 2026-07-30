/**
 * Builds Cave Story (NXEngine) to WebAssembly for the `cavestory` catalog runtime.
 *
 *   node scripts/build-cavestory.mjs
 *
 * Cave Story runs on NXEngine-evo — a GPL-3 clean-room reimplementation of Pixel's
 * engine (NOT a decompilation; the decompilation, CSE2, is DMCA'd off GitHub). It
 * is a whole SDL2 application that runs in an iframe
 * (apps/web/public/cavestory/cartbox-boot.html). This produces the engine every
 * Cave Story session reuses — nxengine.js + nxengine.wasm + a preloaded
 * nxengine.data holding the freeware game assets.
 *
 * Pipeline (mirrors what the build was first proven with by hand):
 *   1. clone the pinned NXEngine emscripten branch,
 *   2. configure + compile the objects (see the SDL/CMake workarounds below),
 *   3. fetch + verify the freeware Cave Story data (libretro mirror), then run
 *      NXEngine's own `extract` tool on the bundled Doukutsu.exe to generate the
 *      stage table, sound effects and Organya music the mirror omits,
 *   4. merge the three data trees and manually link with em++ (ASYNCIFY).
 *
 * Data licence: Studio Pixel released Cave Story as freeware; Debian's
 * game-data-packager assesses the data as freely redistributable (even
 * commercially). Free engine + freely-redistributable data → Tier A.
 *
 * Prerequisites (CI installs them; locally, no sudo needed):
 *   - emsdk activated (emcc/emcmake on PATH). SDL2/SDL2_image/SDL2_mixer come from
 *     Emscripten's own ports (-sUSE_SDL*), so no vcpkg is needed.
 *   - cmake, a host C++ compiler (g++ — builds the native `extract` tool), git.
 *
 * Output lands in apps/web/public/cavestory/ (gitignored — ~9MB — so a deploy MUST
 * run this, exactly like build-doom/scummvm/supertux/opentyrian/openttd).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repoRoot, "apps", "web", "public", "cavestory");

/** Pinned so a rebuild is reproducible and auditable. NXEngine-evo is GPL-3. */
const NXENGINE_REPO = "https://github.com/midzer/nxengine-evo.git";
const NXENGINE_BRANCH = "emscripten";
const NXENGINE_COMMIT = "e857bb3eb5623131306bdeae304cf7ec15b0f6c3";

/**
 * The freeware Cave Story data, mirrored by the libretro asset server (this is the
 * "Cave Story (En)" package the NXEngine libretro core downloads). SHA-256-pinned
 * so a swapped mirror can never smuggle in different bytes. It carries the maps,
 * scripts and graphics AND the original Doukutsu.exe, from which NXEngine's
 * extractor derives the stage table, sound effects and music.
 */
const DATA_URL = "https://buildbot.libretro.com/assets/cores/Cave%20Story/Cave%20Story%20(En).zip";
const DATA_SHA256 = "b8e1b4ed667a6b075811abc52e468ef3c534e7e24e2ef0bc44d8ff95999c83fd";

const ENGINE_ARTEFACTS = ["nxengine.js", "nxengine.wasm", "nxengine.data"];

const workDir = process.env.CAVESTORY_WORKDIR || join(process.env.HOME || repoRoot, "nxengine-src");
const buildDir = join(workDir, "build");
const webDataDir = join(workDir, "webdata");

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...options });
}

function capture(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...options }).trim();
}

function requireTool(tool, hint) {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(`Missing required tool: ${tool}. ${hint}`);
  }
}

/** Emscripten's SDL2 headers live here; the CMake find_package needs pointing at them. */
function sdlIncludeDir() {
  const cache = capture("em-config", ["CACHE"]);
  return join(cache, "sysroot", "include", "SDL2");
}

function fetchSource() {
  if (existsSync(join(workDir, ".git"))) return;
  rmSync(workDir, { recursive: true, force: true });
  run("git", ["clone", "--branch", NXENGINE_BRANCH, NXENGINE_REPO, workDir]);
  run("git", ["-C", workDir, "checkout", NXENGINE_COMMIT]);
}

/**
 * Configure + compile the engine objects.
 *
 * Two workarounds the upstream CMake needs under a modern toolchain:
 *  - CMAKE_POLICY_VERSION_MINIMUM=3.5: its cmake_minimum_required predates the
 *    floor recent CMake enforces.
 *  - SDL2_{MIXER,IMAGE}_INCLUDE_DIR + the -sUSE_SDL* flags: it does an
 *    unconditional find_package for SDL2_mixer/image, which do not exist as system
 *    packages under Emscripten (they are link-time ports). We satisfy the
 *    include-dir vars with Emscripten's own SDL2 headers and pass the port flags so
 *    the sources compile. The dummy *_LIBRARY values are unused — the real link is
 *    the manual em++ step below.
 * The cmake-driven final link fails under Emscripten (plain library names); that is
 * expected and ignored — only the object files are needed.
 */
function compile() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  const sdlInc = sdlIncludeDir();
  const sdlFlags = "-sUSE_SDL=2 -sUSE_SDL_IMAGE=2 -sUSE_SDL_MIXER=2";
  run(
    "emcmake",
    [
      "cmake", "-DCMAKE_BUILD_TYPE=Release", "-DPORTABLE=ON",
      "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
      `-DSDL2_MIXER_INCLUDE_DIR=${sdlInc}`, `-DSDL2_IMAGE_INCLUDE_DIR=${sdlInc}`,
      "-DSDL2_MIXER_LIBRARY=nul", "-DSDL2_IMAGE_LIBRARY=nul",
      `-DCMAKE_C_FLAGS=${sdlFlags}`, `-DCMAKE_CXX_FLAGS=${sdlFlags}`,
      "..",
    ],
    { cwd: buildDir },
  );
  try {
    run("emmake", ["make", "-j", String(cpuCount())], { cwd: buildDir });
  } catch {
    // The final cmake link fails under Emscripten by design; the objects are built.
  }
  if (findObjects().length === 0) throw new Error("Compile produced no object files.");
}

function findObjects() {
  return capture("find", [join(buildDir, "CMakeFiles", "nx.dir"), "-name", "*.o"])
    .split("\n")
    .filter(Boolean);
}

/**
 * Assemble the complete game-data tree.
 *
 * The libretro package is tailored for the libretro core and omits the stage table,
 * the .pxt sound effects and the Organya music — the standalone engine needs them.
 * They are embedded in Doukutsu.exe (shipped in the same package); NXEngine's own
 * `extract` tool (pure file I/O, no SDL despite the CMake link line) writes them out.
 * The final tree = the freeware data + the engine's own data/ + the extracted files.
 */
async function assembleData() {
  const zipPath = join(tmpdir(), "cavestory-en.zip");
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error(`Data download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== DATA_SHA256) {
    throw new Error(`Data hash mismatch: expected ${DATA_SHA256}, got ${digest}.`);
  }
  writeFileSync(zipPath, bytes);

  const unzipDir = join(tmpdir(), "cavestory-data");
  rmSync(unzipDir, { recursive: true, force: true });
  mkdirSync(unzipDir, { recursive: true });
  run("python3", ["-c", "import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zipPath, unzipDir]);
  const freewareData = join(unzipDir, "Cave Story (en)", "data");
  const doukutsu = join(unzipDir, "Cave Story (en)", "Doukutsu.exe");
  if (!existsSync(freewareData) || !existsSync(doukutsu)) {
    throw new Error("Unexpected Cave Story archive layout (missing data/ or Doukutsu.exe).");
  }

  // Build the native extractor and run it on Doukutsu.exe.
  const extractBin = join(tmpdir(), "nxextract");
  run("g++", [
    "-O2", "-w", "-I", join(workDir, "src"), "-I", join(workDir, "deps"), "-I", sdlIncludeDir(),
    ...readdirSync(join(workDir, "src", "extract")).filter((f) => f.endsWith(".cpp")).map((f) => join(workDir, "src", "extract", f)),
    join(workDir, "src", "common", "misc.cpp"),
    join(workDir, "src", "Utils", "Logger.cpp"),
    join(workDir, "src", "stagedata.cpp"),
    "-o", extractBin,
  ]);
  const extractDir = join(tmpdir(), "cavestory-extract");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(join(extractDir, "data", "pxt"), { recursive: true });
  mkdirSync(join(extractDir, "data", "org"), { recursive: true });
  cpSync(doukutsu, join(extractDir, "Doukutsu.exe"));
  run(extractBin, [], { cwd: extractDir });

  // Merge: freeware data → engine data → extracted data.
  rmSync(webDataDir, { recursive: true, force: true });
  mkdirSync(webDataDir, { recursive: true });
  cpSync(freewareData, webDataDir, { recursive: true });
  cpSync(join(workDir, "data"), webDataDir, { recursive: true });
  cpSync(join(extractDir, "data"), webDataDir, { recursive: true });
  if (!existsSync(join(webDataDir, "stage.dat"))) {
    throw new Error("Data assembly failed: stage.dat was not produced by the extractor.");
  }
}

/** Manually link the objects with the Emscripten flags NXEngine's EMSCRIPTEN.md prescribes. */
function link() {
  const args = [
    "-flto", "-O2", ...findObjects(),
    "-o", join(buildDir, "nxengine.html"),
    "-sUSE_SDL=2", "-sUSE_SDL_IMAGE=2", '-sSDL2_IMAGE_FORMATS=["png","bmp"]', "-sUSE_SDL_MIXER=2",
    "-sASYNCIFY", "-sASYNCIFY_IGNORE_INDIRECT", `-sASYNCIFY_ONLY=@${join(workDir, "funcs.txt")}`,
    "-sINITIAL_MEMORY=134217728", "-sALLOW_MEMORY_GROWTH", "-sENVIRONMENT=web",
    "-sEXPORTED_RUNTIME_METHODS=allocate",
    "--preload-file", `${webDataDir}@data`,
  ];
  run("em++", args, { cwd: buildDir });
}

function publish() {
  mkdirSync(outputDirectory, { recursive: true });
  for (const artefact of ENGINE_ARTEFACTS) {
    const from = join(buildDir, artefact);
    if (!existsSync(from)) throw new Error(`Build did not produce ${artefact}`);
    cpSync(from, join(outputDirectory, artefact));
  }
  console.log(`Cave Story published to ${outputDirectory}`);
}

function cpuCount() {
  try {
    return readdirSync("/sys/devices/system/cpu").filter((n) => /^cpu\d+$/.test(n)).length || 4;
  } catch {
    return 4;
  }
}

async function main() {
  requireTool("git", "Install git.");
  requireTool("emcmake", "Activate emsdk (source emsdk_env.sh).");
  requireTool("cmake", "Install cmake.");
  requireTool("g++", "Install a host C++ compiler (builds the extract tool).");
  requireTool("python3", "Install python3 (used to unzip the data).");

  fetchSource();
  compile();
  await assembleData();
  link();
  publish();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
