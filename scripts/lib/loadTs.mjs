/**
 * Imports a TypeScript module from a plain `node scripts/*.mjs` run.
 *
 * Some data the scripts need is authored in the web app's TypeScript source and
 * should stay there — the catalog of titles, for instance, is the app's own
 * list, and re-typing it in a seed script is how a seed drifts from the product.
 * Node cannot import `.ts` directly (nor resolve the app's extensionless
 * relative imports), so this bundles the module in memory with esbuild and
 * imports the result.
 *
 * Bundle, not transpile: the target module's own imports have to be inlined for
 * the same resolution reason. Nothing is written to disk.
 */

import { build } from "esbuild";

/**
 * Loads a TypeScript module and returns its exports.
 *
 * @param {URL | string} moduleUrl Absolute URL of the .ts entry point — build it
 *   with `new URL("../relative/path.ts", import.meta.url)` so a repo path
 *   containing spaces stays correctly encoded.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadTsModule(moduleUrl) {
  const result = await build({
    entryPoints: [decodeURIComponent(new URL(moduleUrl).pathname)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    // The app's "@/..." alias points at its src root; relative imports inside
    // the bundled module resolve on their own.
    absWorkingDir: decodeURIComponent(new URL("../../apps/web", import.meta.url).pathname),
  });

  const [output] = result.outputFiles;
  return import(`data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`);
}
