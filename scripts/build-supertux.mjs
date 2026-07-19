/**
 * Builds SuperTux to WebAssembly for the `supertux` catalog runtime.
 *
 *   node scripts/build-supertux.mjs
 *
 * Like ScummVM (build-scummvm.mjs) and unlike the Cartbox Game ABI ports
 * (build-doom.mjs), SuperTux is a whole SDL3/GLES2 application that runs in an
 * iframe (apps/web/public/supertux/cartbox-boot.html). This produces the engine
 * every SuperTux session reuses: supertux2.js + supertux2.wasm + a preloaded
 * supertux2.data asset package.
 *
 * SuperTux master builds with SDL3 via vcpkg. Prerequisites on PATH (CI installs
 * them; locally they were fetched no-sudo via apt-get download + dpkg-deb -x):
 *   - emsdk with the sdl3 AND sdl3_ttf ports (>= 6.0.3; the repo's pinned 6.0.2
 *     lacks sdl3_ttf), activated so emcc/emcmake are on PATH and EMSDK is set.
 *   - vcpkg (VCPKG_ROOT set, bootstrapped).
 *   - ninja, cmake, pkg-config, zip, unzip, and a host C/C++ compiler.
 *
 * Output lands in apps/web/public/supertux/ (gitignored — the data package is
 * ~170MB, over GitHub's file limit — so a deploy MUST run this, exactly like
 * build-doom.mjs / build-scummvm.mjs).
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repoRoot, "apps", "web", "public", "supertux");

/**
 * Pinned so a rebuild is reproducible and auditable. SuperTux is GPL-3, and the
 * corresponding source is this exact commit. A master commit rather than a
 * release tag because the SDL3 + Emscripten web build post-dates 0.6.3.
 */
const SUPERTUX_COMMIT = "06f5f549f00282c2759a55c31de7fca55b15cdff";
const SUPERTUX_REPO = "https://github.com/SuperTux/supertux.git";

/** The engine files the iframe loader needs; the rest of the build tree is unused. */
const ENGINE_ARTEFACTS = ["supertux2.js", "supertux2.wasm", "supertux2.data"];

/**
 * Data trees dropped from the 324MB source `data/` to keep the preload package
 * manageable (~170MB). SuperTux degrades gracefully: missing music plays silence,
 * missing locale falls back to English. Everything gameplay depends on — images,
 * levels, fonts, sounds, scripts, shaders — is kept.
 */
const DROP_DATA_DIRS = new Set(["music", "locale"]);

const workDir = process.env.SUPERTUX_WORKDIR || join(process.env.HOME || repoRoot, "supertux");
const buildDir = join(workDir, "build");

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...options });
}

function requireTool(tool, hint) {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(`Missing required tool '${tool}'. ${hint}`);
  }
}

function requireEnv(name, hint) {
  if (!process.env[name]) throw new Error(`Missing required env '${name}'. ${hint}`);
  return process.env[name];
}

/** Clone (or reuse) SuperTux at the pinned commit with all submodules. */
function fetchSource() {
  if (!existsSync(join(workDir, ".git"))) {
    run("git", ["clone", SUPERTUX_REPO, workDir]);
  }
  run("git", ["-C", workDir, "fetch", "--depth", "1", "origin", SUPERTUX_COMMIT]);
  run("git", ["-C", workDir, "checkout", SUPERTUX_COMMIT]);
  run("git", ["-C", workDir, "submodule", "update", "--init", "--recursive", "--depth", "1"]);
}

/**
 * Patch the Emscripten CMake module to link vcpkg's SDL3_image instead of the
 * non-existent `-sUSE_SDL_IMAGE=3` emscripten port (see the header + the
 * supertux-port memory: emsdk ships no sdl3_image port, so IMG_Load_IO is
 * otherwise left unresolved and the game aborts at runtime). Idempotent.
 */
