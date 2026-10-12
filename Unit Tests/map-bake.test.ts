/**
 * The offline bake of a map (BEAVER_CREEK_ROADMAP.md B1): `npm run bake:map
 * <id> [parts]` runs this with BAKE_MAP=<id> (and BAKE_PARTS, comma-separated:
 * lightmap, probes, kit; all by default) and rewrites that map's generated
 * files. Skipped otherwise: a bake takes a while. map-bakes.test.ts checks
 * every map's stored bakes still fit.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MAP_BAKES, MAP_BAKE_PARTS, bakeMapKitSource, bakeMapLightmapSource, bakeMapProbesSource, type MapBakePart } from "@cartbox/editor";

const id = process.env.BAKE_MAP ?? "";
const parts = (process.env.BAKE_PARTS ? process.env.BAKE_PARTS.split(",") : MAP_BAKE_PARTS) as MapBakePart[];
const root = path.resolve(__dirname, "..");

describe.skipIf(!id)(`baking map "${id}"`, () => {
  it("bakes the parts asked for and stores them", () => {
    const map = MAP_BAKES[id];
    expect(map, `no map "${id}" (known: ${Object.keys(MAP_BAKES).join(", ")})`).toBeDefined();
    for (const part of parts) {
      expect(MAP_BAKE_PARTS, `unknown part "${part}"`).toContain(part);
      const started = Date.now();
      const source = part === "lightmap" ? bakeMapLightmapSource(id) : part === "probes" ? bakeMapProbesSource(id) : bakeMapKitSource(id);
      const file = map!.files[part];
      if (source === null || !file) {
        console.log(`${id}: no ${part} to bake`);
        continue;
      }
      writeFileSync(path.join(root, file.path), source);
      console.log(`${id}: baked ${part} in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${file.path}`);
    }
  }, 1_800_000);
});
