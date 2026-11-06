/**
 * Runs every WebGPU suite on a real device, and fails on anything but a pass
 * (AAA_PRODUCTION_ROADMAP.md Q1). The CI job runs it on Mesa's lavapipe; on a
 * machine with a GPU it runs there.
 *
 *   npm i --no-save @kmamal/gpu@0.2.0     (pin 0.2.0; see webgpu-parity.test.ts)
 *   npm run test:gpu                      every suite
 *   npm run test:gpu -- --list            just name them
 *   npm run test:gpu -- --shard=1/3       pass anything else on to vitest
 *   npm run test:gpu -- --maxWorkers=4    (two workers unless told; see GPU_WORKERS)
 *
 * Steps: ask Dawn for an adapter and print which (no adapter fails here, not
 * as 67 silent skips); find the suites by their import of @kmamal/gpu; run
 * them; then read vitest's JSON report and fail on any test that didn't pass,
 * a file that didn't run, or a file that ran no tests.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { gpuTestFiles, isSharded, probeAdapter, reportProblems, withWorkerCap } from "./lib/gpuTests.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const files = gpuTestFiles(root);

if (args.includes("--list")) {
  for (const file of files) console.log(file);
  process.exit(0);
}

if (files.length === 0) {
  console.error("test:gpu: no test loads @kmamal/gpu; nothing to run");
  process.exit(1);
}

try {
  console.log(`test:gpu: adapter: ${await probeAdapter()}`);
} catch (error) {
  console.error(`test:gpu: ${error.message}`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "cbx-gpu-"));
const reportPath = join(dir, "report.json");
console.log(`test:gpu: ${files.length} files`);

const run = spawnSync(
  "npx",
  // At most two workers (GPU_WORKERS): Dawn's binding can die natively when more drive lavapipe at once.
  ["vitest", "run", "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`, ...withWorkerCap(args), ...files],
  { cwd: root, stdio: "inherit" },
);

let report = null;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch {
  // A run that died before reporting is a failure; reportProblems says "no tests ran".
}
rmSync(dir, { recursive: true, force: true });

const problems = reportProblems(report, { root, expected: files, sharded: isSharded(args) });
if (problems.length > 0) {
  console.error(`\ntest:gpu: ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const problem of problems) console.error(`  ${problem}`);
}
process.exit(run.status !== 0 || problems.length > 0 ? 1 : 0);
