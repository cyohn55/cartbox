/**
 * Builds OpenTTD to WebAssembly for the `openttd` catalog runtime.
 *
 *   node scripts/build-openttd.mjs
 *
 * OpenTTD is a whole SDL2 application that runs in an iframe
 * (apps/web/public/openttd/cartbox-boot.html). This produces the engine every
 * OpenTTD session reuses — openttd.js + openttd.wasm + a preloaded openttd.data —
 * with the free OpenGFX base graphics baked in so the game is fully self-contained
 * (no base-graphics download over the network at runtime).
 *
 * OpenTTD ships first-class Emscripten support (os/emscripten). Its documented,
 * known-good toolchain is emsdk 3.1.57 with its bundled contrib LibLZMA port —
 * newer emsdk versions can break the port API and the LZMA CMake find-module, so we
 * pin it. Prerequisites (CI installs them; locally, no sudo needed):
 *   - emsdk with 3.1.57 installed + activated (`emsdk install 3.1.57 && emsdk
 *     activate 3.1.57`); this script copies OpenTTD's liblzma.py into the emscripten
 *     contrib ports before configuring.
 *   - a host C++ toolchain (g++/make/cmake) for the mandatory host-tools stage
 *     (strgen/settingsgen run on the build machine, not in WASM).
 *
 * Two-stage build, straight from OpenTTD's os/emscripten/README:
 *   1. host tools  (native, OPTION_TOOLS_ONLY)
 *   2. game        (emcmake, referencing the host tools via HOST_BINARY_DIR)
 * then OpenGFX is dropped into build/baseset and the game target is re-linked so the
 * base set is packaged into openttd.data.
 *
 * Output lands in apps/web/public/openttd/ (gitignored — ~18MB total — so a deploy
 * MUST run this, exactly like build-doom/scummvm/supertux/opentyrian).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repoRoot, "apps", "web", "public", "openttd");

/** Pinned so a rebuild is reproducible and auditable. OpenTTD 15.3 is GPL-2. */
const OPENTTD_TAG = "15.3";
const OPENTTD_REPO = "https://github.com/OpenTTD/OpenTTD.git";

/**
 * OpenGFX — OpenTTD's own GPL-2 base graphics set, freely redistributable. Pinned by
 * SHA-256 so a swapped mirror can never smuggle in different bytes. This is what
 * makes the bundle self-contained: without a complete base set, OpenTTD boots into a
 * network bootstrap that downloads graphics from the content server.
 */
const OPENGFX_VERSION = "7.1";
const OPENGFX_URL = `https://cdn.openttd.org/opengfx-releases/${OPENGFX_VERSION}/opengfx-${OPENGFX_VERSION}-all.zip`;
const OPENGFX_SHA256 = "928fcf34efd0719a3560cbab6821d71ce686b6315e8825360fba87a7a94d7846";

const ENGINE_ARTEFACTS = ["openttd.js", "openttd.wasm", "openttd.data"];

const workDir = process.env.OPENTTD_WORKDIR || join(process.env.HOME || repoRoot, "openttd-src");
const hostBuildDir = join(workDir, "build-host");
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

/** The emsdk root, needed to install the contrib LibLZMA port OpenTTD supplies. */
function emsdkRoot() {
  const emConfig = process.env.EM_CONFIG;
  // EMSDK is exported by emsdk_env.sh; EM_CONFIG points inside the same tree.
  const root = process.env.EMSDK || (emConfig ? dirname(emConfig) : "");
  if (!root) throw new Error("EMSDK not set — activate emsdk (source emsdk_env.sh) first.");
  return root;
}

function fetchSource() {
  if (existsSync(join(workDir, ".git"))) return; // reuse a prior checkout
  rmSync(workDir, { recursive: true, force: true });
  run("git", ["clone", "--depth", "1", "--branch", OPENTTD_TAG, OPENTTD_REPO, workDir]);
}

/** Copy OpenTTD's bundled LibLZMA port into the active emscripten's contrib ports. */
function installLzmaPort() {
  const dest = join(emsdkRoot(), "upstream", "emscripten", "tools", "ports", "contrib", "liblzma.py");
  cpSync(join(workDir, "os", "emscripten", "ports", "liblzma.py"), dest);
}

