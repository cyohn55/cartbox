/**
 * The WebGPU suites, found and judged (AAA_PRODUCTION_ROADMAP.md Q1).
 *
 * Every test that needs a real WebGPU device loads Dawn through `@kmamal/gpu`
 * and skips when it can't (`describe.skipIf(!device)`). That is right on a
 * contributor's machine without a GPU, and wrong in the one job whose purpose
 * is to run them: there, a skip means the shaders went unchecked. So the job
 * finds the suites by that import (a new one joins without being listed) and
 * fails on any outcome but a pass.
 *
 * Pure and Node-only: `scripts/test-gpu.mjs` runs it; the unit tests drive it
 * with plain values.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/** The package the WebGPU suites load Dawn from. */
export const GPU_PACKAGE = "@kmamal/gpu";

/**
 * Whether a test's source loads the GPU package: a dynamic `import("…")`, or a
 * static `import … from "…"`. A mention in a comment or a string isn't one.
 */
export function usesGpu(source) {
  const name = GPU_PACKAGE.replace(/[/.]/g, "\\$&");
  const dynamic = new RegExp(`\\bimport\\s*\\((?:\\s*/\\*[^]*?\\*/)?\\s*["'\`]${name}["'\`]\\s*\\)`);
  const fixed = new RegExp(`^\\s*import\\s[^;]*?\\bfrom\\s*["']${name}["']`, "m");
  return dynamic.test(source) || fixed.test(source);
}

/** Every `*.test.ts` under `dir`, depth first, as absolute paths. */
function testFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/**
 * The test files under `testsDir` that load the GPU package, relative to
 * `root` with forward slashes, sorted.
 */
export function gpuTestFiles(root, testsDir = "Unit Tests") {
  const base = resolve(root);
  return testFiles(resolve(base, testsDir))
    .filter((path) => usesGpu(readFileSync(path, "utf8")))
    .map((path) => relative(base, path).split(sep).join("/"))
    .sort();
}

/** Whether vitest's extra arguments split the run (`--shard`), so each run sees only some files. */
export function isSharded(args) {
  return args.some((arg) => arg === "--shard" || arg.startsWith("--shard="));
}

/**
 * What is wrong with a run, from vitest's JSON report: a failed or unrun test,
 * a file that failed outside its tests (an import, a top-level await), a file
 * with no tests, and (unless the run is sharded) a file that was asked for and
 * never reported. An empty list is a clean run.
 *
 * `expected` and the report's names are compared relative to `root`.
 */
export function reportProblems(report, { root, expected = [], sharded = false }) {
  const problems = [];
  const base = resolve(root);
  const name = (path) => relative(base, resolve(base, path)).split(sep).join("/");
  const results = Array.isArray(report?.testResults) ? report.testResults : [];

  if (results.length === 0 || !(report.numTotalTests > 0)) problems.push("no tests ran");

  const seen = new Set();
  for (const file of results) {
    const path = name(file.name);
    seen.add(path);
    const tests = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    if (file.status === "failed" && !tests.some((t) => t.status === "failed")) {
      const why = String(file.message ?? "").split("\n")[0];
      problems.push(`${path}: failed to run${why ? ` (${why})` : ""}`);
    }
    if (tests.length === 0) problems.push(`${path}: no tests`);
    for (const test of tests) {
      if (test.status === "passed") continue;
      const title = test.fullName || [...(test.ancestorTitles ?? []), test.title].join(" ");
      problems.push(`${path}: ${test.status}: ${title}`);
    }
  }

  if (!sharded) {
    for (const path of expected) if (!seen.has(name(path))) problems.push(`${name(path)}: not reported`);
  }
  return problems;
}

/**
 * Asks Dawn for an adapter and a device, and says which: on CI it is Mesa's
 * lavapipe, and the log should show that, not leave it to be guessed. Throws,
 * with what to install, when either is missing.
 */
export async function probeAdapter(load = () => import(GPU_PACKAGE)) {
  let module;
  try {
    module = await load();
  } catch (error) {
    throw new Error(`${GPU_PACKAGE} is not installed (npm i --no-save ${GPU_PACKAGE}@0.2.0): ${error?.message ?? error}`, { cause: error });
  }
  const gpu = (module.default ?? module).create([]);
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error("Dawn found no adapter (install a Vulkan driver; with no GPU, mesa-vulkan-drivers gives lavapipe)");
  const device = await adapter.requestDevice();
  if (!device) throw new Error("the adapter gave no device");
  const info = adapter.info ?? {};
  device.destroy?.();
  return [info.vendor, info.architecture, info.device, info.description].filter((part) => part).join(" ") || "an unnamed adapter";
}
