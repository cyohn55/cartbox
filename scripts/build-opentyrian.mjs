/**
 * Builds OpenTyrian2000 to WebAssembly for the `opentyrian` catalog runtime.
 *
 *   node scripts/build-opentyrian.mjs
 *
 * Like SuperTux (build-supertux.mjs) and ScummVM (build-scummvm.mjs), and unlike
 * the Cartbox Game ABI ports (build-doom.mjs), OpenTyrian2000 is a whole SDL2
 * application that runs in an iframe (apps/web/public/opentyrian/cartbox-boot.html).
 * This produces the engine every Tyrian session reuses: opentyrian2000.js +
 * opentyrian2000.wasm + a preloaded opentyrian2000.data asset package.
 *
 * Prerequisites on PATH (CI installs them; locally emsdk was activated so emcc is
 * on PATH and EMSDK is set):
 *   - emsdk (>= 3.x) with emcc activated. SDL2 comes from Emscripten's own port
 *     (-sUSE_SDL=2), so no vcpkg/ninja/pkg-config is needed — the plain source
 *     tree is compiled directly by emcc.
 *   - git, and a network path to the pinned source commit + the freeware data.
 *
 * The engine has its own blocking main loop (mainint.c), so it is built with
 * ASYNCIFY: the loop yields to the browser on SDL_Delay instead of hanging the
 * tab. WITH_NETWORK is disabled (SDL2_net has no Emscripten port and the console
 * is single-player), which is safe because network.c guards all SDL_net use
 * behind #ifdef WITH_NETWORK.
 *
 * Output lands in apps/web/public/opentyrian/ (gitignored — the data package is
 * ~12MB — so a deploy MUST run this, exactly like build-doom/scummvm/supertux).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repoRoot, "apps", "web", "public", "opentyrian");

/**
 * Pinned so a rebuild is reproducible and auditable. OpenTyrian2000 is GPL-2, and
 * the corresponding source is this exact commit of the maintained fork.
 */
const OPENTYRIAN_COMMIT = "aad5aca01af139c0b089237c38ef765f7a84355d";
const OPENTYRIAN_REPO = "https://github.com/KScl/opentyrian2000.git";

/**
 * Tyrian 2000's game data, released as freeware by original developer Jason Emery
 * and mirrored at camanis.net (the source OpenTyrian2000's own README points to).
 * Pinned by SHA-256 so a swapped mirror can never smuggle in different bytes.
 */
const DATA_URL = "https://www.camanis.net/tyrian/tyrian2000.zip";
const DATA_SHA256 = "348bc76e73514e452279b8730cf217daf0f70a282f07b6b94af653d87e921667";
/** The sentinel the engine's data_dir() probes for; its presence proves a good unzip. */
const DATA_SENTINEL = "tyrian1.lvl";

/** The engine files the iframe loader needs; the rest of the build tree is unused. */
const ENGINE_ARTEFACTS = ["opentyrian2000.js", "opentyrian2000.wasm", "opentyrian2000.data"];

const workDir = process.env.OPENTYRIAN_WORKDIR || join(process.env.HOME || repoRoot, "opentyrian-src");
const dataDir = join(workDir, "gamedata");
const buildDir = join(workDir, "build");

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...options });
}

function requireTool(tool, hint) {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(`Missing required tool: ${tool}. ${hint}`);
  }
}

/** Clone (or reuse) the pinned source commit. */
function fetchSource() {
  if (existsSync(join(workDir, ".git"))) {
    run("git", ["-C", workDir, "fetch", "--depth", "1", "origin", OPENTYRIAN_COMMIT]);
  } else {
    rmSync(workDir, { recursive: true, force: true });
    run("git", ["clone", "--no-checkout", OPENTYRIAN_REPO, workDir]);
    run("git", ["-C", workDir, "fetch", "--depth", "1", "origin", OPENTYRIAN_COMMIT]);
  }
  run("git", ["-C", workDir, "checkout", "--force", OPENTYRIAN_COMMIT]);
}

/** Download the freeware data, verify its hash, then flatten it into gamedata/. */
async function fetchData() {
  const zipPath = join(tmpdir(), "tyrian2000.zip");
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error(`Data download failed: ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== DATA_SHA256) {
    throw new Error(`Data hash mismatch: expected ${DATA_SHA256}, got ${digest}. Refusing to bundle unverified data.`);
  }
  writeFileSync(zipPath, bytes);

  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  // The zip nests everything under tyrian2000/; strip that one leading segment so
  // the files land where the engine's relative "data" search expects them.
  run("python3", [
    "-c",
    [
      "import zipfile,os,shutil,sys",
      "z=zipfile.ZipFile(sys.argv[1]); dst=sys.argv[2]",
      "for m in z.infolist():",
      "    if m.is_dir(): continue",
      "    name=m.filename.split('/',1)[1] if '/' in m.filename else m.filename",
      "    if not name: continue",
      "    with z.open(m) as s, open(os.path.join(dst,name),'wb') as o: shutil.copyfileobj(s,o)",
    ].join("\n"),
    zipPath,
    dataDir,
  ]);
  if (!existsSync(join(dataDir, DATA_SENTINEL))) {
    throw new Error(`Extracted data is missing ${DATA_SENTINEL}; the archive layout may have changed.`);
  }
}

/** Compile + link the whole source tree with emcc, preloading the data package. */
function build() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  const sources = execFileSync("bash", ["-c", `ls ${join(workDir, "src")}/*.c`]).toString().trim().split("\n");

  run("emcc", [
    ...sources,
    "-O2",
    "-DTARGET_UNIX",
    "-DNDEBUG",
    // The engine's data_dir() probes this path first; the .data package mounts here.
    `-DTYRIAN_DIR="/data"`,
    "-sUSE_SDL=2",
    "-I",
    join(workDir, "src"),
    "-sALLOW_MEMORY_GROWTH=1",
    "-sINITIAL_MEMORY=67108864",
    // The engine owns a blocking main loop; ASYNCIFY lets it yield to the browser.
    "-sASYNCIFY=1",
    "-sASYNCIFY_STACK_SIZE=32768",
    "-sEXPORTED_RUNTIME_METHODS=[\"callMain\"]",
    "--preload-file",
    `${dataDir}@/data`,
    "-o",
    join(buildDir, "opentyrian2000.html"),
  ]);
}

/** Copy just the engine artefacts into the public runtime directory. */
function publish() {
  mkdirSync(outputDirectory, { recursive: true });
  for (const artefact of ENGINE_ARTEFACTS) {
    const from = join(buildDir, artefact);
    if (!existsSync(from)) throw new Error(`Build did not produce ${artefact}`);
    cpSync(from, join(outputDirectory, artefact));
  }
  // cartbox-boot.html is authored and version-controlled, not generated; leave it.
  const total = ENGINE_ARTEFACTS.reduce((n, a) => n + readFileSync(join(outputDirectory, a)).length, 0);
  console.log(`OpenTyrian2000 published to ${outputDirectory} (${(total / 1e6).toFixed(1)} MB)`);
}

async function main() {
  requireTool("git", "Install git.");
  requireTool("emcc", "Activate emsdk so emcc is on PATH (source emsdk_env.sh).");
  requireTool("python3", "Install python3 (used to flatten the data zip).");

  fetchSource();
  await fetchData();
  build();
  publish();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
