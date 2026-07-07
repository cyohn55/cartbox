#!/usr/bin/env node
/**
 * Regenerates the demo cart binaries under public/demo/carts/.
 *
 * The static "demo" build (src/lib/staticSite.ts) has no database or object
 * storage, so the carts that scripts/seed*.mjs would normally upload are baked
 * into the site as static assets instead. The catalog rows live in
 * src/lib/demoCatalog.ts and must stay in sync with the ids written here.
 *
 * Two carts are built from Lua source (mirroring scripts/seed.mjs); the rest
 * are copied from their authored .tic files. The authored game carts live in
 * sibling folders outside this repository, so missing sources are skipped with
 * a warning — the committed copies under public/demo/carts/ remain in use.
 *
 * Run from apps/web: node scripts/bake-demo-carts.mjs
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webAppRoot = dirname(fileURLToPath(new URL("./", import.meta.url)));
const monorepoRoot = join(webAppRoot, "..", "..");
const outputDir = join(webAppRoot, "public", "demo", "carts");

// Resolve sibling packages against this module's URL directly (same pattern as
// scripts/seed.mjs) so spaces in the repo path survive the import.
const { buildLuaCart } = await import(
  new URL("../../../packages/engine/examples/sample-cart.mjs", import.meta.url).href
);
const { injectSdk } = await import(
  new URL("../../../packages/player/dist/index.js", import.meta.url).href
);

// Lua sources mirrored from scripts/seed.mjs so the static demo ships the same
// carts the local stack seeds.
const RING_RUNNER_SOURCE = [
  "s=0",
  "function TIC()",
  " cls(1)",
  " if btn(3) then s=s+1 end",
  " for i=0,40 do circ(120,68,(40-i+s)%44,i%15) end",
  ' print("hold right",70,120,15)',
  " cartbox.score(s)",
  ' if s>=30 then cartbox.unlock("first_blood") end',
  "end",
].join("\n");

const LANTERN_SOURCE = [
  "x=120 y=68",
  "function TIC()",
  " if btn(2) then x=x-2 end",
  " if btn(3) then x=x+2 end",
  " if btn(0) then y=y-2 end",
  " if btn(1) then y=y+2 end",
  " if x<8 then x=8 end",
  " if x>232 then x=232 end",
  " if y<12 then y=12 end",
  " if y>128 then y=128 end",
  " cls(0)",
  " for j=1,15 do for i=1,29 do pix(i*8,j*8,3) end end",
  " rect(0,0,240,8,2)",
  " rect(0,128,240,8,2)",
  " circ(x,y,4,14)",
  " circ(x,y,2,15)",
  ' print("LANTERN - arrows to move",54,2,13)',
  " cartbox.clearlights()",
  " cartbox.light(x,y,72,255,190,110,12,1.4)",
  "end",
].join("\n");

/** Carts synthesised from Lua source, keyed by their seeded cart id. */
const builtCarts = [
  { id: "00000000-0000-4000-8000-000000000001", source: RING_RUNNER_SOURCE },
  { id: "00000000-0000-4000-8000-000000000002", source: LANTERN_SOURCE },
];

/** Carts copied from authored .tic files, keyed by their seeded cart id. */
const copiedCarts = [
  {
    id: "00000000-0000-4000-8000-000000000010",
    sourcePath: join(monorepoRoot, "packages", "player", "examples", "neon-city.tic"),
  },
  {
    id: "00000000-0000-4000-8000-000000000011",
    sourcePath: join(monorepoRoot, "..", "gotta-catch-em-all", "game.tic"),
  },
  {
    id: "00000000-0000-4000-8000-000000000012",
    sourcePath: join(monorepoRoot, "..", "gotta-catch-pro", "game-pro.tic"),
  },
];

mkdirSync(outputDir, { recursive: true });

for (const { id, source } of builtCarts) {
  const bytes = injectSdk(buildLuaCart(source));
  writeFileSync(join(outputDir, `${id}.tic`), bytes);
  console.log(`built ${id}.tic (${bytes.byteLength} bytes)`);
}

for (const { id, sourcePath } of copiedCarts) {
  if (!existsSync(sourcePath)) {
    console.warn(`skipped ${id}.tic — source not found: ${sourcePath}`);
    continue;
  }
  copyFileSync(sourcePath, join(outputDir, `${id}.tic`));
  console.log(`copied ${id}.tic from ${sourcePath}`);
}