function buildHostTools() {
  rmSync(hostBuildDir, { recursive: true, force: true });
  mkdirSync(hostBuildDir, { recursive: true });
  run("cmake", ["..", "-DOPTION_TOOLS_ONLY=ON", "-DCMAKE_BUILD_TYPE=Release"], { cwd: hostBuildDir });
  run("make", ["-j", String(cpuCount()), "tools"], { cwd: hostBuildDir });
}

function configureGame() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  run("emcmake", [
    "cmake", "..",
    `-DHOST_BINARY_DIR=${hostBuildDir}`,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DOPTION_USE_ASSERTS=OFF",
  ], { cwd: buildDir });
}

/** Download + verify OpenGFX, then drop it into the preloaded baseset directory. */
async function installOpenGfx() {
  const zipPath = join(tmpdir(), `opengfx-${OPENGFX_VERSION}.zip`);
  const response = await fetch(OPENGFX_URL);
  if (!response.ok) throw new Error(`OpenGFX download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== OPENGFX_SHA256) {
    throw new Error(`OpenGFX hash mismatch: expected ${OPENGFX_SHA256}, got ${digest}.`);
  }
  writeFileSync(zipPath, bytes);

  const gfxDir = join(buildDir, "baseset", "opengfx");
  rmSync(gfxDir, { recursive: true, force: true });
  mkdirSync(gfxDir, { recursive: true });
  // The zip holds a single tar; extract, then copy just the .grf + .obg + license.
  run("python3", [
    "-c",
    [
      "import zipfile,tarfile,io,os,sys,shutil",
      "zip_path, dst = sys.argv[1], sys.argv[2]",
      "z=zipfile.ZipFile(zip_path)",
      "tar_name=[n for n in z.namelist() if n.endswith('.tar')][0]",
      "t=tarfile.open(fileobj=io.BytesIO(z.read(tar_name)))",
      "for m in t.getmembers():",
      "    base=os.path.basename(m.name)",
      "    if base.endswith(('.grf','.obg')) or base=='license.txt':",
      "        with t.extractfile(m) as s, open(os.path.join(dst,base),'wb') as o: shutil.copyfileobj(s,o)",
    ].join("\n"),
    zipPath,
    gfxDir,
  ]);
  if (!existsSync(join(gfxDir, "opengfx.obg"))) {
    throw new Error("OpenGFX extraction produced no opengfx.obg; the archive layout may have changed.");
  }
}

/** Re-link the game target so the file packager bakes OpenGFX into openttd.data. */
function relinkGame() {
  // Make tracks openttd.html as the link target; removing it forces a re-link
  // (object files stay cached, so this is fast).
  for (const artefact of ["openttd.html", ...ENGINE_ARTEFACTS]) {
    rmSync(join(buildDir, artefact), { force: true });
  }
  run("emmake", ["make", "openttd", "-j", String(cpuCount())], { cwd: buildDir });
}

function publish() {
  mkdirSync(outputDirectory, { recursive: true });
  for (const artefact of ENGINE_ARTEFACTS) {
    const from = join(buildDir, artefact);
    if (!existsSync(from)) throw new Error(`Build did not produce ${artefact}`);
    cpSync(from, join(outputDirectory, artefact));
  }
  console.log(`OpenTTD published to ${outputDirectory}`);
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
  // Probe emcc, not emcmake: `emcmake --version` is not a valid invocation (it is a
  // wrapper that runs `emcmake <cmd>`), so it would false-negative. emcc lives in the
  // same emsdk bin dir, so its presence guarantees emcmake/emmake are available too.
  requireTool("emcc", "Activate emsdk 3.1.57 (emsdk install 3.1.57 && emsdk activate 3.1.57; source emsdk_env.sh).");
  requireTool("cmake", "Install cmake.");
  requireTool("g++", "Install a host C++ compiler for the host-tools stage.");
  requireTool("python3", "Install python3 (used to extract OpenGFX).");

  fetchSource();
  installLzmaPort();
  buildHostTools();
  configureGame();
  await installOpenGfx();
  relinkGame();
  publish();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
