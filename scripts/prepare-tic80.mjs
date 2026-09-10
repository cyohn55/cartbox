/**
 * Fetch and patch the vendored TIC-80 that every console core is built from.
 *
 * `packages/engine/README.md` describes this as a git submodule, but the
 * repository has no `.gitmodules` and `packages/engine/tic80/` is gitignored —
 * so in practice the source is not there, and the documented
 * `git submodule update --init` does nothing. That gap is why the engine build
 * was believed to need tooling nobody had: the missing piece was never
 * Emscripten (CI has installed it for years, for the game engines), it was a
 * checkout step that had no script.
 *
 * This is that step. It is deliberately a plain clone at a pinned commit rather
 * than a submodule, because the patches below are the point: they only apply to
 * a tree at that commit, so "whatever HEAD is today" is not a valid input.
 *
 * Idempotent — a tree that is already prepared is left alone, so this is safe to
 * run before every build and cheap when the cache already holds one.
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The TIC-80 commit the Cartbox patches were authored against.
 *
 * Both patches carry `index` lines naming the exact blobs they expect, so they
 * apply cleanly here and nowhere else in particular. Moving this pin means
 * re-rolling the patches and rebuilding every core, which is why it is a commit
 * and not a branch.
 */
const TIC80_COMMIT = "4aba09c98f1e5028b82765be1647677b08d35942";
const TIC80_REMOTE = "https://github.com/nesbox/TIC-80";

/**
 * Applied in this order, both from `packages/engine/patches`.
 *
 * `cartbox-model-specs` is what makes a per-model core possible at all: it
 * `#ifndef`-guards the fixed spec so `-D` defines can select one. Without it a
 * PS1 build would silently compile at Classic's 240x136.
 */
const PATCHES = ["cartbox-model-specs.patch", "cartbox-material-gbuffer.patch"];

const root = fileURLToPath(new URL("..", import.meta.url));
const engineDir = `${root}packages/engine`;
const tic80Dir = `${engineDir}/tic80`;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Whether the tree is already at the pinned commit with both patches applied. */
function alreadyPrepared() {
  if (!existsSync(`${tic80Dir}/include/tic80.h`)) return false;
  try {
    // A prepared tree is at the pin AND dirty (the patches are working-tree
    // edits, never commits). A clean tree at the pin is unpatched.
    const head = git(["rev-parse", "HEAD"], tic80Dir).trim();
    if (head !== TIC80_COMMIT) return false;
    return git(["status", "--porcelain"], tic80Dir).trim() !== "";
  } catch {
    return false;
  }
}

if (alreadyPrepared()) {
  console.log(`packages/engine/tic80 is already at ${TIC80_COMMIT.slice(0, 12)} with patches applied.`);
  process.exit(0);
}

// A half-prepared tree (wrong commit, partial patches, an interrupted clone) is
// not worth reasoning about. Start clean; the whole thing is gitignored.
if (existsSync(tic80Dir)) {
  console.log("Removing the existing packages/engine/tic80 tree.");
  rmSync(tic80Dir, { recursive: true, force: true });
}

console.log(`Cloning TIC-80 at ${TIC80_COMMIT.slice(0, 12)}...`);
// Full history rather than --depth 1: a shallow clone cannot be checked out at
// an arbitrary commit, and the pin is the whole point. --filter=blob:none keeps
// it cheap by fetching file contents only for the commit actually checked out.
git(["clone", "--quiet", "--filter=blob:none", TIC80_REMOTE, tic80Dir], root);
git(["checkout", "--quiet", TIC80_COMMIT], tic80Dir);
git(["submodule", "update", "--init", "--recursive", "--depth", "1"], tic80Dir);

for (const patch of PATCHES) {
  console.log(`Applying ${patch}...`);
  git(["apply", `${engineDir}/patches/${patch}`], tic80Dir);
}

console.log("packages/engine/tic80 is ready. Build a core with e.g. npm run engine:build:ps1.");
