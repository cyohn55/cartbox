/**
 * Builds the ScummVM engine to WebAssembly for the `scummvm` catalog runtime.
 *
 *   node scripts/build-scummvm.mjs
 *
 * Unlike the Cartbox Game ABI ports (build-game.mjs, build-doom.mjs), this does
 * not compile against our ABI — ScummVM is a whole SDL application that runs in
 * an iframe (apps/web/public/scummvm/cartbox-boot.html). This script produces
 * the shared engine that every ScummVM title reuses; the game data is fetched
 * separately by fetch-scummvm-games.mjs.
 *
 * ScummVM ships its own Emscripten build (dists/emscripten/build.sh) which pins
 * and downloads its own emsdk (4.0.10) — so this deliberately does NOT use the
 * repo's emsdk. The build is limited to the Sky engine (Beneath a Steel Sky) to
 * keep the wasm small (~10MB) and the compile short.
 *
 * System prerequisites the ScummVM build needs on PATH: pkg-config and zip.
 * On CI: `apt-get install -y pkg-config zip`. Output lands in
 * apps/web/public/scummvm/ as scummvm.js + scummvm.wasm + data/.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repoRoot, "apps", "web", "public", "scummvm");

/**
 * Pinned so a rebuild is reproducible and auditable. ScummVM is GPL-3, and the
 * corresponding source is this exact commit — recorded next to the build the way
 * the Freedoom release is pinned in fetch-freedoom.mjs. This is a master commit
 * rather than a release tag because the Emscripten SDL3 backend and its on-demand
 * http filesystem (which the iframe loader relies on) post-date the last release.
 */
const SCUMMVM_COMMIT = "ce70c890a6d8016a97d49a9795614ddbfc3336ac";
const SCUMMVM_REPO = "https://github.com/scummvm/scummvm.git";

/** Only the Sky engine, so the wasm carries Beneath a Steel Sky and nothing else. */
const ENGINE_ARGS = ["--disable-all-engines", "--enable-engine=sky"];

/** The engine files the iframe loader needs; everything else in the dist is unused. */
const ENGINE_ARTEFACTS = ["scummvm.js", "scummvm.wasm", "data"];

function requireTool(tool) {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      `Missing required tool '${tool}'. The ScummVM build needs pkg-config and zip on PATH ` +
        "(CI: apt-get install -y pkg-config zip).",
    );
  }
}

function build() {
  requireTool("pkg-config");
  requireTool("zip");

  const buildRoot = process.env.SCUMMVM_BUILD_ROOT ?? join(tmpdir(), "cartbox-scummvm-src");
  if (!existsSync(join(buildRoot, ".git"))) {
    rmSync(buildRoot, { recursive: true, force: true });
    mkdirSync(buildRoot, { recursive: true });
    console.log(`Fetching ScummVM ${SCUMMVM_COMMIT.slice(0, 10)}…`);
    // Shallow fetch of the exact pinned commit — GitHub allows fetching a SHA
    // directly, so this stays reproducible without cloning the full history.
    execFileSync("git", ["init", "-q"], { cwd: buildRoot, stdio: "inherit" });
    execFileSync("git", ["remote", "add", "origin", SCUMMVM_REPO], { cwd: buildRoot, stdio: "inherit" });
    execFileSync("git", ["fetch", "--depth", "1", "origin", SCUMMVM_COMMIT], { cwd: buildRoot, stdio: "inherit" });
    execFileSync("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: buildRoot, stdio: "inherit" });
  } else {
    console.log(`Reusing ScummVM checkout at ${buildRoot}`);
  }

  console.log("Building the Sky engine (this downloads emsdk 4.0.10 on first run)…");
  execFileSync(
    "bash",
    ["dists/emscripten/build.sh", "setup", "libs", "configure", "make", "dist", ...ENGINE_ARGS],
    { cwd: buildRoot, stdio: "inherit" },
  );

  const dist = join(buildRoot, "build-emscripten");
  if (!existsSync(join(dist, "scummvm.wasm"))) {
    throw new Error(`ScummVM build produced no wasm at ${dist}. See the build output above.`);
  }

  mkdirSync(outputDirectory, { recursive: true });
  for (const artefact of ENGINE_ARTEFACTS) {
    rmSync(join(outputDirectory, artefact), { recursive: true, force: true });
    cpSync(join(dist, artefact), join(outputDirectory, artefact), { recursive: true });
  }
}

build();

for (const artefact of ["scummvm.js", "scummvm.wasm"]) {
  const megabytes = (statSync(join(outputDirectory, artefact)).size / 1024 / 1024).toFixed(1);
  console.log(`  ${artefact}  ${megabytes} MB`);
}
console.log(`Built ScummVM engine → ${outputDirectory}`);
