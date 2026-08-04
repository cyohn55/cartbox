/**
 * Unit tests for the cart-details normaliser (apps/web/src/lib/cartMeta.ts).
 *
 * Assertions come from the validator's contract — a blank title is rejected,
 * title/description are trimmed and length-capped, and tags are lower-cased,
 * de-duplicated, split from a comma string, and bounded in count and length —
 * all derived from the inputs and outputs, never from magic constants copied
 * into the test.
 *
 * Run: node --experimental-transform-types --import "./Unit Tests/registerTsHooks.mjs" "Unit Tests/cartMeta.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  pathToFileURL(path.resolve(here, "../apps/web/src/lib/cartMeta.ts")).href
);
const {
  resolveMetaUpdate,
  normalizeTags,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
} = mod;

let passed = 0;
const check = (label, condition) => {
  assert.ok(condition, label);
  passed += 1;
};

// 1. A blank or whitespace-only title is a malformed request.
{
  check("empty body rejected", "error" in resolveMetaUpdate(null));
  check("missing title rejected", "error" in resolveMetaUpdate({ description: "hi" }));
  check("blank title rejected", "error" in resolveMetaUpdate({ title: "   " }));
}

// 2. A valid title is trimmed and the description defaults to empty.
{
  const result = resolveMetaUpdate({ title: "  Neon City  " });
  check("title accepted", "meta" in result);
  check("title trimmed", result.meta.title === "Neon City");
  check("description defaults empty", result.meta.description === "");
  check("tags default empty", Array.isArray(result.meta.tags) && result.meta.tags.length === 0);
}

// 3. Over-long title and description are capped to their limits.
{
  const longTitle = "a".repeat(MAX_TITLE_LENGTH + 50);
  const longDesc = "b".repeat(MAX_DESCRIPTION_LENGTH + 50);
  const result = resolveMetaUpdate({ title: longTitle, description: longDesc });
  check("title capped", result.meta.title.length === MAX_TITLE_LENGTH);
  check("description capped", result.meta.description.length === MAX_DESCRIPTION_LENGTH);
}

// 4. Tags: lower-cased, trimmed, de-duplicated, order preserved.
{
  const tags = normalizeTags(["Action", " action ", "PLATFORMER", "action"]);
  check("dedup + lowercase", JSON.stringify(tags) === JSON.stringify(["action", "platformer"]));
}

// 5. Tags accept a comma-separated string (what a text input produces).
{
  const tags = normalizeTags("rpg, Puzzle ,,shooter");
  check("comma string split + cleaned", JSON.stringify(tags) === JSON.stringify(["rpg", "puzzle", "shooter"]));
}

// 6. Tag count and per-tag length are bounded.
{
  const many = Array.from({ length: MAX_TAGS + 10 }, (_, i) => `tag${i}`);
  check("tag count capped", normalizeTags(many).length === MAX_TAGS);
  const longTag = "z".repeat(MAX_TAG_LENGTH + 20);
  check("tag length capped", normalizeTags([longTag])[0].length === MAX_TAG_LENGTH);
}

// 7. Non-string junk in the tag list is skipped, not coerced.
{
  const tags = normalizeTags(["ok", 42, null, { x: 1 }, "fine"]);
  check("junk tags dropped", JSON.stringify(tags) === JSON.stringify(["ok", "fine"]));
}

// 8. A fully-specified body round-trips its normalised fields.
{
  const result = resolveMetaUpdate({
    title: "My Game",
    description: "A short blurb.",
    tags: ["Fun", "fun", "arcade"],
  });
  check("title", result.meta.title === "My Game");
  check("description", result.meta.description === "A short blurb.");
  check("tags", JSON.stringify(result.meta.tags) === JSON.stringify(["fun", "arcade"]));
}

console.log(`cartMeta: ${passed}/${passed} checks passed`);
