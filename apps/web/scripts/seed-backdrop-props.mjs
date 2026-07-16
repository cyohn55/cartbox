/**
 * Writes the committed global backdrop prop set to public/backdrop/props.json
 * from the code-defined defaults. Run whenever the built-in defaults change:
 *   node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" apps/web/scripts/seed-backdrop-props.mjs
 * (run from the repo root, the tic80-console workspace).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appWeb = path.resolve(here, "..");
const { DEFAULT_BACKDROP_PROP_SET, serializePropSet } = await import(
  pathToFileURL(path.resolve(appWeb, "src/lib/backdropProps.ts")).href
);

const outDir = path.resolve(appWeb, "public/backdrop");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "props.json");
writeFileSync(outFile, `${serializePropSet(DEFAULT_BACKDROP_PROP_SET)}\n`);
console.log(`wrote ${path.relative(appWeb, outFile)} (${DEFAULT_BACKDROP_PROP_SET.props.length} props)`);
