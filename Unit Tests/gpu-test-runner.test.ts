/**
 * The runner for the WebGPU suites (AAA_PRODUCTION_ROADMAP.md Q1,
 * `scripts/test-gpu.mjs`): it finds the suites by their import of
 * @kmamal/gpu, and a run passes only when every test in them passed — a skip
 * there means a shader went unchecked.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { gpuTestFiles, isSharded, probeAdapter, reportProblems, usesGpu } from "../scripts/lib/gpuTests.mjs";

/** Split so this file's fixtures don't read as an import of the package. */
const PKG = ["@kmamal", "gpu"].join("/");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("usesGpu", () => {
  it("sees the suites' dynamic import, with or without vite's comment", () => {
    expect(usesGpu(`const m = await import(/* @vite-ignore */ "${PKG}");`)).toBe(true);
    expect(usesGpu(`const m = await import('${PKG}');`)).toBe(true);
    expect(usesGpu(`await import(\n  /* @vite-ignore */\n  \`${PKG}\`\n)`)).toBe(true);
  });

  it("sees a static import", () => {
    expect(usesGpu(`import gpu from "${PKG}";`)).toBe(true);
    expect(usesGpu(`import {\n  create,\n} from "${PKG}";`)).toBe(true);
  });

  it("ignores a mention that isn't an import", () => {
    expect(usesGpu(" * npm i --no-save @kmamal/gpu@0.2.0")).toBe(false);
    expect(usesGpu(`const name = "${PKG}";`)).toBe(false);
    expect(usesGpu('await import("@kmamal/gpu-extra");')).toBe(false);
    expect(usesGpu('import x from "./gpu";')).toBe(false);
  });
});

describe("gpuTestFiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "cbx-gpu-files-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the test files that load the GPU, nested too, sorted and relative", () => {
    mkdirSync(join(dir, "Unit Tests", "nested"), { recursive: true });
    writeFileSync(join(dir, "Unit Tests", "b.test.ts"), `await import(/* @vite-ignore */ "${PKG}");`);
    writeFileSync(join(dir, "Unit Tests", "a.test.ts"), `import gpu from "${PKG}";`);
    writeFileSync(join(dir, "Unit Tests", "nested", "c.test.ts"), `await import("${PKG}");`);
    writeFileSync(join(dir, "Unit Tests", "plain.test.ts"), "// mentions @kmamal/gpu only here");
    writeFileSync(join(dir, "Unit Tests", "helper.ts"), `await import("${PKG}");`);
    expect(gpuTestFiles(dir)).toEqual(["Unit Tests/a.test.ts", "Unit Tests/b.test.ts", "Unit Tests/nested/c.test.ts"]);
  });

  it("finds this repository's suites, the parity suite among them", () => {
    const files = gpuTestFiles(repoRoot);
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("Unit Tests/webgpu-parity.test.ts");
    expect(files).not.toContain("Unit Tests/gpu-test-runner.test.ts");
  });
});

describe("reportProblems", () => {
  const root = "/repo";
  const file = (name: string, statuses: string[], extra: Record<string, unknown> = {}) => ({
    name: `/repo/Unit Tests/${name}`,
    status: statuses.includes("failed") ? "failed" : "passed",
    assertionResults: statuses.map((status, i) => ({ status, fullName: `${name} test ${i}` })),
    ...extra,
  });
  const report = (...files: ReturnType<typeof file>[]) => ({
    numTotalTests: files.reduce((n, f) => n + f.assertionResults.length, 0),
    testResults: files,
  });

  it("passes a clean run of every expected file", () => {
    const run = report(file("a.test.ts", ["passed", "passed"]), file("b.test.ts", ["passed"]));
    expect(reportProblems(run, { root, expected: ["Unit Tests/a.test.ts", "Unit Tests/b.test.ts"] })).toEqual([]);
  });

  it("fails a skip, a todo and a failure, naming each", () => {
    const run = report(file("a.test.ts", ["passed", "skipped", "todo"]), file("b.test.ts", ["failed"]));
    expect(reportProblems(run, { root })).toEqual([
      "Unit Tests/a.test.ts: skipped: a.test.ts test 1",
      "Unit Tests/a.test.ts: todo: a.test.ts test 2",
      "Unit Tests/b.test.ts: failed: b.test.ts test 0",
    ]);
  });

  it("fails a file that died before its tests, and one with none", () => {
    const run = report(file("a.test.ts", [], { status: "failed", message: "Cannot find module 'x'\n  at y" }), file("b.test.ts", ["passed"]));
    expect(reportProblems(run, { root })).toEqual([
      "Unit Tests/a.test.ts: failed to run (Cannot find module 'x')",
      "Unit Tests/a.test.ts: no tests",
    ]);
  });

  it("fails an expected file that never reported, unless the run is sharded", () => {
    const run = report(file("a.test.ts", ["passed"]));
    const expected = ["Unit Tests/a.test.ts", "Unit Tests/b.test.ts"];
    expect(reportProblems(run, { root, expected })).toEqual(["Unit Tests/b.test.ts: not reported"]);
    expect(reportProblems(run, { root, expected, sharded: true })).toEqual([]);
  });

  it("fails a run with no report, or no tests", () => {
    expect(reportProblems(null, { root })).toEqual(["no tests ran"]);
    expect(reportProblems({ numTotalTests: 0, testResults: [] }, { root })).toEqual(["no tests ran"]);
  });
});

describe("isSharded", () => {
  it("knows vitest's shard flag in both spellings", () => {
    expect(isSharded(["--shard=1/3"])).toBe(true);
    expect(isSharded(["--shard", "2/3"])).toBe(true);
    expect(isSharded(["--list", "--bail=1"])).toBe(false);
  });
});

describe("probeAdapter", () => {
  const gpu = (adapter: unknown) => async () => ({ create: () => ({ requestAdapter: async () => adapter }) });

  it("names the adapter it found", async () => {
    let destroyed = false;
    const adapter = {
      info: { vendor: "mesa", architecture: "", device: "llvmpipe (LLVM 17, 256 bits)", description: "" },
      requestDevice: async () => ({ destroy: () => (destroyed = true) }),
    };
    await expect(probeAdapter(gpu(adapter))).resolves.toBe("mesa llvmpipe (LLVM 17, 256 bits)");
    expect(destroyed).toBe(true);
  });

  it("says what to install when the package or the adapter is missing", async () => {
    await expect(
      probeAdapter(async () => {
        throw new Error("Cannot find package");
      }),
    ).rejects.toThrow(/npm i --no-save @kmamal\/gpu@0\.2\.0/);
    await expect(probeAdapter(gpu(null))).rejects.toThrow(/mesa-vulkan-drivers/);
  });
});
