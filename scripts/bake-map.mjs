#!/usr/bin/env node
// Bake a map's light map, probes and kit maps (BEAVER_CREEK_ROADMAP.md B1):
//   npm run bake:map <id> [lightmap,probes,kit]
// Runs the map-bake vitest file with the map and parts in its environment.
import { spawnSync } from "node:child_process";

const [id, parts] = process.argv.slice(2);
if (!id) {
  console.error("usage: npm run bake:map <id> [lightmap,probes,kit]");
  process.exit(2);
}
const env = { ...process.env, BAKE_MAP: id, ...(parts ? { BAKE_PARTS: parts } : {}) };
const run = spawnSync("npx", ["vitest", "run", "Unit Tests/map-bake.test.ts"], { stdio: "inherit", env });
process.exit(run.status ?? 1);
