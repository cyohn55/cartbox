#!/usr/bin/env node
/**
 * Builds the standalone export's prebuilt parts (ENGINE_PARITY_ROADMAP.md EP18)
 * into apps/web/public/standalone/, where the editor's "Export game" fetches them:
 *
 *   runtime.js                the player and its boot code (src/standalone/runtime.ts)
 *   physics.js                Rapier, WebAssembly inlined (only for scenes with bodies)
 *   physics-deterministic.js  Rapier's deterministic build (scenes that ask for it)
 *   ktx2.js                   the Basis Universal transcoder (scenes with KTX2 textures)
 *
 * Each is one self-contained ES module: an exported page imports it from a blob
 * URL, so it can import nothing. Generated (and git-ignored); runs before
 * `next build` and `next dev`.
 *
 * Usage: node scripts/build-standalone.mjs [outDir]
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const webAppRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] ?? join(webAppRoot, "public", "standalone"));
mkdirSync(outDir, { recursive: true });

// Node built-ins the vendored Emscripten glue only touches when run under Node.
const NODE_BUILTINS = ["fs", "path", "url", "module", "crypto", "worker_threads", "node:fs", "node:path", "node:url", "node:module"];

const ENTRIES = [
  { entry: "runtime.ts", out: "runtime.js", external: ["@dimforge/*"] },
  // physicsRapier.ts can load either build; each bundle carries only its own.
  { entry: "physics.ts", out: "physics.js", external: ["@dimforge/rapier3d-deterministic-compat"] },
  { entry: "physicsDeterministic.ts", out: "physics-deterministic.js", external: ["@dimforge/rapier3d-compat"] },
  { entry: "ktx2.ts", out: "ktx2.js", external: [] },
];

const started = Date.now();
await Promise.all(
  ENTRIES.map(({ entry, out, external }) =>
    build({
      entryPoints: [join(webAppRoot, "src", "standalone", entry)],
      outfile: join(outDir, out),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2020",
      minify: true,
      legalComments: "none",
      tsconfig: join(webAppRoot, "tsconfig.json"),
      loader: { ".wasm": "binary" },
      // The player from source, not its committed dist (which may lag a change in review).
      alias: { "@cartbox/player": join(webAppRoot, "..", "..", "packages", "player", "src", "index.ts") },
      external: [...external, ...NODE_BUILTINS],
      define: { "process.env.NODE_ENV": '"production"', "process.env.NEXT_PUBLIC_STATIC_EXPORT": '""', "process.env.NEXT_PUBLIC_BASE_PATH": '""' },
      logLevel: "warning",
    }),
  ),
);
console.log(`Standalone export parts built in ${Date.now() - started} ms → ${outDir}`);