function patchEmscriptenCmake() {
  const file = join(workDir, "mk", "cmake", "SuperTux", "Emscripten.cmake");
  let text = readFileSync(file, "utf8");
  if (text.includes("libSDL3_image.a")) return; // already patched

  const originalUse = "-sUSE_SDL=3 -sUSE_SDL_IMAGE=3 -sUSE_SDL_TTF=3";
  const patchedUse = "-sUSE_SDL=3 -sUSE_SDL_TTF=3";
  if (!text.includes(originalUse)) {
    throw new Error("Emscripten.cmake USE flags not found — SuperTux build layout changed; re-check the SDL3_image patch.");
  }
  text = text.replace(originalUse, patchedUse);

  const linkAnchor = "-lidbfs.js";
  const sdlImageLink =
    "-lidbfs.js " +
    "-Wl,--start-group " +
    "${CMAKE_BINARY_DIR}/vcpkg_installed/${VCPKG_TARGET_TRIPLET}/lib/libSDL3_image.a " +
    "${CMAKE_BINARY_DIR}/vcpkg_installed/${VCPKG_TARGET_TRIPLET}/lib/libpng16.a " +
    "${CMAKE_BINARY_DIR}/vcpkg_installed/${VCPKG_TARGET_TRIPLET}/lib/libz.a " +
    "-Wl,--end-group";
  text = text.replace(linkAnchor, sdlImageLink);

  writeFileSync(file, text);
}

/** Populate build/data with the trimmed asset set the link preloads. */
function stageData() {
  const src = join(workDir, "data");
  const dst = join(buildDir, "data");
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (DROP_DATA_DIRS.has(entry)) continue;
    cpSync(join(src, entry), join(dst, entry), { recursive: true });
  }
}

function configureAndBuild() {
  const emsdk = requireEnv("EMSDK", "Activate an emsdk with the sdl3 + sdl3_ttf ports (>= 6.0.3).");
  const vcpkgRoot = requireEnv("VCPKG_ROOT", "Point it at a bootstrapped vcpkg checkout.");
  const emscriptenToolchain = join(emsdk, "upstream", "emscripten", "cmake", "Modules", "Platform", "Emscripten.cmake");

  mkdirSync(buildDir, { recursive: true });
  stageData();

  run("emcmake", [
    "cmake", "..", "-G", "Ninja",
    "-DCMAKE_BUILD_TYPE=Release", "-DWARNINGS=OFF",
    `-DCMAKE_TOOLCHAIN_FILE=${join(vcpkgRoot, "scripts", "buildsystems", "vcpkg.cmake")}`,
    `-DVCPKG_CHAINLOAD_TOOLCHAIN_FILE=${emscriptenToolchain}`,
    "-DVCPKG_TARGET_TRIPLET=wasm32-emscripten",
    "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
    "-DVCPKG_MANIFEST_FEATURES=core",
  ], { cwd: buildDir });

  run("ninja", ["-j", String(Math.max(1, (process.env.NPROC || 0) | 0) || 4)], { cwd: buildDir });
}

function copyArtefacts() {
  mkdirSync(outputDirectory, { recursive: true });
  for (const file of ENGINE_ARTEFACTS) {
    const from = join(buildDir, file);
    if (!existsSync(from)) throw new Error(`Build finished but ${file} is missing.`);
    cpSync(from, join(outputDirectory, file));
    const mb = (statSync(from).size / (1024 * 1024)).toFixed(1);
    console.log(`  ${file}  (${mb} MB)`);
  }
}

function build() {
  requireTool("ninja", "Install ninja (CI: apt-get install -y ninja-build).");
  requireTool("pkg-config", "Install pkg-config (CI: apt-get install -y pkg-config).");
  requireTool("zip", "Install zip/unzip (vcpkg needs them; CI: apt-get install -y zip unzip).");

  console.log(`Building SuperTux @ ${SUPERTUX_COMMIT.slice(0, 10)} for wasm…`);
  fetchSource();
  patchEmscriptenCmake();
  configureAndBuild();
  console.log("Copying engine artefacts →", outputDirectory);
  copyArtefacts();
  console.log("SuperTux build complete.");
}

build();
