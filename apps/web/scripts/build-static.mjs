#!/usr/bin/env node
/**
 * Builds the static "demo" export of the web app (see src/lib/staticSite.ts).
 *
 * Next.js refuses to compile API route handlers and middleware under
 * `output: "export"` — both need a server. Neither is reachable in demo mode
 * anyway (pages read the baked-in demo catalog instead), so this script moves
 * them outside src/ for the duration of the build and always restores them,
 * even when the build fails. The result lands in apps/web/out/.
 *
 * Usage:
 *   node scripts/build-static.mjs
 * Environment:
 *   NEXT_PUBLIC_BASE_PATH  Optional site prefix, e.g. "/cartbox" for a
 *                          GitHub Pages project site.
 */

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webAppRoot = dirname(fileURLToPath(new URL("./", import.meta.url)));
const excludedRoot = join(webAppRoot, ".static-export-excluded");

/** Server-only source that must not exist while `next build` runs an export. */
const serverOnlySources = [
  { source: join(webAppRoot, "src", "app", "api"), parked: join(excludedRoot, "api") },
  { source: join(webAppRoot, "src", "middleware.ts"), parked: join(excludedRoot, "middleware.ts") },
];

function parkServerOnlySources() {
  mkdirSync(excludedRoot, { recursive: true });
  for (const { source, parked } of serverOnlySources) {
    if (existsSync(source)) {
      renameSync(source, parked);
    }
  }
}

function restoreServerOnlySources() {
  for (const { source, parked } of serverOnlySources) {
    if (existsSync(parked)) {
      renameSync(parked, source);
    }
  }
  rmSync(excludedRoot, { recursive: true, force: true });
}

function runNextBuild() {
  const result = spawnSync("npx", ["next", "build"], {
    cwd: webAppRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_PUBLIC_STATIC_EXPORT: "1",
    },
  });
  return result.status ?? 1;
}

parkServerOnlySources();
try {
  process.exitCode = runNextBuild();
} finally {
  restoreServerOnlySources();
}
