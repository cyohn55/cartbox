/**
 * Unit tests for username (handle) validation (apps/web/src/lib/handle.ts).
 * Exercises normalization, each format rule, reserved names, and the boundary
 * lengths — all derived from the documented rules, no magic expectations.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/handle.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.resolve(here, "../apps/web/src/lib/handle.ts")).href);
const { normalizeHandle, handleError, isValidHandle, HANDLE_MIN, HANDLE_MAX } = mod;

let passed = 0;

// 1. Normalization lowercases and trims.
{
  assert.equal(normalizeHandle("  CoolMaker  "), "coolmaker");
  passed += 1;
}

// 2. A clean handle is valid.
{
  assert.equal(handleError("pixel_pete"), null);
  assert.ok(isValidHandle("pixel_pete"));
  assert.ok(isValidHandle("a1b"));
  passed += 1;
}

// 3. Length boundaries derived from the exported limits.
{
  assert.ok(isValidHandle("a".repeat(HANDLE_MIN)), "min length is valid");
  assert.ok(!isValidHandle("a".repeat(HANDLE_MIN - 1)), "below min is invalid");
  assert.ok(isValidHandle("a".repeat(HANDLE_MAX)), "max length is valid");
  assert.ok(!isValidHandle("a".repeat(HANDLE_MAX + 1)), "above max is invalid");
  passed += 1;
}

// 4. Character/shape rules.
{
  assert.ok(!isValidHandle("1abc"), "must start with a letter");
  assert.ok(!isValidHandle("has space"), "no spaces");
  assert.ok(!isValidHandle("has-dash"), "no dashes");
  assert.ok(!isValidHandle("emoji😀x"), "no non-ascii");
  passed += 1;
}

// 5. Reserved route names are rejected.
{
  for (const reserved of ["admin", "api", "profile", "onboarding", "login"]) {
    assert.ok(!isValidHandle(reserved), `${reserved} is reserved`);
  }
  passed += 1;
}

console.log(`PASS — handle: ${passed} checks green.`);
