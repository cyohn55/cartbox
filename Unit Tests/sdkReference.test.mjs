/**
 * Integrity tests for the in-editor API reference data (apps/web/src/app/edit/
 * [cartId]/sdkReference.ts). The panel inserts these snippets verbatim, so the
 * data itself is the contract: every entry must be fully populated, names unique,
 * and the cartbox surface must actually cover the shipped SDK (so a newly added
 * SDK function can't silently go undocumented).
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/sdkReference.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { SDK_REFERENCE } = await import(
  pathToFileURL(path.resolve(here, "../apps/web/src/app/edit/[cartId]/sdkReference.ts")).href
);

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

const allEntries = SDK_REFERENCE.flatMap((group) => group.entries);

// 1. Every group is non-empty and titled.
check("groups present", SDK_REFERENCE.length > 0);
check("every group titled + non-empty", SDK_REFERENCE.every((g) => g.label.length > 0 && g.entries.length > 0));

// 2. Every entry is fully populated (the panel renders/inserts all four fields).
check(
  "every entry fully populated",
  allEntries.every((e) => e.name && e.signature && e.doc && e.snippet),
);

// 3. Entry names are unique (they key the React list and the insert menu).
{
  const names = allEntries.map((e) => e.name);
  check("entry names unique", new Set(names).size === names.length);
}

// 4. The cartbox surface documents exactly the shipped SDK functions — the whole
//    point of the panel is discoverability, so a gap here is a real regression.
{
  const cartboxDocumented = new Set(
    allEntries.map((e) => e.name).filter((n) => n.startsWith("cartbox.")).map((n) => n.slice("cartbox.".length)),
  );
  const shipped = ["solid", "mapsize", "flag", "clearlights", "light", "sun", "spot", "score", "unlock", "progress", "camera", "meshcam"];
  check(
    "every shipped cartbox.* is documented",
    shipped.every((fn) => cartboxDocumented.has(fn)),
  );
}

console.log(`sdkReference: ${passed}/${passed} checks passed`);
