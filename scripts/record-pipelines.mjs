#!/usr/bin/env node
// Record a map's shipped pipeline manifest (AAA_PRODUCTION_ROADMAP.md M3, R5):
//   npm run record:pipelines <map>
// Draws the map as Lockout does on a real device (Dawn; lavapipe will do) and
// writes apps/web/public/pipelines/<map>.json, which the Lockout page fetches
// and the player warms behind the loading screen. Re-record when the renderer's
// shaders change; map-pipelines.test.ts fails while a manifest is stale.
import { spawnSync } from "node:child_process";

const [id] = process.argv.slice(2);
if (!id) {
  console.error("usage: npm run record:pipelines <map>");
  process.exit(2);
}
const run = spawnSync("npx", ["vitest", "run", "Unit Tests/map-pipelines.test.ts", "-t", "records"], { stdio: "inherit", env: { ...process.env, RECORD_PIPELINES: id } });
process.exit(run.status ?? 1);
